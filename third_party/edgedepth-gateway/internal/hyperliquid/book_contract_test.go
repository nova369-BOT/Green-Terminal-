package hyperliquid

import (
	"io"
	"log/slog"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

func TestBookSnapshotReplacesAndPrimes(t *testing.T) {
	var books []*pb.BookUpdate
	f := NewFeed("BTC", slog.New(slog.NewTextHandler(io.Discard, nil)), func(_ pb.Stream, _, _ int64, m proto.Message) { books = append(books, m.(*pb.BookUpdate)) })
	if f.Snapshot() != nil {
		t.Fatal("snapshot before any book frame must be nil")
	}
	// A frame for another coin is ignored.
	f.onBook([]byte(`{"coin":"ETH","time":1788739200099,"levels":[[{"px":"3000.0","sz":"1","n":1}],[{"px":"3001.0","sz":"1","n":1}]]}`))
	f.onBook([]byte(`{"coin":"BTC","time":1788739200100,"levels":[[{"px":"67000.0","sz":"1.5","n":3},{"px":"66999.5","sz":"0","n":0}],[{"px":"67001.0","sz":"2.0","n":1}]]}`))
	if len(books) != 1 {
		t.Fatalf("books=%d", len(books))
	}
	b := books[0]
	if !b.Snapshot || b.TimestampMs != 1788739200100 || len(b.Bids) != 1 || len(b.Asks) != 1 ||
		b.Bids[0].Price != 67000 || b.Bids[0].Size != 1.5 || b.Asks[0].Price != 67001 || b.Asks[0].Size != 2 {
		t.Fatalf("book=%v", b)
	}
	snap := f.Snapshot()
	if snap == nil || !snap.Snapshot || len(snap.Bids) != 1 || len(snap.Asks) != 1 {
		t.Fatalf("snapshot=%v", snap)
	}
}

func TestCtxMarksAndOI(t *testing.T) {
	f := NewFeed("btc", slog.New(slog.NewTextHandler(io.Discard, nil)), func(pb.Stream, int64, int64, proto.Message) {})
	if f.Coin != "BTC" {
		t.Fatalf("coin=%q", f.Coin)
	}
	f.onCtx([]byte(`{"coin":"BTC","ctx":{"markPx":"67000.5","midPx":"67000.0","oraclePx":"66999.0","openInterest":"1234.5","dayNtlVlm":"999.0"}}`))
	// Another coin never touches this feed's state.
	f.onCtx([]byte(`{"coin":"ETH","ctx":{"markPx":"1.0","openInterest":"1"}}`))
	mark, _, oi, _ := f.MarkState()
	if mark != 67000.5 || oi != 1234.5 {
		t.Fatalf("mark=%v oi=%v", mark, oi)
	}
}
