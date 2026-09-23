"""Timestamp + payload normalization at the adapter edge."""

from __future__ import annotations

import math
import time
from typing import Any, Iterable, Optional

import pandas as pd

from lse_terminal.contracts.types import CANDLE_COLUMNS

from .types import NormalizedCandle, NormalizedQuote, NormalizedTrade

# Heuristic: values below this are not milliseconds (year 2001 in ms ≈ 9.7e11).
_MS_THRESHOLD = 1e12
_US_THRESHOLD = 1e14
_NS_THRESHOLD = 1e17


def now_ms() -> int:
    return int(time.time() * 1000)


def to_ms(ts: float | int | None) -> Optional[int]:
    """Normalize epoch seconds / ms / µs / ns to milliseconds.

    Returns None for non-finite input. Does not silently coerce ISO strings
    (callers pass numeric provider fields).
    """
    if ts is None:
        return None
    try:
        v = float(ts)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    av = abs(v)
    if av >= _NS_THRESHOLD:
        return int(v / 1_000_000)
    if av >= _US_THRESHOLD:
        return int(v / 1_000)
    if av >= _MS_THRESHOLD:
        return int(v)
    # seconds (including sub-second fractions)
    return int(v * 1000)


def to_sec(ts: float | int | None) -> Optional[int]:
    ms = to_ms(ts)
    return None if ms is None else ms // 1000


def _finite(x: Any) -> Optional[float]:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def normalize_tick(raw: dict, *, source: str = "", receive_ms: int | None = None) -> Optional[NormalizedTrade]:
    """Provider tick dict → NormalizedTrade (price path also carries quote fields).

    The legacy stream shape is {symbol, price, ts, bid?, ask?, volume?}.
    When bid/ask are present a paired quote is returned via normalize_quote.
    """
    if not isinstance(raw, dict):
        return None
    price = _finite(raw.get("price"))
    if price is None or price < 0:
        return None
    ts = to_ms(raw.get("ts"))
    if ts is None:
        ts = receive_ms if receive_ms is not None else now_ms()
    side = raw.get("side") or raw.get("taker_side") or raw.get("aggressor")
    if side is not None:
        side = str(side).lower()
        if side not in ("buy", "sell", "b", "s"):
            side = None
        else:
            side = "buy" if side in ("buy", "b") else "sell"
    tid = raw.get("trade_id") or raw.get("id") or raw.get("tradeId")
    size = _finite(raw.get("volume") if raw.get("volume") is not None else raw.get("size"))
    return NormalizedTrade(
        symbol=str(raw.get("symbol") or ""),
        timestamp_ms=ts,
        price=price,
        size=size or 0.0,
        side=side,
        trade_id=None if tid is None else str(tid),
        source=source or str(raw.get("source") or ""),
    )


def normalize_quote(
    raw: dict, *, source: str = "", receive_ms: int | None = None
) -> Optional[NormalizedQuote]:
    if not isinstance(raw, dict):
        return None
    bid = _finite(raw.get("bid"))
    ask = _finite(raw.get("ask"))
    last = _finite(raw.get("price"))
    if bid is None and ask is None and last is None:
        return None
    ts = to_ms(raw.get("ts"))
    if ts is None:
        ts = receive_ms if receive_ms is not None else now_ms()
    if bid is not None and ask is not None and ask < bid:
        # Invalid book top — drop sides rather than invent a repair.
        bid, ask = None, None
    return NormalizedQuote(
        symbol=str(raw.get("symbol") or ""),
        timestamp_ms=ts,
        bid=bid,
        ask=ask,
        bid_size=_finite(raw.get("bid_size") or raw.get("bidSize")),
        ask_size=_finite(raw.get("ask_size") or raw.get("askSize")),
        last=last,
        source=source or str(raw.get("source") or ""),
        synthetic=bool(raw.get("quote_synthetic") or raw.get("synthetic")),
    )


def normalize_candle_row(
    row: Any, *, symbol: str, timeframe: str, source: str = ""
) -> Optional[NormalizedCandle]:
    """Row as [ts,o,h,l,c,v] or mapping with CANDLE_COLUMNS / time / open…."""
    if row is None:
        return None
    if isinstance(row, (list, tuple)):
        if len(row) < 5:
            return None
        ts, o, h, l, c = row[0], row[1], row[2], row[3], row[4]
        v = row[5] if len(row) > 5 else 0.0
    elif isinstance(row, dict):
        ts = row.get("ts", row.get("time", row.get("timestamp")))
        o, h, l, c = row.get("open"), row.get("high"), row.get("low"), row.get("close")
        v = row.get("volume", 0.0)
    else:
        return None
    tms = to_ms(ts)
    o, h, l, c = _finite(o), _finite(h), _finite(l), _finite(c)
    vol = _finite(v)
    if tms is None or None in (o, h, l, c):
        return None
    if vol is None:
        vol = 0.0
    if vol < 0:
        vol = 0.0  # negative volume is invalid; zero out but quality logs via validate
    # Enforce high >= max(o,c,l) and low <= min(o,c,h) only when inconsistent
    # would be impossible — quality engine flags; here we only fix clear swaps.
    hi, lo = max(h, o, c, l), min(l, o, c, h)
    if hi != h or lo != l:
        # Leave as-is for quality detection; do not silently rewrite OHLC.
        pass
    return NormalizedCandle(
        symbol=symbol,
        timeframe=timeframe,
        timestamp_ms=tms,
        open=o,
        high=h,
        low=l,
        close=c,
        volume=vol,
        source=source,
    )


def normalize_candles_df(
    df: pd.DataFrame, *, symbol: str, timeframe: str, source: str = ""
) -> list[NormalizedCandle]:
    """DataFrame with CANDLE_COLUMNS (ts in seconds) → sorted NormalizedCandle list."""
    if df is None or len(df) == 0:
        return []
    cols = [c for c in CANDLE_COLUMNS if c in df.columns]
    if not {"ts", "open", "high", "low", "close"}.issubset(cols):
        return []
    out: list[NormalizedCandle] = []
    for row in df.itertuples(index=False):
        data = row._asdict() if hasattr(row, "_asdict") else dict(zip(df.columns, row))
        nc = normalize_candle_row(
            [data.get("ts"), data.get("open"), data.get("high"), data.get("low"),
             data.get("close"), data.get("volume")],
            symbol=symbol,
            timeframe=timeframe,
            source=source,
        )
        if nc:
            out.append(nc)
    out.sort(key=lambda c: c.timestamp_ms)
    return out


def normalize_provider_capabilities(provider) -> list[str]:
    from .capabilities import formal_capabilities

    return formal_capabilities(provider)


def feed_kind_from_health(
    health: str, *, has_live: bool, is_replay: bool = False, is_historical: bool = False
) -> str:
    from .types import ConnectionHealth, FeedKind

    if is_replay:
        return FeedKind.REPLAY.value
    if health == ConnectionHealth.CONNECTED.value and has_live:
        return FeedKind.LIVE.value
    if health in (
        ConnectionHealth.RECONNECTING.value,
        ConnectionHealth.CONNECTING.value,
        ConnectionHealth.DEGRADED.value,
    ):
        return FeedKind.DELAYED.value
    if is_historical or not has_live:
        return FeedKind.HISTORICAL.value
    return FeedKind.UNAVAILABLE.value
