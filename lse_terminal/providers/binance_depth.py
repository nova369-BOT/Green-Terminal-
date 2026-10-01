"""Public Binance depth provider for the verified DOM workspace."""
from __future__ import annotations

import asyncio
import logging

import pandas as pd

from lse_terminal.contracts import Instrument, Provider
from lse_terminal.engine.feeds.binance import (
    WS_BASE,
    fetch_klines,
    normalise_symbol,
    parse_agg_trade,
)
from lse_terminal.engine.feeds.binance_depth_stream import BinanceDepthStream

log = logging.getLogger(__name__)


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

    async def _trades(self, symbol: str):
        """Verified aggTrade prints (real aggressor side) as normalized ticks.

        The T&S / footprint / CVD panels consume these; without them only the
        DOM had a real path. ``m`` == "buyer is market maker" ⇒ SELL aggressor
        (see parse_agg_trade) — nothing is inferred.
        """
        import websockets  # noqa: PLC0415

        sym = normalise_symbol(symbol)
        url = f"{WS_BASE}/{sym.lower()}@aggTrade"
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(url, ping_interval=20, close_timeout=5) as socket:
                    backoff = 1.0
                    async for raw_text in socket:
                        raw = __import__('json').loads(raw_text)
                        tick = parse_agg_trade(raw)
                        yield {
                            "type": "tick",
                            "symbol": sym,
                            "price": tick.price,
                            "size": tick.size,
                            "side": tick.side,
                            "trade_id": raw.get("a"),
                            "ts": tick.time_ms,
                        }
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Trade stream failures are surfaced by the depth side's
                # DEPTH_RESET/state machine — stay quiet here and retry, so
                # the DOM's book stays authoritative for the symbol's health.
                log.warning("binance trades %s: %s", sym, str(exc) or type(exc).__name__)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    async def stream(self, symbols: list[str]):
        # One depth stream per subscribed symbol plus one trades stream per
        # symbol; the hub currently expects one provider iterator, so we
        # multiplex them and tag every event naturally.
        gens = []
        for s in symbols:
            gens.append(BinanceDepthStream(s).events())
            gens.append(self._trades(s))
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
