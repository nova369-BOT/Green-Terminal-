package bybit

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// RESTBase is the Bybit v5 REST host. Override for testnet
// (https://api-testnet.bybit.com).
var RESTBase = "https://api.bybit.com"

var httpClient = &http.Client{Timeout: 15 * time.Second}

// restEnvelope is the v5 wrapper around every REST response. retCode 0 is
// success; anything else carries the reason in retMsg.
type restEnvelope struct {
	RetCode int             `json:"retCode"`
	RetMsg  string          `json:"retMsg"`
	Result  json.RawMessage `json:"result"`
}

func getJSON(ctx context.Context, path string, q url.Values, out any) error {
	u := RESTBase + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bybit %s: http %d", path, resp.StatusCode)
	}
	var env restEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return err
	}
	if env.RetCode != 0 {
		return fmt.Errorf("bybit %s: retCode %d: %s", path, env.RetCode, env.RetMsg)
	}
	return json.Unmarshal(env.Result, out)
}

// ExchangeSymbols returns the tradable linear-contract symbols, lowercased
// to match the terminal's bybit symbol form. Used to validate what a client
// asks for before opening an upstream socket. The endpoint pages by cursor;
// one page holds up to 1000 instruments, so two pages cover the venue with
// headroom.
func ExchangeSymbols(ctx context.Context) (map[string]bool, error) {
	set := make(map[string]bool, 512)
	cursor := ""
	for page := 0; page < 10; page++ {
		q := url.Values{
			"category": {"linear"},
			"limit":    {"1000"},
		}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var out struct {
			List []struct {
				Symbol string `json:"symbol"`
				Status string `json:"status"`
			} `json:"list"`
			NextPageCursor string `json:"nextPageCursor"`
		}
		if err := getJSON(ctx, "/v5/market/instruments-info", q, &out); err != nil {
			if page == 0 {
				return nil, err
			}
			break // keep what we have rather than dropping validation whole
		}
		for _, s := range out.List {
			if s.Status == "Trading" {
				set[lower(s.Symbol)] = true
			}
		}
		if out.NextPageCursor == "" {
			break
		}
		cursor = out.NextPageCursor
	}
	return set, nil
}

// OrderbookSnapshot is the REST orderbook used to seed the DOM ladder before
// the first live frame lands. Its update id belongs to the 1000-level feed,
// not the streamed depth, so it can NOT be sequenced against WS deltas; it
// is display seed only, replaced wholesale by the first WS snapshot.
type OrderbookSnapshot struct {
	Symbol string     `json:"s"`
	Bids   [][]string `json:"b"`
	Asks   [][]string `json:"a"`
	TS     int64      `json:"ts"`
	U      int64      `json:"u"`
}

// Orderbook fetches a deep snapshot; linear supports up to 1000 levels.
func Orderbook(ctx context.Context, symbol string, limit int) (*OrderbookSnapshot, error) {
	var out OrderbookSnapshot
	err := getJSON(ctx, "/v5/market/orderbook", url.Values{
		"category": {"linear"},
		"symbol":   {upper(symbol)},
		"limit":    {strconv.Itoa(limit)},
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Kline is one historical candle. Bybit returns heterogeneous JSON arrays:
// [startTime, open, high, low, close, volume, turnover], newest first.
type Kline struct {
	StartTime int64
	Open      float64
	High      float64
	Low       float64
	Close     float64
	Volume    float64
	Turnover  float64
}

func (k *Kline) UnmarshalJSON(b []byte) error {
	var raw []string
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if len(raw) < 7 {
		return fmt.Errorf("kline: expected >=7 fields, got %d", len(raw))
	}
	k.StartTime, _ = strconv.ParseInt(raw[0], 10, 64)
	k.Open = parseF(raw[1])
	k.High = parseF(raw[2])
	k.Low = parseF(raw[3])
	k.Close = parseF(raw[4])
	k.Volume = parseF(raw[5])
	k.Turnover = parseF(raw[6])
	return nil
}

// intervalFor maps a timeframe in seconds to a Bybit kline interval string
// (minutes, or D/W). Bybit has no sub-minute klines, so 1s/5s/15s/30s return
// false and must be built locally from the trade stream.
func intervalFor(tfSec int64) (string, bool) {
	switch tfSec {
	case 60:
		return "1", true
	case 180:
		return "3", true
	case 300:
		return "5", true
	case 900:
		return "15", true
	case 1800:
		return "30", true
	case 3600:
		return "60", true
	case 7200:
		return "120", true
	case 14400:
		return "240", true
	case 21600:
		return "360", true
	case 43200:
		return "720", true
	case 86400:
		return "D", true
	case 604800:
		return "W", true
	default:
		return "", false
	}
}

// Klines fetches historical candles, oldest first. endTimeMs of 0 means "up
// to now". Bybit caps limit at 1000.
func Klines(ctx context.Context, symbol string, tfSec int64, count int, endTimeMs int64) ([]Kline, error) {
	interval, ok := intervalFor(tfSec)
	if !ok {
		return nil, fmt.Errorf("no bybit kline interval for timeframe %ds", tfSec)
	}
	if count > 1000 {
		count = 1000
	}
	if count <= 0 {
		count = 500
	}
	q := url.Values{
		"category": {"linear"},
		"symbol":   {upper(symbol)},
		"interval": {interval},
		"limit":    {strconv.Itoa(count)},
	}
	if endTimeMs > 0 {
		q.Set("end", strconv.FormatInt(endTimeMs, 10))
	}
	var out struct {
		List []Kline `json:"list"`
	}
	if err := getJSON(ctx, "/v5/market/kline", q, &out); err != nil {
		return nil, err
	}
	// Newest first on the wire; the terminal wants oldest first.
	res := out.List
	for i, j := 0, len(res)-1; i < j; i, j = i+1, j-1 {
		res[i], res[j] = res[j], res[i]
	}
	return res, nil
}

// Ticker is one symbol's REST ticker entry: the 24h window plus the
// mark/funding/open-interest trio the stats panel wants.
type Ticker struct {
	Symbol          string `json:"symbol"`
	LastPrice       string `json:"lastPrice"`
	Price24hPcnt    string `json:"price24hPcnt"` // ratio, e.g. "0.0152" = +1.52%
	Turnover24h     string `json:"turnover24h"`
	MarkPrice       string `json:"markPrice"`
	OpenInterest    string `json:"openInterest"`
	FundingRate     string `json:"fundingRate"`
	NextFundingTime string `json:"nextFundingTime"` // epoch ms, as a string
}

// Tickers fetches every linear symbol's ticker in one call. Serves both the
// all-market 24h ticker and the per-symbol stats fallback.
func Tickers(ctx context.Context) ([]Ticker, error) {
	var out struct {
		List []Ticker `json:"list"`
	}
	if err := getJSON(ctx, "/v5/market/tickers", url.Values{
		"category": {"linear"},
	}, &out); err != nil {
		return nil, err
	}
	return out.List, nil
}

// ── helpers ─────────────────────────────────────────────────────────────────

func parseF(s string) float64 {
	f, _ := strconv.ParseFloat(s, 64)
	return f
}

func lower(s string) string { return strings.ToLower(s) }
func upper(s string) string { return strings.ToUpper(s) }
