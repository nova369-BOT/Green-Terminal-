package hyperliquid

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

// TickerFeed serves the all-market 24h ticker by merging two sources: the
// live allMids stream (every coin's mid price) and the metaAndAssetCtxs REST
// poll (24h change, notional volume, mark fallback). Prices stay live while
// the socket works; the slower-moving stats refresh every 30s.
type TickerFeed struct {
	log  *slog.Logger
	emit func(*pb.Ticker24HUpdate)

	// frames counts stream pushes, so the REST fallback can tell "the socket
	// is working" from "the socket connected and delivered nothing".
	frames atomic.Int64

	mu     sync.RWMutex
	mids   map[string]float64
	names  []string
	change map[string]float64
	vol    map[string]float64
	mark   map[string]float64
}

// tickerPollInterval is how often the REST side refreshes. The watchlist
// shows last price live from the stream; change and volume move slowly enough
// that 30s is plenty. A var so a test does not have to wait 30 seconds.
var tickerPollInterval = 30 * time.Second

// NewTickerFeed creates the global ticker feed.
func NewTickerFeed(log *slog.Logger, emit func(*pb.Ticker24HUpdate)) *TickerFeed {
	return &TickerFeed{log: log.With("feed", "ticker24h"), emit: emit}
}

// Run blocks until ctx is cancelled.
func (t *TickerFeed) Run(ctx context.Context) {
	go t.pollREST(ctx)
	s := NewStream([]Subscription{{Type: "allMids"}}, t.log, func(channel string, data json.RawMessage) {
		if channel != "allMids" {
			return
		}
		t.onMids(data)
	}, nil)
	s.Run(ctx)
}

func (t *TickerFeed) onMids(raw json.RawMessage) {
	var msg struct {
		Mids map[string]string `json:"mids"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || len(msg.Mids) == 0 {
		return
	}
	t.frames.Add(1)
	t.mu.Lock()
	if t.mids == nil {
		t.mids = make(map[string]float64, len(msg.Mids))
	}
	for coin, px := range msg.Mids {
		if p := parseF(px); p > 0 {
			t.mids[coin] = p
		}
	}
	t.mu.Unlock()
	t.publish()
}

// pollREST serves the slower-moving ticker stats and keeps the whole ticker
// alive while the stream is silent. The startup poll fires immediately rather
// than after a tick, which fills the watchlist slightly before the socket
// finishes connecting on every network.
func (t *TickerFeed) pollREST(ctx context.Context) {
	tick := time.NewTicker(tickerPollInterval)
	defer tick.Stop()

	for n := 0; ; n++ {
		t.pollOnce(ctx, n)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (t *TickerFeed) pollOnce(ctx context.Context, n int) {
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	universe, ctxs, err := MetaAndAssetCtxs(pctx)
	if err != nil {
		if ctx.Err() == nil {
			t.log.Debug("hl 24h ticker poll failed", "err", err)
		}
		return
	}
	if len(universe) == 0 {
		return
	}
	t.mu.Lock()
	t.names = t.names[:0]
	if t.change == nil {
		t.change = make(map[string]float64)
		t.vol = make(map[string]float64)
		t.mark = make(map[string]float64)
	}
	for i, u := range universe {
		if i >= len(ctxs) {
			break
		}
		c := &ctxs[i]
		mark := parseF(c.MarkPx)
		prev := parseF(c.PrevDayPx)
		t.names = append(t.names, u.Name)
		t.mark[u.Name] = mark
		if prev > 0 && mark > 0 {
			t.change[u.Name] = (mark - prev) / prev * 100
		} else {
			t.change[u.Name] = 0
		}
		t.vol[u.Name] = parseF(c.DayNtlVlm)
	}
	t.mu.Unlock()
	// The startup poll beats the socket to the punch on a healthy network
	// too, so it proves nothing. A second silent round does, and that is
	// worth telling the operator about.
	if n == 1 && t.frames.Load() == 0 {
		t.log.Warn("no allMids frames after 30s, serving the 24h ticker " +
			"from REST instead; watchlist prices will refresh every 30s " +
			"rather than live")
	}
	t.publish()
}

func (t *TickerFeed) publish() {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if len(t.names) == 0 {
		return
	}
	out := &pb.Ticker24HUpdate{
		Entries:     make([]*pb.Ticker24HEntry, 0, len(t.names)),
		TimestampMs: time.Now().UnixMilli(),
	}
	for _, coin := range t.names {
		px := t.mark[coin]
		if live, ok := t.mids[coin]; ok && live > 0 {
			px = live
		}
		out.Entries = append(out.Entries, &pb.Ticker24HEntry{
			// The terminal expects the native UPPERCASE coin form here.
			Symbol:      coin,
			LastPrice:   px,
			ChangePct:   t.change[coin],
			VolumeQuote: t.vol[coin],
			EventTimeMs: out.TimestampMs,
		})
	}
	t.emit(out)
}
