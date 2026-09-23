"""MarketDataService: composition root for Phase-3 server-side fabric.

create_app() constructs one instance and attaches it to app.state.md —
health dashboard, capabilities, rate limits, and shared streams all read
from here (real measured values only).
"""

from __future__ import annotations

from typing import Optional

from .adapters import MarketDataProvider, wrap_all
from .bus import BusEvent, EventType, MarketDataBus, default_bus
from .connection import StreamHub
from .history import HistoryCache, HistoryService
from .normalize import now_ms
from .quality import validate_candle, validate_quote, validate_tick
from .rate_limit import RateLimitRegistry


class MarketDataService:
    def __init__(self, registry, *, bus: Optional[MarketDataBus] = None):
        self.registry = registry
        self.bus = bus or default_bus()
        self.rate_limits = RateLimitRegistry()
        self.hub = StreamHub(registry, bus=self.bus, validate=True)
        self.history = HistoryService(HistoryCache())
        self.adapters: dict[str, MarketDataProvider] = wrap_all(
            list(registry.all()), hub=self.hub, rate_limits=self.rate_limits
        )
        self.started_ms = now_ms()
        self._quality_errors = 0

    def adapter(self, name: str) -> Optional[MarketDataProvider]:
        return self.adapters.get(name)

    def ensure_adapter(self, name: str) -> Optional[MarketDataProvider]:
        ad = self.adapters.get(name)
        if ad:
            return ad
        try:
            prov = self.registry.get(name)
        except Exception:
            return None
        ad = MarketDataProvider(prov, hub=self.hub, rate_limits=self.rate_limits, name=name)
        self.adapters[name] = ad
        return ad

    def capabilities_payload(self) -> dict:
        providers = [ad.get_capabilities().to_dict() for _, ad in sorted(self.adapters.items())]
        return {
            "providers": providers,
            "event_types": [e.value for e in EventType],
            "depth": {
                "l2": False,
                "l3": False,
                "note": "no L2/L3 source wired; flags stay false until a verified feed exists",
            },
            "models": ["NormalizedQuote", "NormalizedTrade", "NormalizedCandle", "MarketStatus"],
        }

    def health_payload(self) -> dict:
        rows = [ad.health_check() for _, ad in sorted(self.adapters.items())]
        # merge hub state (may exist for providers without adapter refresh)
        by_name = {r["provider"]: r for r in rows}
        for h in self.hub.health():
            if h["provider"] not in by_name:
                by_name[h["provider"]] = h
            else:
                by_name[h["provider"]].update({
                    k: v for k, v in h.items()
                    if k in ("state", "last_msg_age_ms", "last_error", "subscriptions",
                             "events", "reconnects", "latency_ewma_ms", "stale", "symbols")
                    and v is not None
                })
        return {
            "overall": self.hub.overall_state(),
            "providers": list(by_name.values()),
            "rate_limits": self.rate_limits.snapshot(),
            "history_cache": self.history.cache.stats(),
            "bus": self.bus.stats(),
            "stream": self.hub.stats(),
            "quality_errors": self._quality_errors + len(self.hub.recent_errors()),
            "quality_recent": self.hub.recent_errors()[-20:],
            "uptime_ms": now_ms() - self.started_ms,
            "ts_ms": now_ms(),
        }

    def validate_candle_payload(self, candle) -> bool:
        rep = validate_candle(candle)
        if not rep.ok:
            self._quality_errors += 1
            self.bus.publish(BusEvent(
                type=EventType.DATA_ERROR,
                payload={"codes": rep.codes, "detail": rep.detail},
                symbol=candle.symbol,
                provider=candle.source,
            ))
        return rep.ok

    def shutdown(self) -> None:
        # Hub tasks are cancelled on event-loop shutdown; nothing blocking.
        return None
