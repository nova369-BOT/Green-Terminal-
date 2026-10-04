"""Tests for the timeframe aggregation used by /api/candles.

Custom (45m, 2h, 8h) and calendar (1M, 3M, 6M, 1Y) resolutions are built by
resampling a finer native timeframe. These checks pin the parser, base
selection, calendar-aligned bucket starts and correct OHLCV rollup.
"""

import numpy as np
import pandas as pd

from lse_terminal.engine.tf_aggregate import (
    aggregate,
    parse_timeframe,
    pick_base,
)

NATIVE = ["tick", "1s", "5s", "15s", "30s", "1m", "3m", "5m",
          "15m", "30m", "1h", "4h", "1d", "1w"]


def test_parse_timeframe():
    assert parse_timeframe("45m") == ("fixed", 45 * 60)
    assert parse_timeframe("2h") == ("fixed", 2 * 3600)
    assert parse_timeframe("1M") == ("month", 1)
    assert parse_timeframe("6M") == ("month", 6)
    assert parse_timeframe("1Y") == ("month", 12)
    assert parse_timeframe("1y") == ("month", 12)
    assert parse_timeframe("garbage") is None


def test_pick_base_fixed_prefers_largest_exact_divisor():
    assert pick_base("45m", NATIVE) == "15m"   # 45 = 3 * 15
    assert pick_base("2h", NATIVE) == "1h"
    assert pick_base("8h", NATIVE) == "4h"


def test_pick_base_month_prefers_daily():
    assert pick_base("1M", NATIVE) == "1d"
    assert pick_base("3M", NATIVE) == "1d"
    assert pick_base("1M", ["1w", "1h"]) == "1w"


def _daily(n, start="2023-01-01"):
    s = pd.Timestamp(start, tz="UTC")
    ts = [int((s + pd.Timedelta(days=i)).timestamp()) for i in range(n)]
    o = np.linspace(100, 100 + n, n)
    return pd.DataFrame(
        {"ts": ts, "open": o, "high": o + 2, "low": o - 2, "close": o + 1,
         "volume": np.ones(n)}
    )


def test_monthly_buckets_are_calendar_aligned():
    df = _daily(400)
    m = aggregate(df, "1M")
    starts = pd.to_datetime(m["ts"], unit="s", utc=True).dt.strftime("%Y-%m-%d").tolist()
    assert starts[:3] == ["2023-01-01", "2023-02-01", "2023-03-01"]
    # First month = January (31 days): O=first day open, volume=sum of 31.
    assert m.iloc[0]["volume"] == 31
    assert m.iloc[0]["open"] == df.iloc[0]["open"]


def test_quarter_and_half_year_alignment():
    df = _daily(400)
    q = pd.to_datetime(aggregate(df, "3M")["ts"], unit="s", utc=True)
    assert q.dt.strftime("%Y-%m-%d").tolist()[:2] == ["2023-01-01", "2023-04-01"]
    h = pd.to_datetime(aggregate(df, "6M")["ts"], unit="s", utc=True)
    assert h.dt.strftime("%Y-%m-%d").tolist()[:2] == ["2023-01-01", "2023-07-01"]


def test_fixed_rollup_ohlc():
    # 20 bars of 15m -> 45m should give 7 buckets (3 per bucket, last partial).
    s = pd.Timestamp("2023-01-01", tz="UTC")
    ts = [int((s + pd.Timedelta(minutes=15 * i)).timestamp()) for i in range(20)]
    df = pd.DataFrame(
        {"ts": ts, "open": range(20), "high": range(20), "low": range(20),
         "close": range(20), "volume": [1] * 20}
    )
    out = aggregate(df, "45m")
    assert len(out) == 7
    # First bucket rolls up bars 0,1,2: open=first, high=max, low=min, close=last.
    assert out.iloc[0]["open"] == 0
    assert out.iloc[0]["high"] == 2
    assert out.iloc[0]["low"] == 0
    assert out.iloc[0]["close"] == 2
    assert out.iloc[0]["volume"] == 3


def test_unknown_timeframe_is_passthrough():
    df = _daily(10)
    assert aggregate(df, "garbage") is df
