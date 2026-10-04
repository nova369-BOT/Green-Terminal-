"""Per-provider rate limiting for outbound HTTP candle/quote calls."""

from __future__ import annotations

import threading
import time
from collections import deque


class RateLimiter:
    """Sliding-window limiter (N calls per window_s). Thread-safe."""

    def __init__(self, max_calls: int, window_s: float = 1.0, burst: int | None = None):
        self.max_calls = max(1, int(max_calls))
        self.window_s = float(window_s)
        self._times: deque[float] = deque()
        self._lock = threading.Lock()
        self.allowed = 0
        self.throttled = 0
        # Simple cooldown after a 429-style rejection
        self._block_until = 0.0

    def try_acquire(self) -> bool:
        now = time.monotonic()
        with self._lock:
            if now < self._block_until:
                self.throttled += 1
                return False
            while self._times and now - self._times[0] >= self.window_s:
                self._times.popleft()
            if len(self._times) >= self.max_calls:
                self.throttled += 1
                return False
            self._times.append(now)
            self.allowed += 1
            return True

    def penalize(self, block_s: float = 2.0) -> None:
        """Provider signaled backoff (e.g. HTTP 429)."""
        with self._lock:
            self._block_until = max(self._block_until, time.monotonic() + block_s)

    def snapshot(self) -> dict:
        with self._lock:
            now = time.monotonic()
            while self._times and now - self._times[0] >= self.window_s:
                self._times.popleft()
            return {
                "max_calls": self.max_calls,
                "window_s": self.window_s,
                "in_window": len(self._times),
                "allowed": self.allowed,
                "throttled": self.throttled,
                "blocked_for_s": max(0.0, round(self._block_until - now, 2)),
            }


# Conservative defaults for free/shared egress.
DEFAULT_LIMITS: dict[str, tuple[int, float]] = {
    "demo": (120, 1.0),
    "lse": (30, 1.0),
    "binance_import": (40, 1.0),
    "vault_import": (40, 1.0),
    "userdata": (120, 1.0),
    "spread": (60, 1.0),
    "decoders": (60, 1.0),
}


class RateLimitRegistry:
    def __init__(self, defaults: dict[str, tuple[int, float]] | None = None):
        self._limits: dict[str, RateLimiter] = {}
        self._defaults = defaults or DEFAULT_LIMITS

    def for_provider(self, provider: str) -> RateLimiter:
        lim = self._limits.get(provider)
        if lim is None:
            max_calls, window = self._defaults.get(provider, (60, 1.0))
            lim = RateLimiter(max_calls, window)
            self._limits[provider] = lim
        return lim

    def snapshot(self) -> dict:
        return {name: lim.snapshot() for name, lim in sorted(self._limits.items())}

    def check(self, provider: str, cost: int = 1) -> bool:
        lim = self.for_provider(provider)
        ok = True
        for _ in range(max(1, cost)):
            if not lim.try_acquire():
                ok = False
                break
        return ok
