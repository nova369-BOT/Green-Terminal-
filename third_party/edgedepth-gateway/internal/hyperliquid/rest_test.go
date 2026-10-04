package hyperliquid

import (
	"encoding/json"
	"testing"
)

func TestIntervalFor(t *testing.T) {
	want := map[int64]string{
		60: "1m", 180: "3m", 300: "5m", 900: "15m", 1800: "30m",
		3600: "1h", 7200: "2h", 14400: "4h", 28800: "8h",
		43200: "12h", 86400: "1d", 259200: "3d", 604800: "1w",
	}
	for tf, iv := range want {
		got, ok := intervalFor(tf)
		if !ok || got != iv {
			t.Fatalf("tf=%d got=%q ok=%v", tf, got, ok)
		}
	}
	for _, tf := range []int64{1, 5, 15, 30, 7, 45} {
		if _, ok := intervalFor(tf); ok {
			t.Fatalf("tf=%d must have no interval", tf)
		}
	}
}

func TestNextFundingMs(t *testing.T) {
	if got := NextFundingMs(0); got != 3600000 {
		t.Fatalf("got=%d", got)
	}
	if got := NextFundingMs(3600000); got != 7200000 {
		t.Fatalf("got=%d", got)
	}
	if got := NextFundingMs(3600001); got != 7200000 {
		t.Fatalf("got=%d", got)
	}
}

func TestShapesUnmarshal(t *testing.T) {
	var c HLCandle
	if err := json.Unmarshal([]byte(`{"t":1788739200000,"T":1788739260000,"s":"BTC","i":"1m","o":"67000.0","c":"67001.0","h":"67002.0","l":"66999.0","v":"12.5","n":42}`), &c); err != nil {
		t.Fatal(err)
	}
	if c.OpenTime != 1788739200000 || c.CloseTime != 1788739260000 || c.Open != "67000.0" || c.Volume != "12.5" || c.Trades != 42 {
		t.Fatalf("candle=%+v", c)
	}
	var ctx AssetCtx
	if err := json.Unmarshal([]byte(`{"dayNtlVlm":"1426126.29","funding":"0.0000125","markPx":"67000.5","midPx":"67000.0","openInterest":"688.11","oraclePx":"66999.0","premium":"0.00031774","prevDayPx":"66000.0"}`), &ctx); err != nil {
		t.Fatal(err)
	}
	if ctx.MarkPx != "67000.5" || ctx.Funding != "0.0000125" || ctx.PrevDayPx != "66000.0" {
		t.Fatalf("ctx=%+v", ctx)
	}
	var b L2Snapshot
	if err := json.Unmarshal([]byte(`{"coin":"BTC","time":1788739200100,"levels":[[{"px":"67000.0","sz":"1.5","n":3}],[{"px":"67001.0","sz":"2.0","n":1}]]}`), &b); err != nil {
		t.Fatal(err)
	}
	if b.Coin != "BTC" || len(b.Levels[0]) != 1 || len(b.Levels[1]) != 1 || b.Levels[0][0].Px != "67000.0" {
		t.Fatalf("book=%+v", b)
	}
}
