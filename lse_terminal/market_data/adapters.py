"""Provider adapters implementing the Phase-3 MarketDataProvider interface.

Thin wrappers around existing lse_terminal.contracts.Provider implementations —
repair/extend, do not fork business logic. Each adapter exposes:

    connect / disconnect / subscribe / unsubscribe
    get_historical_bars / get_quote / get_trades
    get_capabilities / health_check

Capabilities are honest (see capabilities.py): L2/L3 stay false unless a
real depth implementation exists.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Iterable, Optional

import pandas as pd

from ..contracts.types import CANDLE_COLUMNS
from .capabilities import formal_capabilities
from .connection import ConnectionState, StreamHub
from .normalize import normalize_candles_df, normalize_quote, normalize_tick
from .quality import validate_quote, validate_tick
from .rate_limit import RateLimitRegistry
from .types import NormalizedCandle, NormalizedQuote, NormalizedTrade


@dataclass
class ProviderCapabilities:
    provider: str
    formal: list[str]
    legacy: list[str]
    timeframes: list[str]
    configured: bool = False
    l2: bool = False
    l3: bool = False

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "formal": self.formal,
            "legacy": self.legacy,
            "timeframes": self.timeframes,
            "configured": self.configured,
            "l2": self.l2,
            "l3": self.l3,
        }


class MarketDataProvider:
    """Phase-3 interface. Default implementations delegate to the legacy
    Provider ABC so existing adapters (demo/lse/…) gain the new surface
    without rewrite."""

    def __init__(
        self,
        provider,
        *,
        hub: Optional[StreamHub] = None,
        rate_limits: Optional[RateLimitRegistry] = None,
        name: Optional[str] = None,
    ):
        self.provider = provider
        self.name = name or getattr(provider, "name", type(provider).__name__)
        self.hub = hub
        self.rate_limits = rate_limits
        self._subscriptions: list[str] = []
        self._sub_lock = threading.Lock()

    def get_capabilities(self) -> ProviderCapabilities:
        legacy: list[str] = []
        try:
            legacy = list(self.provider.capabilities())
        except Exception:
            legacy = []
        try:
            configured = bool(self.provider.configured())
        except Exception:
            configured = bool(getattr(self.provider, "_key", None)) or self.name in (
                "demo", "spread", "userdata",
            )
        timeframes = list(getattr(self.provider, "timeframes", []) or [])
        return ProviderCapabilities(
            provider=self.name,
            formal=formal_capabilities(self.provider),
            legacy=legacy,
            timeframes=timeframes,
            configured=configured,
            l2=False,
            l3=False,
        )

    def health_check(self) -> dict:
        rows = self.hub.health(self.name) if self.hub else []
        row = next((r for r in rows if r["provider"] == self.name), None)
        if not row:
            row = {
                "provider": self.name,
                "state": ConnectionState.DISCONNECTED,
                "last_msg_age_ms": None,
                "last_error": "",
                "subscriptions": 0,
                "events": 0,
                "reconnects": 0,
                "latency_ewma_ms": None,
            }
        caps = self.get_capabilities()
        row["capabilities"] = caps.formal
        row["configured"] = caps.configured
        return row

    def connect(self) -> None:
        return None

    def disconnect(self) -> None:
        with self._sub_lock:
            self._subscriptions = []

    def subscribe(self, symbols: list[str]) -> dict:
        symbols = [s for s in dict.fromkeys(symbols) if s]
        with self._sub_lock:
            for s in symbols:
                if s not in self._subscriptions:
                    self._subscriptions.append(s)
        return {"provider": self.name, "symbols": list(self._subscriptions)}

    def unsubscribe(self, symbols: list[str]) -> dict:
        with self._sub_lock:
            self._subscriptions = [s for s in self._subscriptions if s not in symbols]
        return {"provider": self.name, "symbols": list(self._subscriptions)}

    def _rate_ok(self) -> bool:
        if not self.rate_limits:
            return True
        return self.rate_limits.check(self.name)

    def get_historical_bars(
        self,
        symbol: str,
        timeframe: str,
        *,
        limit: int = 5000,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> list[NormalizedCandle]:
        if not self._rate_ok():
            raise TimeoutError(f"rate limited: {self.name}")
        df = self.provider.candles(symbol, timeframe, limit=limit, start=start, end=end)
        return normalize_candles_df(df, symbol=symbol, timeframe=timeframe, source=self.name)

    def get_quote(self, symbol: str) -> Optional[NormalizedQuote]:
        try:
            raw = self.provider.quote(symbol)
        except NotImplementedError:
            return None
        except Exception:
            return None
        if raw is None:
            return None
        if isinstance(raw, dict):
            q = normalize_quote(raw, source=self.name)
        elif hasattr(raw, "to_dict"):
            q = normalize_quote(raw.to_dict(), source=self.name)
        elif hasattr(raw, "price"):
            q = normalize_quote(
                {"symbol": getattr(raw, "symbol", symbol), "price": raw.price,
                 "ts": getattr(raw, "ts", None)},
                source=self.name,
            )
        else:
            q = None
        if q and not validate_quote(q).ok:
            return None
        return q

    def get_trades(
        self, symbol: str, *, limit: int = 200, window_s: float = 0.5
    ) -> list[NormalizedTrade]:
        """Best-effort trades from the in-process bus for a short window.

        Returns [] when the provider has no live stream — never fabricates.
        """
        caps = self.get_capabilities()
        if "WEBSOCKET" not in caps.formal:
            return []
        collected: list[NormalizedTrade] = []
        import time as _time

        from .bus import default_bus
        from .normalize import now_ms

        def handler(event):
            if event.type.value == "TRADE" and event.symbol == symbol:
                payload = event.payload
                if isinstance(payload, dict) and "price" in payload:
                    t = normalize_tick(payload, source=self.name, receive_ms=now_ms())
                    if t and validate_tick(t).ok:
                        collected.append(t)
                if len(collected) >= limit:
                    done.set()

        done = threading.Event()
        unsub = default_bus().subscribe(None, handler)
        try:
            done.wait(window_s)
        finally:
            unsub()
        return collected[:limit]

    def raw_candles_df(
        self,
        symbol: str,
        timeframe: str,
        *,
        limit: int = 5000,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ) -> pd.DataFrame:
        if not self._rate_ok():
            raise TimeoutError(f"rate limited: {self.name}")
        df = self.provider.candles(symbol, timeframe, limit=limit, start=start, end=end)
        if df is None or len(df) == 0:
            return pd.DataFrame(columns=CANDLE_COLUMNS)
        cols = [c for c in CANDLE_COLUMNS if c in df.columns]
        return df[cols].copy()


def wrap_provider(
    provider,
    *,
    hub: Optional[StreamHub] = None,
    rate_limits: Optional[RateLimitRegistry] = None,
) -> MarketDataProvider:
    return MarketDataProvider(provider, hub=hub, rate_limits=rate_limits)


def wrap_all(
    providers: Iterable[Any],
    *,
    hub: Optional[StreamHub] = None,
    rate_limits: Optional[RateLimitRegistry] = None,
) -> dict[str, MarketDataProvider]:
    out: dict[str, MarketDataProvider] = {}
    for p in providers:
        name = getattr(p, "name", None)
        if not name:
            continue
        out[name] = wrap_provider(p, hub=hub, rate_limits=rate_limits)
    return out
