package bybit

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/edgedepthhq/edgedepth-gateway/internal/exchange"
	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

// Emit hands a decoded market message to the hub. timeframe is 0 for
// non-timeframed streams.
type Emit = exchange.Emit

// maxSeedLevels caps each side of the REST-seeded book. The streamed book is
// 500 levels; the seed gives the DOM ladder its initial depth a beat sooner.
const maxSeedLevels = 1000

// depthTopicLevels selects the streamed orderbook depth. 500 is the deepest
// linear stream (100ms cadence), matching what the DOM ladder wants.
const depthTopicLevels = "500"

// Feed owns every upstream Bybit stream for one symbol and turns them into
// EdgeDepth protobuf messages.
//
// Bybit's book stream opens with a full snapshot and then pushes deltas
// whose update id "u" must advance by exactly 1. There is no REST replay
// procedure for the streamed depth (the REST book's ids belong to a
// different feed), so on a gap the ONLY correct recovery is a fresh
// subscription: the depth stream reconnects and the new snapshot resyncs
// the book.
type Feed struct {
	Symbol string // lowercase client form, e.g. "btcusdt"
	Native string // UPPERCASE venue form, e.g. "BTCUSDT"

	emit Emit
	log  *slog.Logger

	depth *Stream // retained so a sequence gap can force a reconnect

	mu            sync.RWMutex
	bids          map[float64]float64
	asks          map[float64]float64
	lastU         int64
	synced        bool
	seedBids      []*pb.BookLevel // REST seed, display-only until the WS snapshot
	seedAsks      []*pb.BookLevel
	seedTime      int64
	lastTrade     float64
	tradeCount    int64
	lastTradeID   string // Bybit trade ids are UUIDs, not a sequence
	lastTradeTime int64
	tradeReset    func(int64)

	markPrice   float64
	funding     float64
	nextFunding int64
	openInt     float64
}

// wsTrade is one public trade. S is the TAKER side: "Buy" means the
// aggressor bought.
type wsTrade struct {
	Time    int64  `json:"T"`
	Symbol  string `json:"s"`
	Side    string `json:"S"`
	Size    string `json:"v"`
	Price   string `json:"p"`
	TradeID string `json:"i"`
	Block   bool   `json:"BT"`
}

// wsBook is a book snapshot or delta: price/size pairs, with size "0"
// removing the level, plus the update id the continuity check rides on.
type wsBook struct {
	Symbol string     `json:"s"`
	Bids   [][]string `json:"b"`
	Asks   [][]string `json:"a"`
	U      int64      `json:"u"`
	Seq    int64      `json:"seq"`
}

// wsTicker carries the stats trio. Delta frames include ONLY the fields
// that changed, so absent fields must keep their previous value: every
// member is a string and "" means "not in this frame".
type wsTicker struct {
	Symbol          string `json:"symbol"`
	MarkPrice       string `json:"markPrice"`
	FundingRate     string `json:"fundingRate"`
	NextFundingTime string `json:"nextFundingTime"`
	OpenInterest    string `json:"openInterest"`
}

// wsLiquidation is one allLiquidation entry. S is the POSITION side that was
// liquidated: "Buy" means a LONG was liquidated. That is the opposite
// convention from Binance's forceOrder, whose side is the ORDER side; the
// mapping below converts so the wire meaning stays identical across venues.
type wsLiquidation struct {
	Time   int64  `json:"T"`
	Symbol string `json:"s"`
	Side   string `json:"S"`
	Size   string `json:"v"`
	Price  string `json:"p"` // bankruptcy price
}

// NewFeed creates a feed. Call Run to start it.
func NewFeed(symbol string, log *slog.Logger, emit Emit) *Feed {
	return &Feed{
		Symbol: lower(symbol),
		Native: upper(symbol),
		emit:   emit,
		log:    log.With("symbol", lower(symbol)),
		bids:   make(map[float64]float64),
		asks:   make(map[float64]float64),
	}
}

func (f *Feed) SetTradeReset(reset func(int64)) { f.tradeReset = reset }

// Run connects the upstream streams and blocks until ctx is cancelled.
func (f *Feed) Run(ctx context.Context) {
	n := f.Native
	go f.seedBook(ctx)

	// Market stream: trades, stats ticker, liquidations. None of these
	// need sequence recovery, so they ride one connection.
	market := NewStream([]string{
		"publicTrade." + n,
		"tickers." + n,
		"allLiquidation." + n,
	}, f.log, f.onMessage, func() {
		f.mu.Lock()
		f.lastTradeID = ""
		f.lastTradeTime = 0
		f.mu.Unlock()
		if f.tradeReset != nil {
			f.tradeReset(time.Now().UnixMilli())
		}
	})

	// Depth rides its own connection, exactly like the Binance feed: a
	// reconnect is the book resync procedure here, and tying it to the
	// trade stream would discard tape continuity every time the book gaps.
	f.depth = NewStream([]string{
		"orderbook." + depthTopicLevels + "." + n,
	}, f.log, f.onMessage, func() {
		f.mu.Lock()
		f.synced = false
		f.lastU = 0
		f.mu.Unlock()
	})

	var streams sync.WaitGroup
	streams.Add(1)
	go func() { defer streams.Done(); f.depth.Run(ctx) }()
	go f.pollREST(ctx)
	go f.warnIfNoTrades(ctx)
	market.Run(ctx)
	streams.Wait()
}

func (f *Feed) onMessage(env Envelope) {
	switch {
	case hasPrefix(env.Topic, "publicTrade."):
		f.onTrades(env)
	case hasPrefix(env.Topic, "orderbook."):
		f.onDepth(env)
	case hasPrefix(env.Topic, "tickers."):
		f.onTicker(env)
	case hasPrefix(env.Topic, "allLiquidation."):
		f.onLiquidation(env)
	}
}

func (f *Feed) onTrades(env Envelope) {
	var arr []wsTrade
	if err := json.Unmarshal(env.Data, &arr); err != nil {
		// Never swallow this. A silent return here is how a wire-shape
		// change turns into an empty panel with no explanation.
		f.log.Warn("unparsable bybit trade payload", "err", err)
		return
	}
	for i := range arr {
		t := &arr[i]
		price := parseF(t.Price)
		qty := parseF(t.Size)
		if price <= 0 || qty <= 0 || math.IsNaN(price) || math.IsNaN(qty) ||
			math.IsInf(price, 0) || math.IsInf(qty, 0) || t.Time <= 0 {
			continue
		}
		f.mu.Lock()
		// Skip an exact redelivery, nothing more: Bybit trade ids are
		// UUIDs, not a per-symbol sequence, so only time ordering signals
		// a gap - the same situation as Hyperliquid.
		if t.TradeID != "" && t.TradeID == f.lastTradeID {
			f.mu.Unlock()
			continue
		}
		gap := t.Time < f.lastTradeTime
		f.lastTradeID = t.TradeID
		f.lastTradeTime = t.Time
		f.lastTrade = price
		f.tradeCount++
		f.mu.Unlock()
		if gap && f.tradeReset != nil {
			f.tradeReset(time.Now().UnixMilli())
			f.log.Warn("trade timestamp went backwards; discarding partial volume minute")
		}
		// S is the TAKER side, so "Buy" is an aggressive buy. This is the
		// provider's own aggressor flag, never derived from price movement.
		// The execution UUID is Bybit's own trade id; the terminal's
		// replay guard (RecentTradeIdentities) keys on exactly these to
		// reject redeliveries across reconnects.
		f.emit(pb.Stream_STREAM_TRADES, 0, t.Time, &pb.Trade{
			Price:         price,
			Qty:           qty,
			IsBuy:         t.Side == "Buy",
			TimestampMs:   t.Time,
			NativeTradeId: t.TradeID,
		})
	}
}

func (f *Feed) onLiquidation(env Envelope) {
	var arr []wsLiquidation
	if err := json.Unmarshal(env.Data, &arr); err != nil {
		// Never swallow this. A silent return here is how a wire-shape
		// change turns into an empty panel with no explanation.
		f.log.Warn("unparsable bybit liquidation payload", "err", err)
		return
	}
	for i := range arr {
		l := &arr[i]
		ts := l.Time
		if ts <= 0 {
			ts = env.TS
		}
		// The wire convention (set by Binance forceOrder) is IsBuy = the
		// liquidation ORDER was a buy, i.e. a SHORT was liquidated. Bybit's
		// S is the POSITION side instead: "Buy" = a long was liquidated by
		// a sell order. Hence the inversion - S=="Sell" (short liquidated,
		// bought back) maps to IsBuy=true. Flipping this flips the
		// liquidation heatmap.
		f.emit(pb.Stream_STREAM_LIQUIDATIONS, 0, ts, &pb.Liquidation{
			TimestampMs: ts,
			Price:       parseF(l.Price),
			AvgPrice:    parseF(l.Price), // bankruptcy price is the only price given
			Qty:         parseF(l.Size),
			IsBuy:       l.Side == "Sell",
		})
	}
}

func (f *Feed) onTicker(env Envelope) {
	var t wsTicker
	if err := json.Unmarshal(env.Data, &t); err != nil {
		// Never swallow this. A silent return here is how a wire-shape
		// change turns into an empty panel with no explanation.
		f.log.Warn("unparsable bybit ticker payload", "err", err)
		return
	}
	// Delta frames carry only what changed; "" means "keep the old value".
	f.mu.Lock()
	if v := parseF(t.MarkPrice); t.MarkPrice != "" && v > 0 {
		f.markPrice = v
	}
	if t.FundingRate != "" {
		f.funding = parseF(t.FundingRate)
	}
	if t.NextFundingTime != "" {
		if ms, err := strconv.ParseInt(t.NextFundingTime, 10, 64); err == nil && ms > 0 {
			f.nextFunding = ms
		}
	}
	if v := parseF(t.OpenInterest); t.OpenInterest != "" && v > 0 {
		f.openInt = v
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

// ── orderbook ───────────────────────────────────────────────────────────────

func (f *Feed) onDepth(env Envelope) {
	var b wsBook
	if err := json.Unmarshal(env.Data, &b); err != nil {
		// Never swallow this. A silent return here is how a wire-shape
		// change turns into an empty panel with no explanation.
		f.log.Warn("unparsable bybit depth payload", "err", err)
		return
	}
	ts := env.TS
	if ts <= 0 {
		ts = time.Now().UnixMilli()
	}

	// "u"=1 is a service-restart snapshot whatever the frame's type says;
	// Bybit documents it as "please overwrite your local orderbook".
	if env.Type == "snapshot" || b.U == 1 {
		f.mu.Lock()
		f.bids = make(map[float64]float64, len(b.Bids))
		f.asks = make(map[float64]float64, len(b.Asks))
		applyBookSide(f.bids, b.Bids)
		applyBookSide(f.asks, b.Asks)
		f.lastU = b.U
		f.synced = true
		f.seedBids, f.seedAsks = nil, nil // live book supersedes the seed
		bids, asks := f.sortedLocked()
		last := f.lastTrade
		f.mu.Unlock()

		f.log.Info("orderbook synced", "levels", len(bids)+len(asks))
		f.emit(pb.Stream_STREAM_ORDERBOOK, 0, ts, &pb.BookUpdate{
			TimestampMs:  ts,
			Asks:         asks,
			Bids:         bids,
			Snapshot:     true,
			LastPrice:    last,
			LastUpdateId: b.U,
		})
		return
	}

	// Delta: the update id must advance by exactly 1. On a gap there is no
	// replay source - reconnect and let the fresh snapshot resync the book.
	f.mu.Lock()
	if !f.synced {
		f.mu.Unlock()
		return // deltas before the snapshot mean nothing
	}
	if b.U != f.lastU+1 {
		f.synced = false
		f.mu.Unlock()
		f.log.Warn("orderbook sequence gap, reconnecting depth stream",
			"expected", f.lastU+1, "got", b.U)
		if f.depth != nil {
			f.depth.Reconnect()
		}
		return
	}
	applyBookSide(f.bids, b.Bids)
	applyBookSide(f.asks, b.Asks)
	prev := f.lastU
	f.lastU = b.U
	last := f.lastTrade
	f.mu.Unlock()

	f.emit(pb.Stream_STREAM_ORDERBOOK, 0, ts, &pb.BookUpdate{
		TimestampMs:      ts,
		Asks:             levels(b.Asks),
		Bids:             levels(b.Bids),
		Snapshot:         false,
		LastPrice:        last,
		FirstUpdateId:    b.U,
		LastUpdateId:     b.U,
		PreviousUpdateId: prev,
	})
}

// seedBook pulls one deep REST snapshot so the DOM ladder has depth before
// the first live frame lands. The REST book's update ids belong to a
// different feed than the streamed depth, so the seed is display-only: the
// first WS snapshot replaces it wholesale.
func (f *Feed) seedBook(ctx context.Context) {
	snapCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	snap, err := Orderbook(snapCtx, f.Native, maxSeedLevels)
	if err != nil {
		f.log.Debug("bybit depth snapshot failed; live book will seed from WS", "err", err)
		return
	}
	ts := snap.TS
	if ts <= 0 {
		ts = time.Now().UnixMilli()
	}
	bids := levels(snap.Bids)
	asks := levels(snap.Asks)
	if len(bids) == 0 && len(asks) == 0 {
		return
	}
	f.mu.Lock()
	if f.synced {
		f.mu.Unlock()
		return // the live stream beat the seed; the live book wins
	}
	f.seedBids, f.seedAsks = bids, asks
	f.seedTime = ts
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

// pollREST fills in whatever the tickers stream has not delivered yet. The
// endpoint returns every linear symbol in one weight-cheap call, and all
// four values move slowly, so 30s keeps the stats panel populated on every
// network while the stream, when it works, stays fresher.
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
	arr, err := Tickers(pctx)
	if err != nil {
		if ctx.Err() == nil {
			f.log.Debug("bybit ticker poll failed", "err", err)
		}
		return
	}
	for i := range arr {
		t := &arr[i]
		if t.Symbol != f.Native {
			continue
		}
		f.mu.Lock()
		// The WebSocket ticker, when it works, is fresher than a 30s poll,
		// so only fill in what is still missing.
		if f.markPrice == 0 {
			f.markPrice = parseF(t.MarkPrice)
		}
		if f.funding == 0 {
			f.funding = parseF(t.FundingRate)
		}
		if f.nextFunding == 0 {
			if ms, err := strconv.ParseInt(t.NextFundingTime, 10, 64); err == nil {
				f.nextFunding = ms
			}
		}
		if f.openInt == 0 {
			f.openInt = parseF(t.OpenInterest)
		}
		f.mu.Unlock()
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
	trades, book := f.tradeCount, f.synced
	f.mu.RUnlock()
	if trades == 0 && book {
		f.log.Warn("orderbook is live but no trades received in 30s: " +
			"the trade subscription may be unreachable from this network")
	}
}

// Snapshot returns the current book as a snapshot BookUpdate, or nil until
// something has landed. Used to prime a newly subscribed client. The REST
// seed serves until the first live snapshot arrives.
func (f *Feed) Snapshot() *pb.BookUpdate {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.synced {
		bids, asks := f.sortedLocked()
		return &pb.BookUpdate{
			TimestampMs:  time.Now().UnixMilli(),
			Asks:         asks,
			Bids:         bids,
			Snapshot:     true,
			LastPrice:    f.lastTrade,
			LastUpdateId: f.lastU,
		}
	}
	if len(f.seedBids) > 0 || len(f.seedAsks) > 0 {
		return &pb.BookUpdate{
			TimestampMs: f.seedTime,
			Asks:        f.seedAsks,
			Bids:        f.seedBids,
			Snapshot:    true,
			LastPrice:   f.lastTrade,
		}
	}
	return nil
}

func (f *Feed) sortedLocked() (bids, asks []*pb.BookLevel) {
	bids = make([]*pb.BookLevel, 0, len(f.bids))
	for p, s := range f.bids {
		bids = append(bids, &pb.BookLevel{Price: p, Size: s})
	}
	asks = make([]*pb.BookLevel, 0, len(f.asks))
	for p, s := range f.asks {
		asks = append(asks, &pb.BookLevel{Price: p, Size: s})
	}
	sort.Slice(bids, func(i, j int) bool { return bids[i].Price > bids[j].Price })
	sort.Slice(asks, func(i, j int) bool { return asks[i].Price < asks[j].Price })
	return bids, asks
}

// ── helpers ─────────────────────────────────────────────────────────────────

func applyBookSide(side map[float64]float64, src [][]string) {
	for _, l := range src {
		if len(l) < 2 {
			continue
		}
		p, s := parseF(l[0]), parseF(l[1])
		if p <= 0 {
			continue
		}
		if s == 0 {
			delete(side, p)
		} else {
			side[p] = s
		}
	}
}

func levels(src [][]string) []*pb.BookLevel {
	out := make([]*pb.BookLevel, 0, len(src))
	for _, l := range src {
		if len(l) < 2 {
			continue
		}
		out = append(out, &pb.BookLevel{Price: parseF(l[0]), Size: parseF(l[1])})
	}
	return out
}

func hasPrefix(s, pre string) bool {
	return len(s) >= len(pre) && s[:len(pre)] == pre
}
