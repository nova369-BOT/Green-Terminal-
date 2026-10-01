"""Public Binance depth provider for the verified DOM workspace."""
from __future__ import annotations

import pandas as pd

from lse_terminal.contracts import Instrument, Provider
from lse_terminal.engine.feeds.binance import fetch_klines, normalise_symbol
from lse_terminal.engine.feeds.binance_depth_stream import BinanceDepthStream


class BinanceDepthProvider(Provider):
    name = "binance-depth"
    title = "Binance Spot (L2 depth)"
    timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"]
    FORMAL_CAPABILITIES = {"SEARCH", "OHLCV", "HISTORICAL_BARS", "TRADES", "WEBSOCKET", "L1_QUOTES", "L2"}

    def search(self, query: str = "", limit: int = 50) -> list[Instrument]:
        # This catalog is intentionally conservative. A symbol becomes
        # selectable only when it is explicitly listed, never by guessing.
        catalog = [
            ("BTCUSDT", "Bitcoin / Tether", "Crypto"),
            ("ETHUSDT", "Ether / Tether", "Crypto"),
            ("BNBUSDT", "BNB / Tether", "Crypto"),
            ("SOLUSDT", "Solana / Tether", "Crypto"),
        ]
        q = query.upper().replace("/", "")
        return [Instrument(symbol=s, name=n, category=c, provider=self.name, meta={"venue": "Binance Spot", "product_type": "spot"})
                for s, n, c in catalog if not q or q in s or q in n.upper()][:limit]

    def candles(self, symbol: str, timeframe: str, limit: int = 500, start=None, end=None) -> pd.DataFrame:
        rows = fetch_klines(normalise_symbol(symbol), timeframe, limit=limit)
        return pd.DataFrame(rows, columns=["time_ms", "open", "high", "low", "close", "volume"])

    async def stream(self, symbols: list[str]):
        # One stream per subscribed symbol; the hub currently expects one
        # provider iterator, so multiplex them and tag every event naturally.
        streams = [BinanceDepthStream(s).events() for s in symbols]
        tasks = {__import__('asyncio').create_task(stream.__anext__()): stream for stream in streams}
        try:
            while tasks:
                done, _ = await __import__('asyncio').wait(tasks, return_when=__import__('asyncio').FIRST_COMPLETED)
                for task in done:
                    stream = tasks.pop(task)
                    try:
                        yield task.result()
                        tasks[__import__('asyncio').create_task(stream.__anext__())] = stream
                    except StopAsyncIteration:
                        pass
        finally:
            for task in tasks: task.cancel()
            for stream in streams: await stream.aclose()
