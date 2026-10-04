package hyperliquid

import (
	"io"
	"log/slog"
	"testing"

	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

func TestTickerMergesLiveMidsOverRestStats(t *testing.T) {
	var got []*pb.Ticker24HUpdate
	tr := NewTickerFeed(slog.New(slog.NewTextHandler(io.Discard, nil)), func(u *pb.Ticker24HUpdate) { got = append(got, u) })
	// Mids alone, before any REST stats: nothing to publish yet.
	tr.onMids([]byte(`{"mids":{"BTC":"67000.0","ETH":"3000.0"}}`))
	if len(got) != 0 {
		t.Fatalf("got=%d", len(got))
	}
	// REST stats land (as pollOnce would store them); the next mids push
	// publishes the merged ticker with the LIVE price winning.
	tr.names = []string{"BTC", "ETH"}
	tr.mark = map[string]float64{"BTC": 66999, "ETH": 2999}
	tr.change = map[string]float64{"BTC": 1.5, "ETH": -0.5}
	tr.vol = map[string]float64{"BTC": 1000, "ETH": 2000}
	tr.onMids([]byte(`{"mids":{"BTC":"67000.0","ETH":"3000.0"}}`))
	if len(got) != 1 || len(got[0].Entries) != 2 {
		t.Fatalf("got=%v", got)
	}
	e := got[0].Entries[0]
	if e.Symbol != "BTC" || e.LastPrice != 67000 || e.ChangePct != 1.5 || e.VolumeQuote != 1000 {
		t.Fatalf("entry=%v", e)
	}
}
