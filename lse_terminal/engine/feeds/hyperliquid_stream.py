"""Verified Hyperliquid Perp stream (l2Book + public trades).

Contract mirrors the vendored authoritative adapter
(third_party/edgedepth-gateway/internal/hyperliquid):

- One WebSocket (``wss://api.hyperliquid.xyz/ws``) carries several
  subscriptions: ``{"method":"subscribe","subscription":{...}}``.
- ``l2Book`` data is a FULL book snapshot per message — levels[0] bids
  best-first, levels[1] asks best-first. No sequence bridge is required;
  each frame is authoritative for the book.
- ``trades`` rows: side "B" = BUY aggressor, "A" = SELL aggressor (the
  taker side is verified on the wire, never inferred).

The stream emits the same normalized event shapes the Binance depth stream
emits, so the market-data hub, WS contract and widgets need no Hyperliquid
special cases. Snapshots carry ``full_book: True`` so widgets mark the book
ready on the first frame (no diff bridging needed for snapshot feeds).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator, Optional

WS_BASE = "wss://api.hyperliquid.xyz/ws"
REST_BASE = "https://api.hyperliquid.xyz"

log = logging.getLogger(__name__)


def normalise_coin(raw: str) -> str:
    """BTC, BTCUSDT, BTC/USD, btc-usdt → the bare HL coin id (BTC)."""
    clean = str(raw or "").strip().upper().replace(".P", "").replace("-", "/")
    if "/" in clean:
        clean = clean.split("/", 1)[0]
    for suffix in ("USDT", "USDC", "USD"):
        if clean.endswith(suffix) and len(clean) > len(suffix):
            return clean[: -len(suffix)]
    return clean


# ── Parsing (pure, so it is testable without a network) ───────────────────

def parse_hl_trade(raw: dict):
    """One wsTrade row → a normalized tick dict, or None when malformed."""
    if not isinstance(raw, dict):
        return None
    try:
        price = float(raw["px"])
        size = float(raw["sz"])
        ts = int(raw.get("time") or 0)
    except (TypeError, ValueError, KeyError):
        return None
    if price <= 0 or size <= 0 or ts <= 0:
        return None
    side = str(raw.get("side") or "").upper()
    if side == "B":
        side = "buy"
    elif side == "A":
        side = "sell"
    else:
        return None  # never fabricate the aggressor side
    coin = normalise_coin(raw.get("coin") or "")
    if not coin:
        return None
    return {
        "type": "tick",
        "symbol": coin,
        "price": price,
        "size": size,
        "side": side,
        "trade_id": raw.get("tid"),
        "ts": ts,
    }


def parse_hl_book(data: dict):
    """One l2Book frame → a full-book snapshot dict, or None when malformed.

    Emits string levels (like the Binance stream) so widgets treat both
    venues through an identical code path."""
    if not isinstance(data, dict):
        return None
    coin = normalise_coin(data.get("coin") or "")
    levels = data.get("levels")
    if not coin or not isinstance(levels, list) or len(levels) != 2:
        return None
    bids, asks = [], []
    try:
        for level in levels[0]:
            bids.append([str(level["px"]), str(level["sz"])])
        for level in levels[1]:
            asks.append([str(level["px"]), str(level["sz"])])
    except (TypeError, ValueError, KeyError, IndexError):
        return None
    return {
        "type": "ORDER_BOOK_SNAPSHOT",
        "symbol": coin,
        "bids": bids,
        "asks": asks,
        "E": int(data.get("time") or 0) or None,
        "full_book": True,  # every frame is the whole visible book
    }


# ── REST: historical candles (candleSnapshot) ─────────────────────────────

_HL_INTERVALS = {"1m", "5m", "15m", "1h", "4h", "1d"}
_HL_INTERVAL_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000,
                   "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}


def fetch_candles(coin: str, interval: str = "1m", limit: int = 200,
                  *, timeout: float = 15.0) -> list[dict]:
    """Recent candles via POST /info candleSnapshot. Raises on failure —
    never returns a fabricated bar."""
    import urllib.error
    import urllib.request

    sym = normalise_coin(coin)
    key = str(interval or "").strip().lower()
    if key not in _HL_INTERVALS:
        raise ValueError(f"unsupported interval {interval!r}; valid: {sorted(_HL_INTERVALS)}")
    limit = max(1, min(int(limit), 1000))
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - _HL_INTERVAL_MS[key] * (limit + 5)  # small slack for gaps
    body = json.dumps({
        "type": "candleSnapshot",
        "req": {"coin": sym, "interval": key, "startTime": start_ms, "endTime": end_ms},
    }).encode("utf-8")

    def post() -> list:
        req = urllib.request.Request(
            f"{REST_BASE}/info", data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    rows = post()
    if not isinstance(rows, list):
        raise ValueError(f"candleSnapshot returned non-list payload: {type(rows).__name__}")
    out = []
    for row in rows[-limit:]:
        out.append({
            "time_ms": int(row["t"]),
            "open": float(row["o"]),
            "high": float(row["h"]),
            "low": float(row["l"]),
            "close": float(row["c"]),
            "volume": float(row["v"]),
        })
    return out


# ── Live stream ────────────────────────────────────────────────────────────

class HyperliquidStream:
    """l2Book + trades for one coin over a single shared WS connection."""

    def __init__(self, coin: str):
        self.coin = normalise_coin(coin)
        if not self.coin:
            raise ValueError("a coin is required")

    async def events(self) -> AsyncIterator[dict]:
        """Yield depth snapshots and trade ticks forever, reconnecting after
        an honest DEPTH_RESET (never a silent retry)."""
        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("websockets package is required for Hyperliquid") from exc
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(WS_BASE, ping_interval=20, close_timeout=5) as socket:
                    for sub in (
                        {"type": "l2Book", "coin": self.coin},
                        {"type": "trades", "coin": self.coin},
                    ):
                        await socket.send(json.dumps({"method": "subscribe", "subscription": sub}))
                    backoff = 1.0
                    async for raw_text in socket:
                        try:
                            env = json.loads(raw_text)
                        except ValueError:
                            continue
                        if not isinstance(env, dict):
                            continue
                        channel = env.get("channel")
                        data = env.get("data")
                        if channel in ("", "subscriptionResponse", "pong"):
                            # subscriptionResponse carries errors for bad subs;
                            # log it truthfully instead of swallowing.
                            if channel == "subscriptionResponse":
                                log.info("hl %s sub ack: %s", self.coin, json.dumps(data)[:160])
                            continue
                        if channel == "l2Book":
                            snap = parse_hl_book(data)
                            if snap is not None:
                                yield snap
                        elif channel == "trades" and isinstance(data, list):
                            for row in data:
                                tick = parse_hl_trade(row)
                                if tick is not None:
                                    yield tick
                        # unknown channel: ignore; logging tune from the Go
                        # adapter — "never silently swallow a wire change" is
                        # enforced at parse level (malformed rows dropped).
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                reason = (str(exc) or type(exc).__name__)[:240]
                log.warning("hl stream %s reset: %s", self.coin, reason)
                yield {"type": "DEPTH_RESET", "symbol": self.coin, "reason": reason}
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)
