"""Market-data fabric: providers → adapters → normalization → bus → consumers."""

from __future__ import annotations

from .capabilities import Capability, capability_set, formal_capabilities
from .types import (
    ConnectionHealth,
    FeedKind,
    InstrumentMaster,
    MarketStatus,
    NormalizedCandle,
    NormalizedQuote,
    NormalizedTrade,
)
from .normalize import (
    normalize_candle_row,
    normalize_candles_df,
    normalize_tick,
    normalize_quote,
    to_ms,
    to_sec,
)
from .quality import DataQualityReport, validate_candle, validate_quote, validate_tick
from .cache import HistoryCache
from .history import HistoryService, HistoryResult
from .bus import MarketDataBus, BusEvent, EventType, default_bus
from .connection import ConnectionState, StreamHub, ClientChannel
from .rate_limit import RateLimitRegistry, RateLimiter
from .service import MarketDataService

__all__ = [
    "Capability", "capability_set", "formal_capabilities",
    "ConnectionHealth", "FeedKind", "InstrumentMaster", "MarketStatus",
    "NormalizedCandle", "NormalizedQuote", "NormalizedTrade",
    "normalize_candle_row", "normalize_candles_df", "normalize_tick",
    "normalize_quote", "to_ms", "to_sec",
    "DataQualityReport", "validate_candle", "validate_quote", "validate_tick",
    "HistoryCache", "HistoryService", "HistoryResult",
    "MarketDataBus", "BusEvent", "EventType", "default_bus",
    "ConnectionState", "StreamHub", "ClientChannel",
    "RateLimitRegistry", "RateLimiter", "MarketDataService",
]
