import asyncio

import pytest

from lse_terminal.providers import DemoProvider
from lse_terminal.testing import check_provider


def test_demo_passes_compliance_harness():
    assert check_provider(DemoProvider()) == []


def test_search_filters():
    p = DemoProvider()
    assert len(p.search("")) == 6
    btc = p.search("btc")
    assert [i.symbol for i in btc] == ["DEMO:BTC"]
    assert p.search("zzz-no-match") == []


def test_candles_shape_and_limit():
    p = DemoProvider()
    df = p.candles("DEMO:SPX", "1h", limit=123)
    assert len(df) == 123
    assert (df["high"] >= df["close"]).all()
    assert (df["low"] <= df["close"]).all()
    # 1h grid: bar opens are aligned to 3600s
    assert (df["ts"] % 3600 == 0).all()


def test_unknown_symbol_and_timeframe():
    p = DemoProvider()
    with pytest.raises(ValueError):
        p.candles("NOPE", "1h")
    with pytest.raises(ValueError):
        p.candles("DEMO:BTC", "7h")


def test_stream_emits_ticks():
    async def take_three():
        agen = DemoProvider().stream(["DEMO:BTC", "DEMO:VIX"])
        ticks = []
        async for t in agen:
            ticks.append(t)
            if len(ticks) >= 3:
                break
        await agen.aclose()
        return ticks

    ticks = asyncio.run(take_three())
    assert all(t["symbol"] in ("DEMO:BTC", "DEMO:VIX") for t in ticks)
    assert all(t["price"] > 0 for t in ticks)


def test_timeframes_share_one_price_level():
    """One symbol = one current price, on every timeframe.

    The walks used to be start-anchored, so each timeframe's cumulative
    wander ended at its own level (1s ended ~10x away from 1h for BTC).
    Switching the chart to seconds then showed a price cliff between
    history and the live quote — exposed the day Real-time mode started
    switching charts to 1s. Walks are end-anchored at the symbol's base
    price now; shapes still differ per timeframe, the level is shared.
    """
    from lse_terminal.providers.demo import DemoProvider, _UNIVERSE

    p = DemoProvider()
    base = _UNIVERSE["DEMO:BTC"][2]
    finals = {}
    for tf in ("1s", "5s", "1m", "1h", "1d"):
        df = p.candles("DEMO:BTC", tf, limit=5)
        finals[tf] = float(df.iloc[-1]["close"])
    for tf, close in finals.items():
        assert close == pytest.approx(base), (tf, close)
    # The live tick stream continues the same level, whichever walk ran first.
    assert p.quote("DEMO:BTC").price == pytest.approx(base)
