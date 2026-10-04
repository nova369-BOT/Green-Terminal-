package bybit

import (
	"context"
	"log/slog"
	"time"

	"github.com/edgedepthhq/edgedepth-gateway/internal/candle"
	"github.com/edgedepthhq/edgedepth-gateway/internal/exchange"
	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

// Bybit is the exchange.Exchange adapter for Bybit linear (USDT/USDC)
// perpetuals on the v5 public API. Transport in stream.go, JSON shapes and
// the orderbook procedure in feed.go, REST in rest.go.
//
// Everything the terminal subscribes to is real here: trades (with the
// venue's own taker-side flag), a sequenced 500-level book, liquidations
// from allLiquidation, mark/funding/open-interest stats, REST historical
// candles and a REST-polled all-market 24h ticker (Bybit has no all-market
// ticker stream, so the watchlist refreshes every 30s on this venue).
type Bybit struct {
	log *slog.Logger
}

// New creates the adapter.
func New(log *slog.Logger) *Bybit {
	return &Bybit{log: log}
}

// ID is "bybit" because that is the venue string the terminal uses for
// Bybit linear perpetuals. It must match the client side exactly.
func (b *Bybit) ID() string { return "bybit" }

// Symbols returns the instruments-info whitelist, lowercased to match the
// terminal's bybit symbol form.
func (b *Bybit) Symbols(ctx context.Context) (map[string]bool, error) {
	return ExchangeSymbols(ctx)
}

// NewFeed creates the per-symbol feed.
func (b *Bybit) NewFeed(symbol string, emit exchange.Emit) exchange.Feed {
	return NewFeed(symbol, b.log, emit)
}

// GlobalTicker polls the all-market tickers endpoint; Bybit has no
// all-market ticker stream.
func (b *Bybit) GlobalTicker(emit exchange.Emit) exchange.Runner {
	return NewTickerFeed(b.log, func(u *pb.Ticker24HUpdate) {
		emit(pb.Stream_STREAM_TICKER24H, 0, u.TimestampMs, u)
	})
}

// HistoricalCandles serves REST klines for 1m and up. Sub-minute timeframes
// have no REST source on Bybit and legitimately start empty, filling from
// live trades.
func (b *Bybit) HistoricalCandles(ctx context.Context, symbol string, tfSec int64, count int, endTimeMs int64) ([]*pb.Candle, error) {
	if candle.SubMinute(tfSec) {
		return nil, exchange.ErrUnsupported
	}
	kl, err := Klines(ctx, symbol, tfSec, count, endTimeMs)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	out := make([]*pb.Candle, 0, len(kl))
	for i := range kl {
		k := &kl[i]
		out = append(out, &pb.Candle{
			Open:   k.Open,
			High:   k.High,
			Low:    k.Low,
			Close:  k.Close,
			Volume: k.Volume,
			// Bybit history carries total volume only, no taker buy/sell
			// split: delta stays unknown until live trades arrive and the
			// aggregator takes over. Same honest gap as Hyperliquid; the
			// flag tells the terminal these zeros mean UNKNOWN.
			Vbuy:                  0,
			Vsell:                 0,
			TradeStatsUnavailable: true,
			TimestampMs:           k.StartTime,
			Timeframe:             tfSec,
			// The final candle is still forming unless its window closed.
			Final: k.StartTime+tfSec*1000 <= now,
		})
	}
	return out, nil
}
