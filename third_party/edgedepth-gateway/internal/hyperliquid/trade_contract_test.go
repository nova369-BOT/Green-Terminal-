package hyperliquid

import (
	"io"
	"log/slog"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

func TestTradeSideDuplicatesAndGapReset(t *testing.T) {
	var trades []*pb.Trade
	resets := 0
	f := NewFeed("BTC", slog.New(slog.NewTextHandler(io.Discard, nil)), func(_ pb.Stream, _, _ int64, m proto.Message) { trades = append(trades, m.(*pb.Trade)) })
	f.SetTradeReset(func(int64) { resets++ })
	a := []byte(`[{"coin":"BTC","side":"B","px":"67000.5","sz":"0.01","time":1788739200100,"hash":"0xabc","tid":100},{"coin":"BTC","side":"A","px":"67001.0","sz":"0.02","time":1788739200101,"hash":"0xdef","tid":101}]`)
	f.onTrades(a)
	// Exact redelivery of tid 101 is skipped; a trade for another coin with
	// an older timestamp trips the gap reset exactly once.
	f.onTrades([]byte(`[{"coin":"BTC","side":"A","px":"67001.0","sz":"0.02","time":1788739200101,"hash":"0xdef","tid":101}]`))
	f.onTrades([]byte(`[{"coin":"BTC","side":"B","px":"66999.0","sz":"0.03","time":1788739200099,"hash":"0xghi","tid":102}]`))
	// Zero price and NaN never reach the tape.
	f.onTrades([]byte(`[{"coin":"BTC","side":"B","px":"0","sz":"1","time":1788739200102,"hash":"0xjkl","tid":103}]`))
	f.onTrades([]byte(`[{"coin":"BTC","side":"B","px":"NaN","sz":"1","time":1788739200103,"hash":"0jmno","tid":104}]`))
	if len(trades) != 3 || !trades[0].IsBuy || trades[1].IsBuy || !trades[2].IsBuy ||
		trades[0].TimestampMs != 1788739200100 || trades[0].Price != 67000.5 || trades[1].Qty != 0.02 || resets != 1 {
		t.Fatalf("trades=%v resets=%d", trades, resets)
	}
}
