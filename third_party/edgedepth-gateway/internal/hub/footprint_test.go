package hub_test

// The footprint pipeline on the wire. The terminal subscribes
// STREAM_TICK_VOLUME in SECONDS (60) - chart_widget.cpp subscribes
// {pair, TickVolume, 60} - while the hub keys its closed-minute broadcasts
// by volume.Minute (60000 ms). broadcast() delivers on an EXACT key match,
// so without normalization every live footprint minute is encoded, matched
// against nobody, and dropped: the terminal silently never hears a single
// closed minute. This is the same seconds/milliseconds drift statSeries
// absorbs for STREAM_STATS, pinned here for tick volume.

import (
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/edgedepthhq/edgedepth-gateway/internal/volume"
	"github.com/edgedepthhq/edgedepth-gateway/pkg/pb"
)

// A client that subscribed footprint minutes the way the terminal spells it
// (timeframe 60, seconds) must receive the minute the recorder closes.
func TestClosedFootprintMinuteReachesSecondsSubscriber(t *testing.T) {
	ex, conn := newProbe(t)

	subscribe(t, conn, stubSymbol, pb.Stream_STREAM_TICK_VOLUME, 60)
	feed := ex.waitForFeed(t)

	// The recorder discards the partial minute it was born into:
	// acceptFrom is the next minute boundary. Open that first accepted
	// minute with one trade, then close it with a trade in the minute
	// after. Timestamps a minute ahead of the wall clock are fine - the
	// recorder buckets by trade time, not receive time.
	base := (time.Now().UnixMilli()/volume.Minute + 1) * volume.Minute
	feed.trade(64100, 0.5, base+1)
	feed.trade(64200, 0.25, base+volume.Minute+1)

	env := readFrame(t, conn, pb.Stream_STREAM_TICK_VOLUME)

	var u pb.TickVolumeUpdate
	if err := proto.Unmarshal(env.Data, &u); err != nil {
		t.Fatalf("frame does not decode as pb.TickVolumeUpdate: %v", err)
	}
	if u.StartTime != base || u.EndTime != base+volume.Minute {
		t.Fatalf("closed minute spans [%d,%d], want [%d,%d]",
			u.StartTime, u.EndTime, base, base+volume.Minute)
	}
	if u.BuyVolume != 0.5 {
		t.Fatalf("closed minute carries buy volume %v, want the 0.5 that traded in it", u.BuyVolume)
	}
	var levels pb.TickVolumeLevels
	if err := proto.Unmarshal(u.LevelsData, &levels); err != nil || len(levels.Levels) != 1 {
		t.Fatalf("levels_data is not one raw-protobuf price level: %v %+v", err, &levels)
	}
	if levels.Levels[0].Price != 64100 {
		t.Fatalf("level price %v, want 64100", levels.Levels[0].Price)
	}
}
