"""Binance public market data — a zero-signup tick source for the footprint.

WHY THIS FEED
-------------
Binance publishes aggregated trades on a public endpoint: no API key, no
account, no approval. More importantly it publishes the **real aggressor
side** for every trade, so the footprint built from it is exact rather than
inferred:

    FX / CFD (cTrader)      -> side inferred by the tick rule  (~72-80% right)
    Binance (this module)   -> side published by the exchange  (100% right)

So this is not a stand-in of lower quality; for order flow it is the better
data. Its limit is coverage: crypto only. FX and indices still need cTrader.

THE AGGRESSOR FLAG
------------------
``aggTrade`` carries ``m`` = "is the BUYER the market maker?".

    m == true   -> the buyer was resting, the SELLER crossed the spread -> SELL
    m == false  -> the seller was resting, the BUYER crossed the spread -> BUY

That is easy to get backwards, which would mirror every delta on the chart, so
it is asserted in the tests.

ENDPOINTS (public, documented, unauthenticated)
    REST  https://api.binance.com/api/v3/klines      historical candles
    WS    wss://stream.binance.com:9443/ws/<sym>@aggTrade   live trades

No new dependency: REST uses urllib, the socket uses ``websockets`` which is
already required by this project.
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Awaitable, Callable, Iterable, Optional

from lse_terminal.engine.footprint import FootprintTick

log = logging.getLogger(__name__)

__all__ = [
    "BinanceError", "REST_BASE", "WS_BASE", "INTERVALS",
    "parse_agg_trade", "parse_kline", "normalise_symbol", "interval_to_ms",
    "fetch_klines", "BinanceTickStream",
]

REST_BASE = "https://api.binance.com"
WS_BASE = "wss://stream.binance.com:9443/ws"

# Binance interval strings, mapped to milliseconds.
INTERVALS: dict[str, int] = {
    "1s": 1_000, "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
    "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000,
    "6h": 21_600_000, "8h": 28_800_000, "12h": 43_200_000,
    "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
}


class BinanceError(RuntimeError):
    """A request to Binance failed. Carries the exchange's own message."""


def normalise_symbol(raw: str) -> str:
    """Chart symbol -> Binance symbol ('btc-usdt', 'BTC/USDT' -> 'BTCUSDT').

    A bare coin is quoted in USDT, which is where the liquidity is.
    """
    s = "".join(ch for ch in str(raw or "").upper() if ch.isalnum())
    if not s:
        return ""
    # Already quoted? The length test matters: a bare "BTC" ends with "BTC"
    # but is a base asset, not a BTC-quoted pair, and must become BTCUSDT.
    for quote in ("USDT", "USDC", "FDUSD", "BUSD", "TUSD", "BTC", "ETH", "BNB"):
        if s.endswith(quote) and len(s) > len(quote):
            return s
    if s.endswith("USD"):          # BTCUSD -> BTCUSDT
        return s + "T"
    return s + "USDT"              # BTC -> BTCUSDT


def interval_to_ms(interval: str) -> int:
    key = str(interval or "").strip().lower()
    if key not in INTERVALS:
        raise BinanceError(
            f"unsupported interval {interval!r}; valid: {sorted(INTERVALS)}")
    return INTERVALS[key]


# ── Parsing (pure, so it is testable without a network) ────────────────────

def parse_agg_trade(raw: dict) -> FootprintTick:
    """An ``aggTrade`` payload -> a footprint tick with the REAL side.

    ``m`` is "buyer is market maker". If the buyer was the maker then the
    seller was the aggressor, so the trade is a SELL.
    """
    is_buyer_maker = bool(raw.get("m"))
    return FootprintTick(
        time_ms=int(raw.get("T") or raw.get("E") or 0),
        price=float(raw["p"]),
        side="sell" if is_buyer_maker else "buy",
        size=float(raw["q"]),
    )


def parse_kline(row: list) -> dict:
    """A REST kline row -> the bar shape the footprint engine expects.

    Row layout: [openTime, open, high, low, close, volume, closeTime, ...]
    """
    return {
        "time_ms": int(row[0]),
        "open": float(row[1]),
        "high": float(row[2]),
        "low": float(row[3]),
        "close": float(row[4]),
        "volume": float(row[5]),
    }


# ── REST: historical candles ───────────────────────────────────────────────

def fetch_klines(symbol: str, interval: str = "1m", limit: int = 200,
                 *, timeout: float = 15.0) -> list[dict]:
    """Recent candles. Raises BinanceError rather than returning a fake bar."""
    sym = normalise_symbol(symbol)
    interval_to_ms(interval)                    # validate before the round trip
    query = urllib.parse.urlencode({
        "symbol": sym,
        "interval": interval.lower(),
        "limit": max(1, min(int(limit), 1000)),  # exchange cap
    })
    url = f"{REST_BASE}/api/v3/klines?{query}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            rows = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        raise BinanceError(f"klines HTTP {e.code} for {sym}: {detail}") from e
    except urllib.error.URLError as e:
        raise BinanceError(f"cannot reach Binance: {e.reason}") from e
    except json.JSONDecodeError as e:
        raise BinanceError("Binance returned invalid JSON for klines") from e

    if isinstance(rows, dict) and rows.get("code"):
        raise BinanceError(f"{rows.get('code')}: {rows.get('msg')}")
    return [parse_kline(r) for r in rows]


# ── WebSocket: live trades ─────────────────────────────────────────────────

class BinanceTickStream:
    """Streams aggregated trades for one symbol as FootprintTicks.

    Reconnects with capped exponential backoff. Reports its own state
    honestly: ``status()`` never claims connected when it is not.
    """

    MAX_BACKOFF = 30.0

    def __init__(self, symbol: str,
                 on_tick: Optional[Callable[[FootprintTick], Awaitable[None] | None]] = None):
        self.symbol = normalise_symbol(symbol)
        if not self.symbol:
            raise BinanceError("a symbol is required")
        self._handlers: list[Callable] = [on_tick] if on_tick else []
        self._task: Optional[asyncio.Task] = None
        self._running = False
        self.connected = False
        self.ticks_received = 0
        self.last_tick_ms = 0
        self.last_error = ""

    @property
    def url(self) -> str:
        return f"{WS_BASE}/{self.symbol.lower()}@aggTrade"

    def on_tick(self, handler: Callable) -> None:
        self._handlers.append(handler)

    def status(self) -> dict:
        return {
            "symbol": self.symbol,
            "url": self.url,
            "running": self._running,
            "connected": self.connected,
            "ticks_received": self.ticks_received,
            "last_tick_ms": self.last_tick_ms,
            "last_error": self.last_error,
        }

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None
        self.connected = False

    def _emit(self, tick: FootprintTick) -> None:
        self.ticks_received += 1
        self.last_tick_ms = tick.time_ms
        for h in self._handlers:
            try:
                result = h(tick)
                if asyncio.iscoroutine(result):
                    asyncio.create_task(result)
            except Exception:
                # One bad consumer must never stop the feed for the others.
                log.exception("binance: tick handler raised")

    async def _run(self) -> None:
        try:
            import websockets
        except ImportError:
            self.last_error = "the 'websockets' package is not installed"
            self._running = False
            log.error("binance: %s", self.last_error)
            return

        backoff = 1.0
        while self._running:
            try:
                async with websockets.connect(self.url, ping_interval=20,
                                              ping_timeout=20) as ws:
                    self.connected = True
                    self.last_error = ""
                    backoff = 1.0
                    log.info("binance: streaming %s", self.symbol)
                    async for raw in ws:
                        if not self._running:
                            break
                        try:
                            self._emit(parse_agg_trade(json.loads(raw)))
                        except (ValueError, KeyError, TypeError) as e:
                            log.debug("binance: skipped a malformed frame: %s", e)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.last_error = str(e)
                log.warning("binance: %s disconnected (%s)", self.symbol, e)
            finally:
                self.connected = False
            if self._running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.MAX_BACKOFF)
