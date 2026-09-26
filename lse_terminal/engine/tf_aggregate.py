"""Timeframe aggregation for /api/candles.

Providers serve a fixed ladder of native timeframes (1m, 5m, ... 1w). This
module builds the resolutions they DON'T serve natively — custom multiples
(45m, 2h, 8h) and calendar months (1M, 3M, 6M, 1Y) — by resampling a finer
native timeframe up to the requested one.

Contract that keeps it honest:
  * Native timeframes never reach here; the endpoint passes them straight to
    the provider, so existing behaviour is byte-for-byte unchanged.
  * Every output bar is real OHLCV aggregated from real base bars
    (open=first, high=max, low=min, close=last, volume=sum). Nothing is
    invented, so a button in the timeframe menu never draws a fake candle.
  * If no native base can build the target, pick_base() returns None and the
    caller lets the provider raise its ordinary "unsupported timeframe" error
    rather than fabricating data.
"""

from __future__ import annotations

import re

import pandas as pd

_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}


def parse_timeframe(tf: str):
    """Classify a timeframe string.

    Returns ("fixed", seconds) for sub-monthly steps (s/m/h/d/w — lower-case
    'm' is minutes), ("month", n_months) for calendar spans (capital 'M', or
    a year suffix), or None for anything unrecognised.
    """
    s = str(tf or "").strip()
    m = re.fullmatch(r"(\d+)\s*([smhdw])", s)      # lower-case units: sub-monthly
    if m:
        return ("fixed", int(m.group(1)) * _UNIT_SECONDS[m.group(2)])
    m = re.fullmatch(r"(\d+)\s*M", s)              # capital M: calendar months
    if m:
        return ("month", int(m.group(1)))
    m = re.fullmatch(r"(\d+)\s*[yY]", s)           # years -> months
    if m:
        return ("month", int(m.group(1)) * 12)
    return None


def _tf_seconds(tf: str) -> int:
    p = parse_timeframe(tf)
    return p[1] if (p and p[0] == "fixed") else 0


def pick_base(target: str, natives: list[str]) -> str | None:
    """Choose the native timeframe to aggregate up from.

    Fixed target: the largest native that divides it evenly, else the largest
    native that fits below it (floor-bucketed). Month target: prefer 1d, then
    1w, else the coarsest available native.
    """
    parsed = parse_timeframe(target)
    if not parsed:
        return None
    kind, val = parsed

    fixed = sorted(
        (s, t) for t in natives for s in (_tf_seconds(t),) if s > 0
    )
    if not fixed:
        return None

    if kind == "month":
        for pref in ("1d", "1w"):
            if pref in natives:
                return pref
        return fixed[-1][1]

    exact = [(s, t) for s, t in fixed if s <= val and val % s == 0]
    if exact:
        return exact[-1][1]
    below = [(s, t) for s, t in fixed if s <= val]
    if below:
        return below[-1][1]
    return None


def aggregate(df: pd.DataFrame, target: str) -> pd.DataFrame:
    """Resample base OHLCV bars up to `target`.

    `df` has columns ts (epoch seconds), open, high, low, close, volume.
    Returns the same shape at the coarser resolution, oldest-first.
    """
    parsed = parse_timeframe(target)
    if df is None or not len(df) or not parsed:
        return df
    kind, val = parsed
    d = df.sort_values("ts").reset_index(drop=True).copy()

    if kind == "fixed":
        d["bucket_ts"] = (d["ts"] // val) * val
    else:
        dt = pd.to_datetime(d["ts"], unit="s", utc=True)
        period = dt.dt.year * 12 + (dt.dt.month - 1)      # months since year 0
        pk = period // val
        base_month = pk * val
        years = (base_month // 12).astype(int)
        months = (base_month % 12 + 1).astype(int)
        starts = pd.to_datetime(
            pd.DataFrame({"year": years, "month": months, "day": 1}), utc=True
        )
        # tz-aware .astype(int64) is unit-dependent across pandas versions;
        # Timestamp.timestamp() is unambiguous epoch seconds.
        d["bucket_ts"] = starts.map(lambda t: int(t.timestamp())).values

    g = d.groupby("bucket_ts", sort=True)
    out = g.agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    ).reset_index().rename(columns={"bucket_ts": "ts"})
    out["ts"] = out["ts"].astype("int64")
    return out[["ts", "open", "high", "low", "close", "volume"]].reset_index(drop=True)
