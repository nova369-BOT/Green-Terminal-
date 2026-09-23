"""Async shared stream hub: one upstream stream per provider, many WS clients.

States follow the Phase-3 contract (DISCONNECTED…ERROR). Reconnect and
refcount live here — charts only subscribe to an already-open shared socket.

Each WebSocket client gets a ClientChannel; the hub fans out validated ticks.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from .bus import BusEvent, EventType, default_bus
from .normalize import normalize_quote, normalize_tick, now_ms
from .quality import validate_quote, validate_tick
from .types import ConnectionHealth, NormalizedQuote, NormalizedTrade

log = logging.getLogger("lse.market_data.hub")

_BACKOFF_BASE_S = 0.5
_BACKOFF_MAX_S = 30.0
_STALE_AFTER_MS = 30_000


class ConnectionState:
    DISCONNECTED = ConnectionHealth.DISCONNECTED.value
    CONNECTING = ConnectionHealth.CONNECTING.value
    CONNECTED = ConnectionHealth.CONNECTED.value
    DEGRADED = ConnectionHealth.DEGRADED.value
    RECONNECTING = ConnectionHealth.RECONNECTING.value
    ERROR = ConnectionHealth.ERROR.value


@dataclass
class ProviderLink:
    provider: str
    state: str = ConnectionState.DISCONNECTED
    last_msg_ms: int = 0
    last_error: str = ""
    reconnects: int = 0
    attempt: int = 0
    opened_ms: int = 0
    latency_ewma_ms: float = 0.0
    events: int = 0
    symbols: set[str] = field(default_factory=set)
    task: Optional[asyncio.Task] = None
    generation: int = 0


class ClientChannel:
    """One browser WebSocket attached to the hub."""

    def __init__(self, send: Callable[[dict], Awaitable[None]], *, provider: str = ""):
        self._send = send
        self.provider = provider
        self.symbols: set[str] = set()
        self.closed = False
        self._lock = asyncio.Lock()

    async def emit(self, msg: dict) -> None:
        if self.closed:
            return
        try:
            await self._send(msg)
        except Exception:
            self.closed = True

    async def close(self) -> None:
        self.closed = True


class StreamHub:
    """Refcounted provider streams + connection state machine + fan-out."""

    def __init__(self, registry, *, bus=None, validate: bool = True):
        self.registry = registry
        self.bus = bus or default_bus()
        self.validate = validate
        self._links: dict[str, ProviderLink] = {}
        self._clients: set[ClientChannel] = set()
        self._lock = asyncio.Lock()
        self._error_ring: list[dict] = []
        # backpressure: raw tick rate tracked separately from UI send rate
        self.raw_ticks = 0
        self.ui_sends = 0
        self.ui_drops = 0
        self._ui_budget: dict[ClientChannel, float] = {}

    # ── client registry ───────────────────────────────────────────
    async def attach(self, channel: ClientChannel) -> None:
        async with self._lock:
            self._clients.add(channel)

    async def detach(self, channel: ClientChannel) -> None:
        async with self._lock:
            self._clients.discard(channel)
            # drop unsubscribed symbols for this channel
        # Recompute refcounts from remaining clients
        await self._recompute_subscriptions()

    async def subscribe(self, channel: ClientChannel, provider: str, symbols: list[str]) -> dict:
        provider = (provider or channel.provider or "").strip()
        if not provider:
            return {"ok": False, "error": "provider required", "state": ConnectionState.DISCONNECTED}
        symbols = [s for s in dict.fromkeys(s.strip() for s in symbols if s and s.strip())]
        try:
            self.registry.get(provider)
        except Exception:
            return {"ok": False, "error": f"unknown provider: {provider}",
                    "state": ConnectionState.ERROR}
        channel.provider = provider
        channel.symbols.update(symbols)
        async with self._lock:
            self._clients.add(channel)
        await self._recompute_subscriptions()
        link = self._links.get(provider)
        state = link.state if link else ConnectionState.DISCONNECTED
        return {"ok": True, "provider": provider, "symbols": sorted(channel.symbols),
                "state": state}

    async def unsubscribe(self, channel: ClientChannel, symbols: list[str]) -> dict:
        for s in symbols:
            channel.symbols.discard(s)
        await self._recompute_subscriptions()
        return {"ok": True, "provider": channel.provider,
                "symbols": sorted(channel.symbols)}

    async def _recompute_subscriptions(self) -> None:
        """Union of symbols across live clients, per provider; start/stop tasks."""
        need: dict[str, set[str]] = defaultdict(set)
        async with self._lock:
            clients = [c for c in self._clients if not c.closed and c.symbols]
            for c in clients:
                need[c.provider or ""].update(c.symbols)
            providers = set(self._links.keys()) | set(need.keys())
            for name in providers:
                link = self._links.get(name)
                if link is None:
                    link = ProviderLink(provider=name)
                    self._links[name] = link
                wanted = need.get(name, set())
                link.symbols = set(wanted)
                if wanted and (link.task is None or link.task.done()):
                    link.generation += 1
                    if link.state in (ConnectionState.DISCONNECTED, ConnectionState.ERROR, ""):
                        self._set_state_locked(link, ConnectionState.CONNECTING)
                    link.task = asyncio.create_task(
                        self._run_loop(name, link), name=f"md-hub-{name}"
                    )
                elif not wanted and link.task and not link.task.done():
                    link.task.cancel()
                    link.task = None
                    self._set_state_locked(link, ConnectionState.DISCONNECTED)

    # ── state ─────────────────────────────────────────────────────
    def _set_state_locked(self, link: ProviderLink, state: str, error: str = "") -> None:
        if link.state == state and not error:
            return
        link.state = state
        if error:
            link.last_error = error[:400]
        payload = {
            "provider": link.provider,
            "state": state,
            "error": link.last_error,
            "ts_ms": now_ms(),
            "symbols": sorted(link.symbols),
            "reconnects": link.reconnects,
        }
        self.bus.publish(
            BusEvent(type=EventType.CONNECTION_STATUS, payload=payload, provider=link.provider)
        )
        # Fan-out status to clients that listen on this provider (or all)
        msg = {"type": "status", **payload}
        for ch in list(self._clients):
            if not ch.closed and (ch.provider == link.provider or not ch.provider):
                asyncio.get_event_loop().create_task(ch.emit(msg))

    def _set_state(self, link: ProviderLink, state: str, error: str = "") -> None:
        self._set_state_locked(link, state, error)

    def health(self, provider: Optional[str] = None) -> list[dict]:
        now = now_ms()
        names = (
            [provider]
            if provider
            else sorted(
                set(self._links.keys())
                | {getattr(p, "name", "") for p in self.registry.all()}
                - {""}
            )
        )
        rows = []
        for name in names:
            if not name:
                continue
            link = self._links.get(name)
            configured = _configured(self.registry, name)
            if link is None:
                rows.append({
                    "provider": name,
                    "state": ConnectionState.DISCONNECTED,
                    "configured": configured,
                    "last_msg_age_ms": None,
                    "last_error": "",
                    "subscriptions": 0,
                    "events": 0,
                    "reconnects": 0,
                    "latency_ewma_ms": None,
                    "stale": False,
                    "symbols": [],
                })
                continue
            age = (now - link.last_msg_ms) if link.last_msg_ms else None
            state = link.state
            if state == ConnectionState.CONNECTED and age is not None and age > _STALE_AFTER_MS:
                state = ConnectionState.DEGRADED
            rows.append({
                "provider": name,
                "state": state,
                "configured": configured,
                "last_msg_age_ms": age,
                "last_error": link.last_error,
                "subscriptions": len(link.symbols),
                "events": link.events,
                "reconnects": link.reconnects,
                "latency_ewma_ms": round(link.latency_ewma_ms, 1) if link.latency_ewma_ms else None,
                "stale": age is not None and age > _STALE_AFTER_MS,
                "symbols": sorted(link.symbols),
            })
        return rows

    def overall_state(self) -> str:
        rows = [r for r in self.health() if r["subscriptions"] > 0]
        if not rows:
            # also consider recently disconnected links
            rows = [r for r in self.health() if r["state"] != ConnectionState.DISCONNECTED]
        if not rows:
            return ConnectionState.DISCONNECTED
        states = {r["state"] for r in rows}
        if states == {ConnectionState.CONNECTED}:
            return ConnectionState.CONNECTED
        if ConnectionState.CONNECTED in states:
            return ConnectionState.DEGRADED
        if states & {ConnectionState.CONNECTING, ConnectionState.RECONNECTING}:
            return ConnectionState.RECONNECTING
        if ConnectionState.ERROR in states:
            return ConnectionState.ERROR
        return ConnectionState.DISCONNECTED

    def stats(self) -> dict:
        return {
            "raw_ticks": self.raw_ticks,
            "ui_sends": self.ui_sends,
            "ui_drops": self.ui_drops,
            "clients": sum(1 for c in self._clients if not c.closed),
            "providers": {n: l.state for n, l in self._links.items()},
        }

    def recent_errors(self) -> list[dict]:
        return list(self._error_ring[-50:])

    def _note_error(self, provider: str, symbol: str, code: str) -> None:
        self._error_ring.append({"provider": provider, "symbol": symbol,
                                 "code": code, "ts_ms": now_ms()})
        self._error_ring = self._error_ring[-200:]
        self.bus.publish(BusEvent(
            type=EventType.DATA_ERROR,
            payload={"code": code},
            symbol=symbol,
            provider=provider,
        ))

    # ── upstream pump ─────────────────────────────────────────────
    async def _run_loop(self, provider: str, link: ProviderLink) -> None:
        first = True
        while True:
            if not link.symbols:
                self._set_state(link, ConnectionState.DISCONNECTED)
                return
            gen = link.generation
            try:
                if first:
                    self._set_state(link, ConnectionState.CONNECTING)
                else:
                    link.reconnects += 1
                    self._set_state(link, ConnectionState.RECONNECTING)
                await self._run_once(provider, link, gen)
                # clean end: if still wanted, treat as reconnect
                if not link.symbols or link.task is None or link.generation != gen:
                    return
                if link.task and link.task.cancelled():
                    return
            except asyncio.CancelledError:
                self._set_state(link, ConnectionState.DISCONNECTED)
                raise
            except Exception as e:
                if not link.symbols:
                    self._set_state(link, ConnectionState.DISCONNECTED)
                    return
                link.attempt += 1
                self._set_state(link, ConnectionState.RECONNECTING, error=str(e))
                log.warning("hub stream %s: %s", provider, e)
            delay = min(_BACKOFF_MAX_S, _BACKOFF_BASE_S * (2 ** min(link.attempt, 6)))
            await asyncio.sleep(delay)
            link.attempt = min(link.attempt + 1, 8)
            first = False

    async def _run_once(self, provider: str, link: ProviderLink, gen: int) -> None:
        p = self.registry.get(provider)
        stream_fn = getattr(p, "stream", None)
        if stream_fn is None:
            raise RuntimeError(f"{provider} has no stream capability")
        symbols = sorted(link.symbols)
        agen = stream_fn(symbols)
        link.opened_ms = now_ms()
        link.attempt = 0
        self._set_state(link, ConnectionState.CONNECTED)
        try:
            async for item in agen:
                if link.task is None or link.generation != gen or not link.symbols:
                    break
                # recompute wanted set if subscribe/unsubscribe changed mid-stream
                if set(symbols) != link.symbols and item.get("symbol") not in link.symbols:
                    # foreign symbol after refcount change — ignore for fan-out
                    # but keep reading (stream subscription is fixed until reconnect)
                    pass
                if isinstance(item, dict) and "error" in item:
                    self._set_state(link, ConnectionState.DEGRADED, error=str(item["error"]))
                    self._note_error(provider, "", "upstream_error")
                    raise RuntimeError(str(item["error"])[:200])
                await self._publish_item(provider, item, link)
        finally:
            try:
                await agen.aclose()
            except Exception:
                pass

    async def _publish_item(self, provider: str, item: dict, link: ProviderLink) -> None:
        if not isinstance(item, dict):
            return
        now = now_ms()
        link.last_msg_ms = now
        link.events += 1
        self.raw_ticks += 1
        raw_ts = item.get("ts")
        try:
            if raw_ts is None:
                provider_ts_ms = None
            else:
                fv = float(raw_ts)
                provider_ts_ms = int(fv / 1e6) if fv > 1e16 else (int(fv / 1e3) if fv > 1e12 else int(fv * 1000))
        except Exception:
            provider_ts_ms = None
        if provider_ts_ms and now >= provider_ts_ms >= 0:
            inst = now - provider_ts_ms
            link.latency_ewma_ms = inst if not link.latency_ewma_ms else (
                link.latency_ewma_ms * 0.9 + inst * 0.1
            )

        symbol = str(item.get("symbol") or "")
        # Normalize once (adapter edge)
        trade = normalize_tick(item, source=provider, receive_ms=now)
        quote = normalize_quote(item, source=provider, receive_ms=now)

        drop_reason = None
        if self.validate:
            if trade is None:
                drop_reason = "malformed_tick"
            else:
                trep = validate_tick(trade)
                if not trep.ok:
                    drop_reason = ",".join(trep.codes)
        if drop_reason:
            self._note_error(provider, symbol, drop_reason)
            # still forward a status error to subscribers? drop tick only
            return

        bus_payload = item.copy()
        bus_payload["type"] = "tick"
        bus_payload["provider"] = provider
        if provider_ts_ms:
            bus_payload["ts_ms"] = provider_ts_ms
        bus_payload["recv_ms"] = now
        self.bus.publish(BusEvent(
            type=EventType.TRADE,
            payload=bus_payload if trade is None else trade.to_dict(),
            symbol=symbol,
            provider=provider,
            provider_ts_ms=provider_ts_ms,
        ))
        if quote is not None and validate_quote(quote).ok:
            self.bus.publish(BusEvent(
                type=EventType.QUOTE,
                payload=quote.to_dict(),
                symbol=symbol,
                provider=provider,
                provider_ts_ms=provider_ts_ms,
            ))

        out = dict(item)
        out["type"] = "tick"
        out["provider"] = provider
        out["recv_ms"] = now
        out["feed"] = "live"
        await self.fanout(provider, symbol, out)

    async def fanout(self, provider: str, symbol: str, msg: dict) -> None:
        """Send tick to matching clients with a simple per-client UI budget.

        UI rate is separate from raw bus fidelity: when a client is too far
        behind we drop UI frames only (bus still has the full stream).
        """
        now = time.monotonic()
        for ch in list(self._clients):
            if ch.closed:
                continue
            if ch.provider and ch.provider != provider:
                continue
            if ch.symbols and symbol and symbol not in ch.symbols:
                continue
            # per-client soft cap ~40 msg/s for the shared chart stream
            budget = self._ui_budget.get(ch, 0.0)
            budget = min(40.0, budget + (now - self._ui_budget.get(ch, now)) * 40.0) if ch in self._ui_budget else 40.0
            if budget < 1.0:
                self.ui_drops += 1
                self._ui_budget[ch] = budget
                continue
            self._ui_budget[ch] = budget - 1.0
            self.ui_sends += 1
            await ch.emit(msg)

    async def shutdown(self) -> None:
        async with self._lock:
            for link in self._links.values():
                link.symbols.clear()
                if link.task and not link.task.done():
                    link.task.cancel()
            for ch in list(self._clients):
                await ch.close()
            self._clients.clear()


def _configured(registry, name: str) -> bool:
    try:
        p = registry.get(name)
    except Exception:
        return False
    fn = getattr(p, "configured", None)
    if callable(fn):
        try:
            return bool(fn())
        except Exception:
            return False
    if name in ("demo", "spread", "userdata"):
        return True
    return bool(getattr(p, "_key", None))
