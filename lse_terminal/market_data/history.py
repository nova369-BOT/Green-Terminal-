"""Historical bars service: fetch, validate, sort, dedupe, merge, cancel keys.

Aggregation across timeframes is intentionally NOT done here when mixing
native bars — a request for 1m must never absorb 5m rows.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Optional

from .cache import HistoryCache
from .normalize import normalize_candles_df
from .quality import validate_candle
from .types import NormalizedCandle

log = logging.getLogger("lse.market_data.history")


@dataclass
class HistoryResult:
    symbol: str
    timeframe: str
    source: str
    candles: list[NormalizedCandle] = field(default_factory=list)
    cached: bool = False
    dropped: int = 0
    quality_codes: list[str] = field(default_factory=list)
    error: Optional[str] = None
    request_id: str = ""

    def to_chart_payload(self) -> dict:
        """Shape compatible with existing /api/candles consumers."""
        return {
            "provider": self.source,
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "candles": [c.to_row() for c in self.candles],
            "indicators": {},
            "meta": {
                "cached": self.cached,
                "dropped": self.dropped,
                "quality": self.quality_codes[:20],
                "count": len(self.candles),
                "error": self.error,
                "feed": "historical",
            },
        }


class HistoryService:
    """Wraps a provider's candles() with cache, quality, and merge rules."""

    def __init__(self, cache: Optional[HistoryCache] = None):
        self.cache = cache or HistoryCache()
        self._gen: dict[str, int] = {}
        self._gen_lock = threading.Lock()

    def begin_request(self, request_id: str) -> None:
        """Mark a new logical request; older in-flight gens for other ids still land."""
        with self._gen_lock:
            self._gen["current"] = hash(request_id) & 0x7FFFFFFF

    def is_current(self, request_id: str) -> bool:
        with self._gen_lock:
            return self._gen.get("current") == (hash(request_id) & 0x7FFFFFFF)

    def fetch(
        self,
        provider,
        *,
        provider_name: str,
        symbol: str,
        timeframe: str,
        limit: int = 5000,
        start: Optional[str] = None,
        end: Optional[str] = None,
        request_id: str = "",
        use_cache: bool = True,
    ) -> HistoryResult:
        res = HistoryResult(
            symbol=symbol, timeframe=timeframe, source=provider_name, request_id=request_id
        )
        limit = max(1, min(int(limit), 5000))
        ckey = HistoryCache.key(provider_name, symbol, timeframe, start or "", end or "", limit)
        if use_cache:
            hit = self.cache.get(ckey)
            if hit is not None:
                res.cached = True
                res.candles = hit
                return res
        try:
            df = provider.candles(symbol, timeframe, limit=limit, start=start, end=end)
        except Exception as e:
            res.error = str(e)[:300]
            log.warning("history fetch failed %s %s: %s", provider_name, symbol, e)
            return res

        candles = normalize_candles_df(df, symbol=symbol, timeframe=timeframe, source=provider_name)
        # Sort + drop exact duplicate timestamps (keep first occurrence).
        candles.sort(key=lambda c: c.timestamp_ms)
        deduped: list[NormalizedCandle] = []
        seen: set[int] = set()
        prev: Optional[NormalizedCandle] = None
        for c in candles:
            if c.timestamp_ms in seen:
                res.dropped += 1
                continue
            report = validate_candle(c, prev=prev)
            if not report.ok:
                res.dropped += 1
                res.quality_codes.extend(report.codes)
                # Drop impossible bars rather than charting garbage.
                continue
            seen.add(c.timestamp_ms)
            deduped.append(c)
            prev = c
        res.candles = deduped
        if use_cache and not res.error:
            self.cache.put(ckey, res.candles)
        return res

    @staticmethod
    def merge_live(
        history: list[NormalizedCandle],
        live: list[NormalizedCandle],
        *,
        timeframe_seconds: int,
    ) -> list[NormalizedCandle]:
        """Merge history + live buckets without duplicate timestamps.

        Live replaces overlapping history buckets (live is fresher).
        History must stay sorted ascending; live assumed sorted ascending.
        """
        if not history:
            return list(live)
        if not live:
            return list(history)
        live_by_ts = {c.timestamp_ms: c for c in live}
        out: list[NormalizedCandle] = []
        for h in history:
            if h.timestamp_ms in live_by_ts:
                out.append(live_by_ts.pop(h.timestamp_ms))
            else:
                out.append(h)
        # Remaining live bars after history end
        tail = [c for c in live if c.timestamp_ms not in {x.timestamp_ms for x in out}]
        out.extend(tail)
        out.sort(key=lambda c: c.timestamp_ms)
        # Final uniqueness
        final: list[NormalizedCandle] = []
        last_ts = -1
        for c in out:
            if c.timestamp_ms == last_ts:
                continue
            final.append(c)
            last_ts = c.timestamp_ms
        return final

    @staticmethod
    def merge_history_older(
        existing: list[NormalizedCandle],
        older: list[NormalizedCandle],
    ) -> list[NormalizedCandle]:
        """Prepend older page; drop boundary duplicates; keep sort order."""
        if not older:
            return existing
        if not existing:
            return sorted(older, key=lambda c: c.timestamp_ms)
        known = {c.timestamp_ms for c in existing}
        head = [c for c in older if c.timestamp_ms < existing[0].timestamp_ms and c.timestamp_ms not in known]
        return sorted(head + existing, key=lambda c: c.timestamp_ms)
