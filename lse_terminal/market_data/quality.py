"""Data-quality checks before events reach major consumers.

Never invents replacement values — returns a verdict so callers can drop,
flag, or surface the event honestly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .types import NormalizedCandle, NormalizedQuote, NormalizedTrade


@dataclass
class DataQualityReport:
    ok: bool = True
    codes: list[str] = field(default_factory=list)
    detail: str = ""

    def fail(self, code: str, detail: str = "") -> None:
        self.ok = False
        self.codes.append(code)
        if detail and not self.detail:
            self.detail = detail


def validate_candle(c: NormalizedCandle, *, prev: Optional[NormalizedCandle] = None) -> DataQualityReport:
    r = DataQualityReport()
    if c.open <= 0 or c.high <= 0 or c.low <= 0 or c.close <= 0:
        r.fail("non_positive_price", "OHLC must be > 0 for market data")
    if c.high < c.low:
        r.fail("high_lt_low")
    if c.high < max(c.open, c.close):
        r.fail("high_below_body")
    if c.low > min(c.open, c.close):
        r.fail("low_above_body")
    if c.volume < 0:
        r.fail("negative_volume")
    if c.timestamp_ms <= 0:
        r.fail("bad_timestamp")
    if prev is not None:
        if c.timestamp_ms == prev.timestamp_ms:
            r.fail("duplicate_timestamp")
        elif c.timestamp_ms < prev.timestamp_ms:
            r.fail("timestamp_regression")
    return r


def validate_quote(q: NormalizedQuote) -> DataQualityReport:
    r = DataQualityReport()
    if q.bid is not None and q.ask is not None:
        if q.bid > 0 and q.ask > 0 and q.bid > q.ask:
            r.fail("crossed_book", "bid > ask")
    for name, v in (("bid", q.bid), ("ask", q.ask), ("last", q.last)):
        if v is not None and v < 0:
            r.fail("negative_price", name)
    if q.timestamp_ms <= 0:
        r.fail("bad_timestamp")
    return r


def validate_tick(t: NormalizedTrade) -> DataQualityReport:
    r = DataQualityReport()
    if t.price <= 0:
        r.fail("non_positive_price")
    if t.size < 0:
        r.fail("negative_size")
    if t.timestamp_ms <= 0:
        r.fail("bad_timestamp")
    if t.side is not None and t.side not in ("buy", "sell"):
        r.fail("bad_side")
    return r


def is_stale(timestamp_ms: int, *, now_ms: int, max_age_ms: int) -> bool:
    if timestamp_ms <= 0:
        return True
    return (now_ms - timestamp_ms) > max_age_ms
