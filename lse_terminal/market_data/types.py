"""Canonical internal market-data models (Phase 3).

All timestamps are epoch **milliseconds** internally after normalization.
Source timestamps in seconds/micros/nanos are converted at the adapter edge.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional


class FeedKind(str, Enum):
    LIVE = "live"
    DELAYED = "delayed"
    HISTORICAL = "historical"
    REPLAY = "replay"
    UNAVAILABLE = "unavailable"


class ConnectionHealth(str, Enum):
    DISCONNECTED = "DISCONNECTED"
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    DEGRADED = "DEGRADED"
    RECONNECTING = "RECONNECTING"
    ERROR = "ERROR"


@dataclass
class NormalizedQuote:
    symbol: str
    timestamp_ms: int
    bid: Optional[float] = None
    ask: Optional[float] = None
    bid_size: Optional[float] = None
    ask_size: Optional[float] = None
    last: Optional[float] = None
    source: str = ""
    synthetic: bool = False  # bid/ask inferred locally (not venue quote)
    seq: int = 0  # receive order for dedup

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class NormalizedTrade:
    symbol: str
    timestamp_ms: int
    price: float
    size: float = 0.0
    side: Optional[str] = None  # "buy" | "sell" | None (not available)
    trade_id: Optional[str] = None
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class NormalizedCandle:
    symbol: str
    timeframe: str
    timestamp_ms: int  # bar open, UTC
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_row(self) -> list:
        """Legacy chart row: [ts_sec, o, h, l, c, v]."""
        return [
            self.timestamp_ms // 1000,
            self.open,
            self.high,
            self.low,
            self.close,
            self.volume,
        ]


@dataclass
class MarketStatus:
    symbol: str
    exchange: str
    session: str  # "open" | "closed" | "pre" | "post" | "unknown"
    is_open: Optional[bool]
    timestamp_ms: int
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class InstrumentMaster:
    """Green Terminal instrument id with provider mappings.

    UI always uses ``gt_id``; adapters translate to provider symbols via
    ``provider_symbols``.
    """

    gt_id: str
    display_name: str
    asset_class: str = ""
    exchange: str = ""
    currency: str = ""
    tick_size: Optional[float] = None
    contract_size: Optional[float] = None
    price_precision: Optional[int] = None
    volume_precision: Optional[int] = None
    session: str = ""  # free-form session hint, e.g. "24x7" or "equity-us"
    provider_symbols: dict[str, str] = field(default_factory=dict)

    def symbol_for(self, provider: str) -> str:
        return self.provider_symbols.get(provider, self.gt_id)


@dataclass
class LatencySample:
    """Stage timestamps for one event (all epoch ms)."""

    provider_ts_ms: Optional[int] = None
    receive_ts_ms: int = 0
    normalize_ts_ms: int = 0
    bus_ts_ms: int = 0
    ui_ts_ms: Optional[int] = None

    @property
    def ingest_ms(self) -> Optional[int]:
        if self.provider_ts_ms and self.receive_ts_ms:
            return max(0, self.receive_ts_ms - self.provider_ts_ms)
        return None

    @property
    def normalize_ms(self) -> Optional[int]:
        if self.receive_ts_ms and self.normalize_ts_ms:
            return max(0, self.normalize_ts_ms - self.receive_ts_ms)
        return None

    @property
    def bus_ms(self) -> Optional[int]:
        if self.normalize_ts_ms and self.bus_ts_ms:
            return max(0, self.bus_ts_ms - self.normalize_ts_ms)
        return None
