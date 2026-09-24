package hyperliquid

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/edgedepthhq/edgedepth-gateway/internal/exchange"
	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

// Emit hands a decoded market message to the hub. timeframe is 0 for
// non-timeframed streams.
type Emit = exchange.Emit

// maxSeedLevels caps each side of the REST-seeded book. The live book frames
// are top-of-book snapshots; the seed gives the DOM ladder its initial depth.
const maxSeedLevels = 1000

// Feed owns every upstream Hyperliquid stream for one coin and turns them
// into EdgeDepth protobuf messages.
//
// Hyperliquid pushes full orderbook snapshots rather than diffs, so there is
// no sequence to maintain: every book frame replaces the book, and a client
// that connects ten minutes in is complete from the first message.
//
// Hyperliquid publishes no public liquidation feed, so this feed emits no
// STREAM_LIQUIDATIONS. Trades, book, mark/funding/open-interest, historical
// candles and the 24h ticker are all real; the liquidation timeline simply
// has no source on this venue and stays empty rather than showing guesses.
type Feed struct {
	Coin string // UPPERCASE native, e.g. "BTC"

	emit Emit
	log  *slog.Logger

	mu            sync.RWMutex
	bids          []*pb.BookLevel
	asks          []*pb.BookLevel
	bookTime      int64
	hasBook       bool
	lastTrade     float64
	tradeCount    int64
	lastTradeID   int64
	lastTradeTime int64
	tradeReset    func(int64)

	markPrice   float64
	funding     float64
	nextFunding int64
	openInt     float64
}

// wsTrade is one public trade. Side is "B" for a buy and "A" for a sell.
type wsTrade struct {
	Coin string `json:"coin"`
	Side string `json:"side"`
	Px   string `json:"px"`
	Sz   string `json:"sz"`
	Time int64  `json:"time"`
	Hash string `json:"hash"`
	Tid  int64  `json:"tid"`
}

// wsBook is a full orderbook snapshot. Levels[0] is bids (best first),
// Levels[1] is asks (best first).
type wsBook struct {
	Coin   string       `json:"coin"`
	Time   int64        `json:"time"`
	Levels [2][]WsLevel `json:"levels"`
}

// wsActiveCtx is the live per-coin context: mark, mid, open interest and the
// rolling daily notional volume.
type wsActiveCtx struct {
	Coin string `json:"coin"`
	Ctx  struct {
		MarkPx       string `json:"markPx"`
		MidPx        string `json:"midPx"`
		OraclePx     string `json:"oraclePx"`
		OpenInterest string `json:"openInterest"`
		DayNtlVlm    string `json:"dayNtlVlm"`
		Funding      string `json:"funding"`
	} `json:"ctx"`
}

// NewFeed creates a feed. Call Run to start it.
func NewFeed(symbol string, log *slog.Logger, emit Emit) *Feed {
	return &Feed{
		Coin: upper(symbol),
		emit: emit,
		log:  log.With("symbol", upper(symbol)),
	}
}

func (f *Feed) SetTradeReset(reset func(int64)) { f.tradeReset = reset }

// Run connects the upstream streams and blocks until ctx is cancelled.
func (f *Feed) Run(ctx context.Context) {
	coin := f.Coin
	go f.seedBook(ctx)
	s := NewStream([]Subscription{
		{Type: "trades", Coin: coin},
		{Type: "l2Book", Coin: coin},
		{Type: "activeAssetCtx", Coin: coin},
	}, f.log, f.onMessage, func() {
		f.mu.Lock()
		f.lastTradeID = 0
		f.lastTradeTime = 0
		f.mu.Unlock()
		if f.tradeReset != nil {
			f.tradeReset(time.Now().UnixMilli())
		}
	})
	go f.pollREST(ctx)
	go f.warnIfNoTrades(ctx)
	s.Run(ctx)
}

func (f *Feed) onMessage(channel string, data json.RawMessage) {
	switch channel {
	case "trades":
		f.onTrades(data)
	case "l2Book":
		f.onBook(data)
	case "activeAssetCtx":
		f.onCtx(data)
	}
}

func (f *Feed) onTrades(raw json.RawMessage) {
	var arr []wsTrade
	if err := json.Unmarshal(raw, &arr); err != nil {
		// Never swallow this. A silent return here is how a wire-shape
		// change turns into an empty panel with no explanation.
		f.log.Warn("unparsable hl trades payload", "err", err)
		return
	}
	for i := range arr {
		t := &arr[i]
		price := parseF(t.Px)
		qty := parseF(t.Sz)
		if price <= 0 || qty <= 0 || math.IsNaN(price) || math.IsNaN(qty) ||
			math.IsInf(price, 0) || math.IsInf(qty, 0) || t.Time <= 0 {
			continue
		}
		f.mu.Lock()
		// Skip an exact redelivery, nothing more: trade ids are unique but
		// not a per-coin sequence, so only time ordering signals a gap.
		if t.Tid != 0 && t.Tid == f.lastTradeID {
			f.mu.Unlock()
			continue
		}
		gap := t.Time < f.lastTradeTime
		f.lastTradeID = t.Tid
		f.lastTradeTime = t.Time
		f.lastTrade = price
		f.tradeCount++
		f.mu.Unlock()
		if gap && f.tradeReset != nil {
			f.tradeReset(time.Now().UnixMilli())
			f.log.Warn("trade timestamp went backwards; discarding partial volume minute")
		}
		f.emit(pb.Stream_STREAM_TRADES, 0, t.Time, &pb.Trade{
			Price:       price,
			Qty:         qty,
			IsBuy:       t.Side == "B",
			TimestampMs: t.Time,
		})
	}
}

func (f *Feed) onBook(raw json.RawMessage) {
	var b wsBook
	if err := json.Unmarshal(raw, &b); err != nil {
		// Never swallow this. A silent return here is how a wire-shape
		// change turns into an empty panel with no explanation.
		f.log.Warn("unparsable hl book payload", "err", err)
		return
	}
	if b.Coin != "" && b.Coin != f.Coin {
		return
	}
	ts := b.Time
	if ts <= 0 {
		ts = time.Now().UnixMilli()
	}
	bids := make([]*pb.BookLevel, 0, len(b.Levels[0]))
	for _, l := range b.Levels[0] {
		if p, s := parseF(l.Px), parseF(l.Sz); p > 0 && s > 0 {
			bids = append(bids, &pb.BookLevel{Price: p, Size: s})
		}
	}
	asks := make([]*pb.BookLevel, 0, len(b.Levels[1]))
	for _, l := range b.Levels[1] {
		if p, s := parseF(l.Px), parseF(l.Sz); p > 0 && s > 0 {
			asks = append(asks, &pb.BookLevel{Price: p, Size: s})
		}
	}
	if len(bids) == 0 && len(asks) == 0 {
		return
	}
	f.mu.Lock()
	f.bids = bids
	f.asks = asks
	f.bookTime = ts
	f.hasBook = true
	last := f.lastTrade
	f.mu.Unlock()

	// Every frame is a full snapshot, so the book can never desync: there
	// are no diffs to miss and no resync procedure to run.
	f.emit(pb.Stream_STREAM_ORDERBOOK, 0, ts, &pb.BookUpdate{
		TimestampMs: ts,
		Asks:        asks,
		Bids:        bids,
		Snapshot:    true,
		LastPrice:   last,
	})
}

func (f *Feed) onCtx(raw json.RawMessage) {
	var m wsActiveCtx
	if err := json.Unmarshal(raw, &m); err != nil {
		// Never swallow this. A silent return here is how a wire-shape
		// change turns into an empty panel with no explanation.
		f.log.Warn("unparsable hl assetCtx payload", "err", err)
		return
	}
	if m.Coin != "" && m.Coin != f.Coin {
		return
	}
	f.mu.Lock()
	if mark := parseF(m.Ctx.MarkPx); mark > 0 {
		f.markPrice = mark
	} else if mid := parseF(m.Ctx.MidPx); f.markPrice == 0 && mid > 0 {
		f.markPrice = mid
	}
	if oi := parseF(m.Ctx.OpenInterest); oi > 0 {
		f.openInt = oi
	}
	if funding := parseF(m.Ctx.Funding); funding != 0 {
		f.funding = funding
	}
	f.mu.Unlock()
}

// MarkState is the latest funding/mark/OI snapshot, for the stats aggregator.
func (f *Feed) MarkState() (mark, funding, oi float64, nextFunding int64) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.markPrice, f.funding, f.openInt, f.nextFunding
}

// LastTrade returns the most recent traded price, used to stamp BookUpdate.
func (f *Feed) LastTrade() float64 {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.lastTrade
}

// seedBook pulls one deep REST snapshot so the DOM ladder has depth before
// the first live frame lands. If the live stream beats it, the live book
// wins and the seed is dropped.
func (f *Feed) seedBook(ctx context.Context) {
	snapCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	snap, err := L2Book(snapCtx, f.Coin)
	if err != nil {
		f.log.Debug("hl depth snapshot failed; live book will seed from WS", "err", err)
		return
	}
	ts := snap.Time
	if ts <= 0 {
		ts = time.Now().UnixMilli()
	}
	bids := make([]*pb.BookLevel, 0, len(snap.Levels[0]))
	for _, l := range snap.Levels[0] {
		if len(bids) >= maxSeedLevels {
			break
		}
		if p, s := parseF(l.Px), parseF(l.Sz); p > 0 && s > 0 {
			bids = append(bids, &pb.BookLevel{Price: p, Size: s})
		}
	}
	asks := make([]*pb.BookLevel, 0, len(snap.Levels[1]))
	for _, l := range snap.Levels[1] {
		if len(asks) >= maxSeedLevels {
			break
		}
		if p, s := parseF(l.Px), parseF(l.Sz); p > 0 && s > 0 {
			asks = append(asks, &pb.BookLevel{Price: p, Size: s})
		}
	}
	if len(bids) == 0 && len(asks) == 0 {
		return
	}
	f.mu.Lock()
	if f.hasBook {
		f.mu.Unlock()
		return
	}
	f.bids = bids
	f.asks = asks
	f.bookTime = ts
	f.hasBook = true
	last := f.lastTrade
	f.mu.Unlock()

	f.log.Info("orderbook seeded from REST", "levels", len(bids)+len(asks))
	f.emit(pb.Stream_STREAM_ORDERBOOK, 0, ts, &pb.BookUpdate{
		TimestampMs: ts,
		Asks:        asks,
		Bids:        bids,
		Snapshot:    true,
		LastPrice:   last,
	})
}

// pollREST refreshes funding on a slow cadence and fills in mark price and
// open interest while their stream is silent. Funding settles hourly, so 30s
// costs nothing and keeps the stats panel populated on every network.
func (f *Feed) pollREST(ctx context.Context) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		f.pollOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (f *Feed) pollOnce(ctx context.Context) {
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	universe, ctxs, err := MetaAndAssetCtxs(pctx)
	if err != nil {
		f.log.Debug("hl asset ctx poll failed", "err", err)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextFunding = NextFundingMs(time.Now().UnixMilli())
	for i, u := range universe {
		if u.Name != f.Coin || i >= len(ctxs) {
			continue
		}
		c := &ctxs[i]
		f.funding = parseF(c.Funding)
		// The WebSocket context, when it works, is fresher than a 30s poll,
		// so only fill in what is still missing.
		if f.markPrice == 0 {
			f.markPrice = parseF(c.MarkPx)
		}
		if f.openInt == 0 {
			f.openInt = parseF(c.OpenInterest)
		}
		return
	}
}

// warnIfNoTrades flags the case where the book is updating but the tape is
// not. That combination means the trade stream specifically is unreachable,
// which is otherwise invisible: the chart just never ticks.
func (f *Feed) warnIfNoTrades(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(30 * time.Second):
	}
	f.mu.RLock()
	trades, book := f.tradeCount, f.hasBook
	f.mu.RUnlock()
	if trades == 0 && book {
		f.log.Warn("orderbook is live but no trades received in 30s: " +
			"the trade subscription may be unreachable from this network")
	}
}

// Snapshot returns the current book as a snapshot BookUpdate, or nil if no
// book frame has landed yet. Used to prime a newly subscribed client.
func (f *Feed) Snapshot() *pb.BookUpdate {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if !f.hasBook {
		return nil
	}
	return &pb.BookUpdate{
		TimestampMs:  f.bookTime,
		Asks:         f.asks,
		Bids:         f.bids,
		Snapshot:     true,
		LastPrice:    f.lastTrade,
		LastUpdateId: f.bookTime,
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

func parseF(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

func upper(s string) string { return strings.ToUpper(s) }
