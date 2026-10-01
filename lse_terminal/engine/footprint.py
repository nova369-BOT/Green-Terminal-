"""Order-flow footprint engine (tick-derived).

Builds a price-by-price buy/sell breakdown for each OHLC bar from a stream of
ticks, plus the aggregate values the chart draws beneath/above each candle.

WHAT THIS IS, HONESTLY
----------------------
Spot FX/CFD markets are decentralised: there is no central tape, so there is
no exchange-reported traded volume and no exchange-reported aggressor side.
This engine therefore derives both from TICK ACTIVITY using the classic tick
rule (uptick = buyer-initiated, downtick = seller-initiated). That is an
ESTIMATE, not exchange truth, and every surface that renders it must say so.

Published accuracy of that approach, for the record:
  * tick volume vs real traded volume on FX majors: ~0.85-0.90 correlation
  * tick rule aggressor classification: ~72-80% correct
It is good enough to trade from - which is why every FX footprint product
works this way - but it is not the real tape, and we never claim it is.

Where a venue DOES publish real trades with a real aggressor flag (e.g. a
crypto exchange feed), feed those in via ``FootprintTick.side`` and the
estimate is replaced by fact - see ``classify`` below.

ALGORITHM PROVENANCE
--------------------
The row segmentation and buy/sell/delta accumulation follow "Order Flow Ticks"
by srlcarlg, Apache License 2.0:
    https://github.com/srlcarlg/srl-python-indicators  (order_flow_ticks.py)
    https://github.com/srlcarlg/srl-ctrader-indicators (C# twin)
Ported to a dependency-free, incremental-friendly form for Green Terminal.
Behavioural quirks of the original are preserved deliberately and marked
"srl parity" so the output matches the reference implementation.

This module is PURE: no I/O, no network, no globals. It is unit-testable and
safe to call from a request handler or a live stream consumer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

__all__ = [
    "FootprintTick",
    "FootprintRow",
    "FootprintBar",
    "build_segments",
    "build_footprint_bar",
    "build_footprint",
    "suggest_row_height",
]


# ── Inputs ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FootprintTick:
    """One price observation.

    ``side`` is optional. Leave it None for quote/tick feeds (FX, CFDs) and the
    tick rule infers it. Set it to 'buy'/'sell' only when the venue publishes a
    real aggressor flag, in which case no inference happens at all.
    """
    time_ms: int
    price: float
    side: Optional[str] = None      # 'buy' | 'sell' | None (infer)
    size: float = 1.0               # real size when known; 1.0 = tick count


@dataclass
class FootprintRow:
    """One price level inside a bar."""
    price: float
    buy: float = 0.0
    sell: float = 0.0

    @property
    def total(self) -> float:
        return self.buy + self.sell

    @property
    def delta(self) -> float:
        return self.buy - self.sell

    def to_dict(self) -> dict:
        return {
            "price": self.price,
            "buy": self.buy,
            "sell": self.sell,
            "total": self.total,
            "delta": self.delta,
        }


@dataclass
class FootprintBar:
    """A bar's full footprint plus the aggregates drawn around the candle."""
    time_ms: int
    open: float
    high: float
    low: float
    close: float
    row_height: float
    rows: list[FootprintRow] = field(default_factory=list)

    # aggregates (names mirror the reference implementation)
    normal_value: float = 0.0       # total ticks/volume in the bar
    value_buy: float = 0.0
    value_sell: float = 0.0
    value_sum: float = 0.0          # buy + sell
    value_subtract: float = 0.0     # buy - sell
    value_divide: float = 0.0       # buy / sell, 0 when either side is empty
    delta_value: float = 0.0        # sum of per-row deltas
    min_delta: float = 0.0
    max_delta: float = 0.0
    subtract_delta: float = 0.0     # min - max  (srl parity)
    sum_delta: float = 0.0          # |min| + |max|
    delta_buy_value: float = 0.0    # sum of positive row deltas
    delta_sell_value: float = 0.0   # sum of negative row deltas
    delta_buy_pct: float = 0.0
    delta_sell_pct: float = 0.0
    delta_divide: float = 0.0

    # profile marks
    poc_price: Optional[float] = None   # row with the most volume
    vah_price: Optional[float] = None   # value-area high
    val_price: Optional[float] = None   # value-area low

    # provenance, so the UI can label the bar honestly
    inferred: bool = True           # True when the tick rule classified sides

    def to_dict(self) -> dict:
        return {
            "time_ms": self.time_ms,
            "open": self.open, "high": self.high,
            "low": self.low, "close": self.close,
            "row_height": self.row_height,
            "rows": [r.to_dict() for r in self.rows],
            "normal_value": self.normal_value,
            "value_buy": self.value_buy,
            "value_sell": self.value_sell,
            "value_sum": self.value_sum,
            "value_subtract": self.value_subtract,
            "value_divide": self.value_divide,
            "delta_value": self.delta_value,
            "min_delta": self.min_delta,
            "max_delta": self.max_delta,
            "subtract_delta": self.subtract_delta,
            "sum_delta": self.sum_delta,
            "delta_buy_value": self.delta_buy_value,
            "delta_sell_value": self.delta_sell_value,
            "delta_buy_pct": self.delta_buy_pct,
            "delta_sell_pct": self.delta_sell_pct,
            "delta_divide": self.delta_divide,
            "poc_price": self.poc_price,
            "vah_price": self.vah_price,
            "val_price": self.val_price,
            "inferred": self.inferred,
        }


# ── Row segmentation ────────────────────────────────────────────────────────

def build_segments(open_: float, high: float, low: float, row_height: float) -> list[float]:
    """Price rows for one bar.

    Rows are anchored on the bar's OPEN and stepped outward by ``row_height``
    until they cover low..high (one row of padding each way, srl parity), then
    sorted ascending. Anchoring on the open - rather than on a global grid -
    is what makes each bar's rows line up with its own body.
    """
    if row_height <= 0:
        raise ValueError("row_height must be greater than 0")
    if high < low:
        raise ValueError("high must be >= low")

    segments: list[float] = []

    # downward from the open
    seg = open_
    while seg >= (low - row_height):
        segments.append(round(seg, 10))
        seg -= row_height
    # upward from the open (open itself is re-added, deduped below)
    seg = open_
    while seg <= (high + row_height):
        segments.append(round(seg, 10))
        seg += row_height

    # The reference keeps duplicates and relies on sort order; we dedupe so a
    # row can never be counted twice, which would double-count volume.
    return sorted(set(segments))


def _row_index(segments: Sequence[float], price: float) -> int:
    """Index of the row that ``price`` falls in.

    Mirrors the reference test ``price >= segments[i-1] and price <= segments[i]``
    but via binary search instead of a linear scan, so a bar with thousands of
    ticks is O(n log m) rather than O(n*m). Prices outside the range clamp to
    the nearest row (ticks can print beyond the bar's own high/low on the
    boundary between bars).
    """
    lo, hi = 0, len(segments) - 1
    if price <= segments[0]:
        return 0
    if price >= segments[hi]:
        return hi
    while lo < hi:
        mid = (lo + hi) // 2
        if segments[mid] < price:
            lo = mid + 1
        else:
            hi = mid
    return lo


# ── Core build ──────────────────────────────────────────────────────────────

def build_footprint_bar(
    bar: dict,
    ticks: Sequence[FootprintTick],
    row_height: float,
    *,
    value_area_pct: float = 0.70,
) -> FootprintBar:
    """Footprint for a single bar from the ticks that fall inside it.

    ``bar`` needs: time_ms, open, high, low, close. ``ticks`` must already be
    restricted to this bar's window and be in chronological order - the tick
    rule compares each tick with the one before it, so order is significant.
    """
    fp = FootprintBar(
        time_ms=int(bar["time_ms"]),
        open=float(bar["open"]), high=float(bar["high"]),
        low=float(bar["low"]), close=float(bar["close"]),
        row_height=row_height,
    )
    segments = build_segments(fp.open, fp.high, fp.low, row_height)
    fp.rows = [FootprintRow(price=p) for p in segments]
    if not ticks:
        return fp

    any_inferred = False
    prev_price: Optional[float] = None
    running_delta = 0.0
    min_delta = 0.0
    max_delta = 0.0

    for t in ticks:
        idx = _row_index(segments, t.price)
        row = fp.rows[idx]
        size = t.size if t.size else 1.0

        side = t.side
        if side is None:
            any_inferred = True
            if prev_price is None or t.price == prev_price:
                # srl parity: an unchanged tick credits BOTH sides, so it adds
                # volume without biasing delta. The very first tick of a bar
                # has no predecessor and is treated the same way.
                row.buy += size
                row.sell += size
                prev_price = t.price
                continue
            side = "buy" if t.price > prev_price else "sell"

        if side == "buy":
            row.buy += size
            running_delta += size
        else:
            row.sell += size
            running_delta -= size

        if running_delta < min_delta:
            min_delta = running_delta
        if running_delta > max_delta:
            max_delta = running_delta
        prev_price = t.price

    _finalise(fp, min_delta, max_delta, value_area_pct)
    fp.inferred = any_inferred
    return fp


def _finalise(fp: FootprintBar, min_delta: float, max_delta: float,
              value_area_pct: float) -> None:
    """Aggregates + POC/value area. Separated so it stays testable."""
    fp.value_buy = sum(r.buy for r in fp.rows)
    fp.value_sell = sum(r.sell for r in fp.rows)
    fp.normal_value = fp.value_buy + fp.value_sell
    fp.value_sum = fp.value_buy + fp.value_sell
    fp.value_subtract = fp.value_buy - fp.value_sell
    fp.value_divide = (round(fp.value_buy / fp.value_sell, 3)
                       if fp.value_buy and fp.value_sell else 0.0)

    fp.delta_value = sum(r.delta for r in fp.rows)
    fp.min_delta = min_delta
    fp.max_delta = max_delta
    fp.subtract_delta = min_delta - max_delta
    fp.sum_delta = abs(min_delta) + abs(max_delta)

    fp.delta_buy_value = sum(r.delta for r in fp.rows if r.delta > 0)
    fp.delta_sell_value = sum(r.delta for r in fp.rows if r.delta < 0)
    denom = max(1.0, fp.delta_buy_value + abs(fp.delta_sell_value))
    fp.delta_buy_pct = round(fp.delta_buy_value * 100 / denom)
    fp.delta_sell_pct = round(fp.delta_sell_value * 100 / denom)
    fp.delta_divide = (round(fp.delta_buy_value / abs(fp.delta_sell_value), 3)
                       if fp.delta_buy_value and fp.delta_sell_value else 0.0)

    traded = [r for r in fp.rows if r.total > 0]
    if not traded:
        return

    poc = max(traded, key=lambda r: r.total)
    fp.poc_price = poc.price

    # Value area: expand out from the POC, each step taking the heavier
    # neighbour, until the target share of volume is covered.
    total = sum(r.total for r in fp.rows)
    target = total * value_area_pct
    i = j = fp.rows.index(poc)
    covered = poc.total
    while covered < target and (i > 0 or j < len(fp.rows) - 1):
        below = fp.rows[i - 1].total if i > 0 else -1.0
        above = fp.rows[j + 1].total if j < len(fp.rows) - 1 else -1.0
        if above >= below:
            j += 1
            covered += max(above, 0.0)
        else:
            i -= 1
            covered += max(below, 0.0)
    fp.val_price = fp.rows[i].price
    fp.vah_price = fp.rows[j].price


def build_footprint(
    bars: Sequence[dict],
    ticks: Iterable[FootprintTick],
    row_height: float,
    *,
    value_area_pct: float = 0.70,
) -> list[FootprintBar]:
    """Footprints for a series of bars.

    Each tick is assigned to the bar whose window contains it: a bar spans from
    its own time_ms up to (not including) the next bar's. Ticks are bucketed in
    one pass, so this is O(ticks + bars) rather than re-scanning per bar.
    """
    ordered = sorted(bars, key=lambda b: int(b["time_ms"]))
    if not ordered:
        return []

    buckets: list[list[FootprintTick]] = [[] for _ in ordered]
    starts = [int(b["time_ms"]) for b in ordered]

    for t in sorted(ticks, key=lambda x: x.time_ms):
        if t.time_ms < starts[0]:
            continue
        lo, hi = 0, len(starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if starts[mid] <= t.time_ms:
                lo = mid
            else:
                hi = mid - 1
        buckets[lo].append(t)

    return [
        build_footprint_bar(b, buckets[i], row_height, value_area_pct=value_area_pct)
        for i, b in enumerate(ordered)
    ]


def suggest_row_height(bars: Sequence[dict], target_rows: int = 12) -> float:
    """A sensible default row height for an instrument.

    Picks a height that gives roughly ``target_rows`` rows on a typical bar,
    based on the median bar range, then snaps it to a clean 1/2/5 x 10^n step
    so the price ladder reads in round numbers instead of 0.3714.
    """
    ranges = sorted(float(b["high"]) - float(b["low"]) for b in bars
                    if float(b["high"]) > float(b["low"]))
    if not ranges:
        return 1.0
    median = ranges[len(ranges) // 2]
    raw = median / max(1, target_rows)
    if raw <= 0:
        return 1.0

    exp = 0
    scaled = raw
    while scaled < 1:
        scaled *= 10
        exp -= 1
    while scaled >= 10:
        scaled /= 10
        exp += 1
    step = 1 if scaled < 1.5 else 2 if scaled < 3.5 else 5 if scaled < 7.5 else 10
    return step * (10.0 ** exp)
