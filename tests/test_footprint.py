"""Tests for the tick-derived footprint engine.

These assert real numbers, not "it ran": every expected value below is worked
out by hand from the input ticks so a regression in the tick rule, the row
segmentation, the delta accumulation or the value area shows up immediately.
"""

from lse_terminal.engine.footprint import (
    FootprintTick,
    build_footprint,
    build_footprint_bar,
    build_segments,
    suggest_row_height,
)


def _bar(t=0, o=100.0, h=104.0, low=98.0, c=103.0):
    return {"time_ms": t, "open": o, "high": h, "low": low, "close": c}


def test_segments_anchor_on_open_and_cover_the_range():
    segs = build_segments(open_=100.0, high=103.0, low=98.0, row_height=1.0)
    # one row of padding each side of low..high, anchored on the open
    assert segs[0] <= 97.0 and segs[-1] >= 104.0
    assert 100.0 in segs
    assert segs == sorted(segs)
    assert len(segs) == len(set(segs)), "rows must be unique or volume double-counts"


def test_segments_reject_bad_input():
    for bad in (0.0, -1.0):
        try:
            build_segments(100.0, 101.0, 99.0, bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"row_height={bad} should raise")


def test_tick_rule_uptick_is_buy_downtick_is_sell():
    ticks = [
        FootprintTick(time_ms=1, price=100.0),   # first: no predecessor -> both
        FootprintTick(time_ms=2, price=101.0),   # uptick -> buy
        FootprintTick(time_ms=3, price=100.0),   # downtick -> sell
        FootprintTick(time_ms=4, price=100.0),   # unchanged -> both
    ]
    fp = build_footprint_bar(_bar(o=100.0, h=101.0, low=100.0, c=100.0), ticks, 1.0)

    # first tick + unchanged tick credit BOTH sides (srl parity),
    # so buy = 1(first) + 1(uptick) + 1(unchanged) = 3
    #    sell = 1(first) + 1(downtick) + 1(unchanged) = 3
    assert fp.value_buy == 3
    assert fp.value_sell == 3
    assert fp.value_subtract == 0
    assert fp.normal_value == 6
    assert fp.inferred is True


def test_exchange_supplied_side_is_not_inferred():
    ticks = [
        FootprintTick(time_ms=1, price=100.0, side="buy", size=5),
        FootprintTick(time_ms=2, price=100.0, side="sell", size=2),
    ]
    fp = build_footprint_bar(_bar(o=100.0, h=100.0, low=100.0, c=100.0), ticks, 1.0)
    assert fp.value_buy == 5
    assert fp.value_sell == 2
    assert fp.delta_value == 3
    assert fp.inferred is False, "real aggressor flags must not be labelled an estimate"


def test_volume_lands_on_the_right_price_rows():
    ticks = [
        FootprintTick(time_ms=1, price=100.0, side="buy", size=1),
        FootprintTick(time_ms=2, price=102.0, side="buy", size=7),
        FootprintTick(time_ms=3, price=102.0, side="sell", size=2),
    ]
    fp = build_footprint_bar(_bar(o=100.0, h=102.0, low=100.0, c=102.0), ticks, 1.0)
    by_price = {r.price: r for r in fp.rows if r.total}
    assert by_price[102.0].buy == 7
    assert by_price[102.0].sell == 2
    assert by_price[102.0].delta == 5
    assert by_price[100.0].buy == 1
    # POC is the heaviest row: 102 has 9 vs 100's 1
    assert fp.poc_price == 102.0


def test_min_max_delta_track_the_running_excursion():
    ticks = [
        FootprintTick(time_ms=1, price=100.0, side="buy", size=3),   # +3
        FootprintTick(time_ms=2, price=100.0, side="sell", size=8),  # -5
        FootprintTick(time_ms=3, price=100.0, side="buy", size=4),   # -1
    ]
    fp = build_footprint_bar(_bar(o=100.0, h=100.0, low=100.0, c=100.0), ticks, 1.0)
    assert fp.max_delta == 3
    assert fp.min_delta == -5
    assert fp.delta_value == -1
    assert fp.sum_delta == 8          # |−5| + |3|
    assert fp.subtract_delta == -8    # min − max


def test_value_area_brackets_the_poc():
    ticks = []
    # heavy at 101, lighter either side
    for _ in range(20):
        ticks.append(FootprintTick(time_ms=1, price=101.0, side="buy"))
    for _ in range(5):
        ticks.append(FootprintTick(time_ms=2, price=102.0, side="buy"))
    for _ in range(3):
        ticks.append(FootprintTick(time_ms=3, price=100.0, side="sell"))
    fp = build_footprint_bar(_bar(o=100.0, h=102.0, low=100.0, c=101.0), ticks, 1.0)
    assert fp.poc_price == 101.0
    assert fp.val_price <= fp.poc_price <= fp.vah_price


def test_empty_bar_is_empty_not_invented():
    fp = build_footprint_bar(_bar(), [], 1.0)
    assert fp.normal_value == 0
    assert fp.poc_price is None
    assert all(r.total == 0 for r in fp.rows)


def test_ticks_are_bucketed_into_the_correct_bar():
    bars = [_bar(t=1000), _bar(t=2000), _bar(t=3000)]
    ticks = [
        FootprintTick(time_ms=1500, price=100.0, side="buy", size=2),
        FootprintTick(time_ms=2500, price=100.0, side="buy", size=4),
        FootprintTick(time_ms=2999, price=100.0, side="sell", size=1),
        FootprintTick(time_ms=3200, price=100.0, side="buy", size=9),
        FootprintTick(time_ms=10, price=100.0, side="buy", size=99),  # before: dropped
    ]
    fps = build_footprint(bars, ticks, 1.0)
    assert [f.normal_value for f in fps] == [2, 5, 9]


def test_suggest_row_height_snaps_to_clean_steps():
    bars = [_bar(o=100, h=112, low=100) for _ in range(5)]   # range 12
    assert suggest_row_height(bars, target_rows=12) == 1.0
    tiny = [{"time_ms": 0, "open": 1.1, "high": 1.1012, "low": 1.1, "close": 1.1}] * 5
    h = suggest_row_height(tiny, target_rows=12)
    assert 0 < h < 0.001
    assert str(h).lstrip("0.").rstrip("0")[:1] in {"1", "2", "5"}
