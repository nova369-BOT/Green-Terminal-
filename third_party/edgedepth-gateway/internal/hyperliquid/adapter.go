package hyperliquid

import (
	"context"
	"log/slog"
	"time"

	"github.com/edgedepthhq/edgedepth-gateway/internal/candle"
	"github.com/edgedepthhq/edgedepth-gateway/internal/exchange"
	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

// Hyperliquid is the exchange.Exchange adapter for Hyperliquid perpetuals. It
// mirrors the Binance venue stream for stream: trades, full-snapshot
// orderbook, mark/funding/open-interest stats, REST historical candles and
// the all-market 24h ticker.
//
// The one deliberate gap is liquidations: Hyperliquid publishes no public
// liquidation feed, so STREAM_LIQUIDATIONS is never emitted here. The
// liquidation timeline stays empty on hl symbols rather than showing guesses.
type Hyperliquid struct {
	log *slog.Logger
}

// New creates the adapter.
func New(log *slog.Logger) *Hyperliquid {
	return &Hyperliquid{log: log}
}

// ID is "hl" because that is the venue string the terminal uses for
// Hyperliquid. It predates this gateway and cannot change here.
func (h *Hyperliquid) ID() string { return "hl" }

// Symbols returns the perp universe whitelist.
func (h *Hyperliquid) Symbols(ctx context.Context) (map[string]bool, error) {
	return ExchangeSymbols(ctx)
}

// NewFeed creates the per-symbol feed.
func (h *Hyperliquid) NewFeed(symbol string, emit exchange.Emit) exchange.Feed {
	return NewFeed(symbol, h.log, emit)
}

// GlobalTicker merges the live allMids stream with the 24h stats poll.
func (h *Hyperliquid) GlobalTicker(emit exchange.Emit) exchange.Runner {
	return NewTickerFeed(h.log, func(u *pb.Ticker24HUpdate) {
		emit(pb.Stream_STREAM_TICKER24H, 0, u.TimestampMs, u)
	})
}

// HistoricalCandles serves REST candles for 1m and up. Sub-minute timeframes
// have no REST source on Hyperliquid and legitimately start empty, filling
// from live trades.
func (h *Hyperliquid) HistoricalCandles(ctx context.Context, symbol string, tfSec int64, count int, endTimeMs int64) ([]*pb.Candle, error) {
	if candle.SubMinute(tfSec) {
		return nil, exchange.ErrUnsupported
	}
	hl, err := Candles(ctx, upper(symbol), tfSec, count, endTimeMs)
	if err != nil {
		return nil, err
	}
	out := make([]*pb.Candle, 0, len(hl))
	for i := range hl {
		k := &hl[i]
		out = append(out, &pb.Candle{
			Open:   parseF(k.Open),
			High:   parseF(k.High),
			Low:    parseF(k.Low),
			Close:  parseF(k.Close),
			Volume: parseF(k.Volume),
			// Hyperliquid history carries total volume only, no buy/sell
			// split: delta stays unknown until live trades arrive and the
			// aggregator takes over.
			Vbuy:  0,
			Vsell: 0,
			// t is the OPEN time, matching what the terminal expects.
			TimestampMs: k.OpenTime,
			Timeframe:   tfSec,
			// The final candle is still forming unless its close time has passed.
			Final: k.CloseTime < time.Now().UnixMilli(),
		})
	}
	return out, nil
}
