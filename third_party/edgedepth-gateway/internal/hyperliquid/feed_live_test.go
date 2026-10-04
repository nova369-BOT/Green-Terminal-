package hyperliquid

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

// TestLiveFeedEmits isolates Feed: does it turn Hyperliquid frames into pb
// messages? Bisects between Stream (known good) and Hub.
func TestLiveFeedEmits(t *testing.T) {
	if os.Getenv("EDGEDEPTH_LIVE") != "1" {
		t.Skip("set EDGEDEPTH_LIVE=1")
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))

	var mu sync.Mutex
	counts := map[pb.Stream]int{}

	f := NewFeed("BTC", log, func(stream pb.Stream, tf, evtMs int64, inner proto.Message) {
		mu.Lock()
		counts[stream]++
		n := counts[stream]
		mu.Unlock()
		if n <= 2 {
			t.Logf("emit %-24s %v", stream.String(), inner)
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	f.Run(ctx)

	mu.Lock()
	defer mu.Unlock()
	t.Logf("emit counts: %v", counts)
	if counts[pb.Stream_STREAM_ORDERBOOK] == 0 {
		t.Errorf("expected orderbook snapshots, got 0")
	}
	if counts[pb.Stream_STREAM_TRADES] == 0 {
		t.Errorf("expected trades, got 0")
	}
}

// TestLiveREST checks the three REST reads the venue depends on: the symbol
// whitelist, one historical candle page and one orderbook snapshot.
func TestLiveREST(t *testing.T) {
	if os.Getenv("EDGEDEPTH_LIVE") != "1" {
		t.Skip("set EDGEDEPTH_LIVE=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	set, err := ExchangeSymbols(ctx)
	if err != nil {
		t.Fatalf("symbols: %v", err)
	}
	if len(set) < 50 || !set["BTC"] {
		t.Fatalf("symbols=%d hasBTC=%v", len(set), set["BTC"])
	}

	kl, err := Candles(ctx, "BTC", 60, 10, 0)
	if err != nil {
		t.Fatalf("candles: %v", err)
	}
	if len(kl) == 0 || kl[0].OpenTime <= 0 {
		t.Fatalf("candles=%v", kl)
	}

	book, err := L2Book(ctx, "BTC")
	if err != nil {
		t.Fatalf("l2book: %v", err)
	}
	if len(book.Levels[0]) == 0 || len(book.Levels[1]) == 0 {
		t.Fatalf("book=%v", book)
	}
	t.Logf("symbols=%d candles=%d bookLevels=%d+%d", len(set), len(kl), len(book.Levels[0]), len(book.Levels[1]))
}
