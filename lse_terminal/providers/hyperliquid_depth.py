"""Public Hyperliquid Perp provider — verified L2 + trades fallback venue.

Registered so order-flow widgets can fail over from Binance when that venue
is unreachable: the hub sees one more normal provider, widgets resolve the
venue via resolveFlowSource, and every event is venue-tagged. Nothing is
simulated — a dead HL upstream produces honest DEPTH_RESET frames exactly
like the Binance path.
"""
from __future__ import annotations

import asyncio
import logging

import pandas as pd

from lse_terminal.contracts import Instrument, Provider
from lse_terminal.engine.feeds.hyperliquid_stream import (
    HyperliquidStream,
    fetch_candles,
    normalise_coin,
)

log = logging.getLogger(__name__)


class HyperliquidDepthProvider(Provider):
    name = "hyperliquid"
    title = "Hyperliquid Perp (L2 depth)"
    timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"]
    FORMAL_CAPABILITIES = {"SEARCH", "OHLCV", "HISTORICAL_BARS", "TRADES",
                           "WEBSOCKET", "L1_QUOTES", "L2"}

    def search(self, query: str = "", limit: int = 50) -> list[Instrument]:
        # Conservative verified-perp catalog: these coins are listed on
        # Hyperliquid with l2Book/trades streams. Wider discovery needs the
        # venue's meta endpoint — that is the HIP-3 work, not this file.
        catalog = [
            ("BTC", "Bitcoin / USD (Perp)", "Crypto"),
            ("ETH", "Ether / USD (Perp)", "Crypto"),
            ("SOL", "Solana / USD (Perp)", "Crypto"),
        ]
        q = query.upper().replace("/", "")
        return [Instrument(symbol=s, name=n, category=c, provider=self.name,
                           meta={"venue": "Hyperliquid Perp", "product_type": "perp"})
                for s, n, c in catalog if not q or q in s or q in n.upper()][:limit]

    def candles(self, symbol: str, timeframe: str, limit: int = 500, start=None, end=None) -> pd.DataFrame:
        rows = fetch_candles(normalise_coin(symbol), timeframe, limit=limit)
        return pd.DataFrame(rows, columns=["time_ms", "open", "high", "low", "close", "volume"])

    async def stream(self, symbols: list[str]):
        gens = [HyperliquidStream(s).events() for s in symbols]
        tasks = {asyncio.create_task(g.__anext__()): g for g in gens}
        try:
            while tasks:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    g = tasks.pop(task)
                    try:
                        yield task.result()
                        tasks[asyncio.create_task(g.__anext__())] = g
                    except StopAsyncIteration:
                        pass
        finally:
            for task in tasks: task.cancel()
            for g in gens: await g.aclose()
