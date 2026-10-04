package bybit

import (
	"context"
	"log/slog"
	"time"

	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

// TickerFeed serves the all-market 24h ticker from REST. Bybit's v5 public
// WebSocket has no all-market ticker topic (tickers.{symbol} is per-symbol
// only, and subscribing to every symbol is hundreds of topics), so the
// watchlist refreshes from /v5/market/tickers on a 30s cadence. Honest
// trade-off: prices move every 30s rather than live, and nothing pretends
// otherwise.
type TickerFeed struct {
	log  *slog.Logger
	emit func(*pb.Ticker24HUpdate)
}

// tickerPollInterval is how often the REST poll refreshes. The watchlist
// shows last price and 24h change, neither of which needs sub-minute
// freshness. A var so a test does not have to wait 30 seconds.
var tickerPollInterval = 30 * time.Second

// NewTickerFeed creates the global ticker feed.
func NewTickerFeed(log *slog.Logger, emit func(*pb.Ticker24HUpdate)) *TickerFeed {
	return &TickerFeed{log: log.With("feed", "ticker24h"), emit: emit}
}

// Run blocks until ctx is cancelled.
func (t *TickerFeed) Run(ctx context.Context) {
	tick := time.NewTicker(tickerPollInterval)
	defer tick.Stop()
	// The startup poll fires immediately rather than after a tick, which
	// fills the watchlist as soon as the venue answers.
	for {
		t.pollOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (t *TickerFeed) pollOnce(ctx context.Context) {
	pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	arr, err := Tickers(pctx)
	if err != nil {
		if ctx.Err() == nil {
			t.log.Debug("bybit 24h ticker poll failed", "err", err)
		}
		return
	}
	if len(arr) == 0 {
		return
	}
	out := &pb.Ticker24HUpdate{
		Entries:     make([]*pb.Ticker24HEntry, 0, len(arr)),
		TimestampMs: time.Now().UnixMilli(),
	}
	for i := range arr {
		e := &arr[i]
		out.Entries = append(out.Entries, &pb.Ticker24HEntry{
			// The terminal expects the native UPPERCASE symbol form here,
			// same as the Binance venue.
			Symbol:    e.Symbol,
			LastPrice: parseF(e.LastPrice),
			// price24hPcnt is a ratio ("0.0152" = +1.52%); the terminal
			// renders ChangePct raw as a percentage, so scale it.
			ChangePct:   parseF(e.Price24hPcnt) * 100,
			VolumeQuote: parseF(e.Turnover24h),
			EventTimeMs: out.TimestampMs,
		})
	}
	t.emit(out)
}
