"""In-process TTL cache for historical bars (per provider/symbol/timeframe/range)."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class _Entry:
    value: Any
    stored_at: float
    hits: int = 1


class HistoryCache:
    """Thread-safe LRU-ish TTL cache. Keyed by adapter-normalized request key."""

    def __init__(self, max_entries: int = 256, ttl_s: float = 30.0):
        self.max_entries = max_entries
        self.ttl_s = ttl_s
        self._lock = threading.Lock()
        self._d: dict[str, _Entry] = {}
        self.hits = 0
        self.misses = 0

    @staticmethod
    def key(provider: str, symbol: str, timeframe: str, start: str, end: str, limit: int) -> str:
        return f"{provider}|{symbol}|{timeframe}|{start or ''}|{end or ''}|{limit}"

    def get(self, key: str) -> Optional[Any]:
        now = time.monotonic()
        with self._lock:
            e = self._d.get(key)
            if not e:
                self.misses += 1
                return None
            if now - e.stored_at > self.ttl_s:
                del self._d[key]
                self.misses += 1
                return None
            e.hits += 1
            self.hits += 1
            return e.value

    def put(self, key: str, value: Any) -> None:
        now = time.monotonic()
        with self._lock:
            if key not in self._d and len(self._d) >= self.max_entries:
                # Evict oldest by stored_at
                oldest = min(self._d.items(), key=lambda kv: kv[1].stored_at)
                del self._d[oldest[0]]
            self._d[key] = _Entry(value=value, stored_at=now)

    def invalidate(self, prefix: str = "") -> int:
        with self._lock:
            if not prefix:
                n = len(self._d)
                self._d.clear()
                return n
            keys = [k for k in self._d if k.startswith(prefix)]
            for k in keys:
                del self._d[k]
            return len(keys)

    def stats(self) -> dict:
        with self._lock:
            return {
                "entries": len(self._d),
                "max_entries": self.max_entries,
                "ttl_s": self.ttl_s,
                "hits": self.hits,
                "misses": self.misses,
            }
