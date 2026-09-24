package hyperliquid

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"
)

// RESTBase is the Hyperliquid public API host. Override for testnet.
var RESTBase = "https://api.hyperliquid.xyz"

var httpClient = &http.Client{Timeout: 15 * time.Second}

// postInfo POSTs a JSON body to /info and decodes the JSON response. Every
// Hyperliquid read is a POST carrying a "type" field; there are no GETs, so a
// plain GET returning 405 still proves the venue is reachable.
func postInfo(ctx context.Context, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, RESTBase+"/info", bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("hyperliquid /info: http %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// AssetCtx is one perp's live context: mark, funding, open interest and the
// rolling 24h window the ticker is derived from.
type AssetCtx struct {
	DayNtlVlm    string `json:"dayNtlVlm"`
	Funding      string `json:"funding"`
	MarkPx       string `json:"markPx"`
	MidPx        string `json:"midPx"`
	OpenInterest string `json:"openInterest"`
	OraclePx     string `json:"oraclePx"`
	Premium      string `json:"premium"`
	PrevDayPx    string `json:"prevDayPx"`
}

// UniverseEntry is one tradable perp. Name is the native UPPERCASE coin
// ("BTC"), which the terminal uses end-to-end for the hl venue.
type UniverseEntry struct {
	Name         string `json:"name"`
	SzDecimals   int    `json:"szDecimals"`
	MaxLeverage  int    `json:"maxLeverage"`
	OnlyIsolated bool   `json:"onlyIsolated"`
}

// MetaAndAssetCtxs fetches the perp universe plus every asset's live context
// in one call. The response is a 2-element array: [{universe:[...]}, [ctx...]]
// with contexts in the same order as the universe entries.
func MetaAndAssetCtxs(ctx context.Context) ([]UniverseEntry, []AssetCtx, error) {
	var out [2]json.RawMessage
	if err := postInfo(ctx, map[string]string{"type": "metaAndAssetCtxs"}, &out); err != nil {
		return nil, nil, err
	}
	var meta struct {
		Universe []UniverseEntry `json:"universe"`
	}
	if err := json.Unmarshal(out[0], &meta); err != nil {
		return nil, nil, fmt.Errorf("hyperliquid meta: %w", err)
	}
	var ctxs []AssetCtx
	if err := json.Unmarshal(out[1], &ctxs); err != nil {
		return nil, nil, fmt.Errorf("hyperliquid assetCtxs: %w", err)
	}
	return meta.Universe, ctxs, nil
}

// ExchangeSymbols returns the tradable perp coin whitelist in native
// UPPERCASE form. Used to validate what a client asks for before opening an
// upstream socket.
func ExchangeSymbols(ctx context.Context) (map[string]bool, error) {
	universe, _, err := MetaAndAssetCtxs(ctx)
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(universe))
	for _, u := range universe {
		if u.Name != "" {
			set[u.Name] = true
		}
	}
	return set, nil
}

// WsLevel is one aggregated price level. It appears identically in the REST
// snapshot and the WebSocket book frames.
type WsLevel struct {
	Px string `json:"px"`
	Sz string `json:"sz"`
	N  int    `json:"n"`
}

// L2Snapshot is the REST orderbook snapshot used to seed the book before the
// first live frame lands. Levels[0] is bids (best first), Levels[1] is asks.
type L2Snapshot struct {
	Coin   string       `json:"coin"`
	Time   int64        `json:"time"`
	Levels [2][]WsLevel `json:"levels"`
}

// L2Book fetches an orderbook snapshot. No aggregation parameters are sent,
// so prices come back exact.
func L2Book(ctx context.Context, coin string) (*L2Snapshot, error) {
	var out L2Snapshot
	err := postInfo(ctx, map[string]string{"type": "l2Book", "coin": coin}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// HLCandle is one historical candle. t is the OPEN time and T the CLOSE time,
// both in epoch milliseconds.
type HLCandle struct {
	OpenTime  int64  `json:"t"`
	CloseTime int64  `json:"T"`
	Symbol    string `json:"s"`
	Interval  string `json:"i"`
	Open      string `json:"o"`
	Close     string `json:"c"`
	High      string `json:"h"`
	Low       string `json:"l"`
	Volume    string `json:"v"`
	Trades    int    `json:"n"`
}

// intervalFor maps a timeframe in seconds to a Hyperliquid candle interval
// string. There are no sub-minute intervals, so 1s/5s/15s/30s return false
// and must be built locally from the trade stream.
func intervalFor(tfSec int64) (string, bool) {
	switch tfSec {
	case 60:
		return "1m", true
	case 180:
		return "3m", true
	case 300:
		return "5m", true
	case 900:
		return "15m", true
	case 1800:
		return "30m", true
	case 3600:
		return "1h", true
	case 7200:
		return "2h", true
	case 14400:
		return "4h", true
	case 28800:
		return "8h", true
	case 43200:
		return "12h", true
	case 86400:
		return "1d", true
	case 259200:
		return "3d", true
	case 604800:
		return "1w", true
	default:
		return "", false
	}
}

// Candles fetches historical candles, oldest first. endTimeMs of 0 means "up
// to now". Hyperliquid keeps only the most recent 5000 candles per interval.
func Candles(ctx context.Context, coin string, tfSec int64, count int, endTimeMs int64) ([]HLCandle, error) {
	interval, ok := intervalFor(tfSec)
	if !ok {
		return nil, fmt.Errorf("no hyperliquid candle interval for timeframe %ds", tfSec)
	}
	if count > 1500 {
		count = 1500
	}
	if count <= 0 {
		count = 500
	}
	end := endTimeMs
	if end <= 0 {
		end = time.Now().UnixMilli()
	}
	start := end - int64(count)*tfSec*1000
	if start < 0 {
		start = 0
	}
	body := map[string]any{
		"type": "candleSnapshot",
		"req": map[string]any{
			"coin":      coin,
			"interval":  interval,
			"startTime": start,
			"endTime":   end,
		},
	}
	var out []HLCandle
	if err := postInfo(ctx, body, &out); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OpenTime < out[j].OpenTime })
	if len(out) > count {
		out = out[len(out)-count:]
	}
	return out, nil
}

// NextFundingMs returns the top of the next UTC hour in epoch milliseconds.
// Hyperliquid funding settles hourly on the hour, so the next funding time is
// always the coming hour boundary.
func NextFundingMs(nowMs int64) int64 {
	const hourMs = int64(3600 * 1000)
	return (nowMs/hourMs + 1) * hourMs
}
