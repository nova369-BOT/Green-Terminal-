"""In-process market-data event bus.

Future order-flow events (ORDER_BOOK_*, MBO_*, …) plug in as new EventType
values without rewriting consumers. Live implementation only publishes
events we actually receive — never synthetic depth.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional


class EventType(str, Enum):
    QUOTE = "QUOTE"
    TRADE = "TRADE"
    CANDLE = "CANDLE"
    MARKET_STATUS = "MARKET_STATUS"
    CONNECTION_STATUS = "CONNECTION_STATUS"
    DATA_ERROR = "DATA_ERROR"
    DATA_QUALITY = "DATA_QUALITY"
    # Reserved for Phase 4 order-flow — published only when a real source
    # delivers them:
    ORDER_BOOK_SNAPSHOT = "ORDER_BOOK_SNAPSHOT"
    ORDER_BOOK_UPDATE = "ORDER_BOOK_UPDATE"
    MBO_EVENT = "MBO_EVENT"
    DEPTH_RESET = "DEPTH_RESET"
    AUCTION = "AUCTION"
    LIQUIDITY_EVENT = "LIQUIDITY_EVENT"


@dataclass
class BusEvent:
    type: EventType
    payload: Any = None
    symbol: str = ""
    provider: str = ""
    ts_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    # Optional latency sample stages
    provider_ts_ms: Optional[int] = None
    bus_ts_ms: int = 0


Handler = Callable[[BusEvent], None]


class MarketDataBus:
    """Synchronous pub/sub with per-type and wildcard handlers.

    Handler exceptions are isolated so one consumer cannot kill the bus.
    """

    def __init__(self, max_queue_hint: int = 10000):
        self._lock = threading.RLock()
        self._h: dict[EventType | None, list[Handler]] = {}
        self._seq = 0
        self.published = 0
        self.dropped = 0  # reserved for backpressure accounting
        self.max_queue_hint = max_queue_hint

    def subscribe(self, etype: EventType | None, fn: Handler) -> Callable[[], None]:
        """None = wildcard. Returns unsubscribe callable."""
        with self._lock:
            self._h.setdefault(etype, []).append(fn)

        def unsub() -> None:
            with self._lock:
                lst = self._h.get(etype) or []
                if fn in lst:
                    lst.remove(fn)

        return unsub

    def publish(self, event: BusEvent) -> None:
        event.bus_ts_ms = int(time.time() * 1000)
        with self._lock:
            self._seq += 1
            self.published += 1
            handlers = list(self._h.get(event.type, [])) + list(self._h.get(None, []))
        for fn in handlers:
            try:
                fn(event)
            except Exception:
                # Never let a consumer exception drop the feed.
                pass

    def stats(self) -> dict:
        with self._lock:
            counts = { (k.value if k else "*"): len(v) for k, v in self._h.items() }
        return {
            "published": self.published,
            "dropped": self.dropped,
            "seq": self._seq,
            "handlers": counts,
        }


# Process-wide default bus (server-side fan-out + diagnostics).
_default_bus = MarketDataBus()


def default_bus() -> MarketDataBus:
    return _default_bus
