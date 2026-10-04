"""Real-time order-flow recorder — powers the LSE chart's native RT view.

WHAT THIS IS
------------
The first EdgeDepth feature ported natively onto the LSE chart (user decree:
take the G-Flow chart's views one by one and put them on the LSE chart; the
LSE chart stays the one and only chart). This module records, live from a
crypto venue, exactly what the RT view draws:

  * depth columns  — 1 Hz samples of the order book (bid/ask price+size
                     arrays), the heatmap's vertical stripes
  * venue trades   — real prints with the venue's own aggressor flag,
                     drawn as the trade-price line and trade bubbles

DATA DOCTRINE (user decree, repeated twice — do not violate)
------------------------------------------------------------
* Chart candles come from the broker/LSE feed. NEVER from here.
* Flow comes from crypto venues only. Venue chain: Binance spot first,
  Hyperliquid fallback (vital: some ISPs — e.g. the user's — block Binance
  while Hyperliquid stays reachable).
* Symbols with no crypto venue (gold, FX, stocks) get an honest
  ``{"flow": "none"}`` with a reason. Nothing is simulated in their place.
* Aggressor side is the venue's own flag (Binance ``m``, Hyperliquid
  ``side``) — never inferred from price movement here.

HONESTY RULES
-------------
A venue that cannot be reached is reported as exactly that, with the real
error string. A book that has gone stale (no update for 10 s) stops sampling
and reports ``connected: false`` rather than freezing a stale picture that
looks live. There is no demo mode and no fallback data.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from datetime import datetime, timezone
from typing import Deque, Optional

from .feeds.binance import WS_BASE as BINANCE_WS_BASE
from .feeds.binance import normalise_symbol as binance_normalise_symbol
from .feeds.binance import parse_agg_trade
from .feeds.binance_depth_stream import BinanceDepthStream

log = logging.getLogger(__name__)

HL_WS_URL = "wss://api.hyperliquid.xyz/ws"
HL_INFO_URL = "https://api.hyperliquid.xyz/info"
BINANCE_PING_URL = "https://api.binance.com/api/v3/ping"
# Reported liquidations: Binance spot has none, but the SAME coin's perp on
# Binance futures publishes forced orders — real reports, clearly labelled as
# the perp market's. Hyperliquid has no public liquidation feed (repo rule) —
# that gap is reported honestly, never filled with guesses.
BINANCE_FUTURES_WS = "wss://fstream.binance.com/ws"

# Book considered stale (connection trouble) after this many ms without an
# update — sampling pauses and status turns honest-amber.
STALE_MS = 10_000
SAMPLE_SECONDS = 1.0
DEPTH_LEVELS = 60          # price levels kept per side per column
COLUMN_RING = 900          # ≈15 minutes of 1 Hz columns
TRADE_RING = 20_000
LIQ_RING = 5_000
SESSION_IDLE_STOP_S = 600  # stop recording when nobody polled for 10 min

# Coins with a real market on the venue chain. The list is deliberately
# explicit: guessing "every 3-letter prefix is a coin" would route EURUSD to
# a venue and violate the doctrine. Extend as needed.
KNOWN_COINS = {
    "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "LTC",
    "BCH", "UNI", "ATOM", "NEAR", "ARB", "OP", "APT", "SUI", "INJ", "TIA",
    "SEI", "FIL", "AAVE", "MKR", "CRV", "LDO", "PEPE", "SHIB", "WIF", "BONK",
    "TRX", "TON", "MATIC", "POL", "ETC", "XLM", "ALGO", "HBAR", "ICP", "RENDER",
    "FET", "TAO", "ENA", "JUP", "PYTH", "WLD", "ORDI", "STX", "RUNE", "DYDX",
    "HYPE", "ZEC", "SAND", "GALA", "AXS", "MANA", "EOS", "XTZ", "COMP", "SNX",
}
_QUOTE_SUFFIXES = ("USDT", "USDC", "USD", "PERP", "EUR", "GBP")


def normalise_coin(symbol: str) -> Optional[str]:
    """Map a GT chart symbol to a crypto coin, or None when there is no venue.

    ``DEMO:BTC`` → BTC · ``BTC/USDT`` → BTC · ``ETHUSD`` → ETH ·
    ``DEMO:GOLD`` → None · ``EURUSD`` → None (EUR is not a coin — FX is
    honestly flow-less until a venue that really trades it exists).
    """
    if not symbol:
        return None
    s = symbol.strip().upper()
    if ":" in s:
        s = s.split(":", 1)[1]
    s = s.replace("/", "").replace("-", "").replace("_", "")
    for suffix in _QUOTE_SUFFIXES:
        if s.endswith(suffix) and len(s) > len(suffix):
            s = s[: -len(suffix)]
            break
    return s if s in KNOWN_COINS else None


def build_column(bids: dict, asks: dict, at_ms: int, levels: int = DEPTH_LEVELS) -> Optional[dict]:
    """Snapshot the top N levels of a live book into one heatmap column.

    Pure: dict in, dict out. Returns None for an empty book (no column is
    better than a fake one). Output keys match the chart renderer's
    HeatmapSnapshot shape exactly, so the dormant Bookmap renderer draws it
    without translation.
    """
    if not bids and not asks:
        return None
    top_bids = sorted(bids.items(), key=lambda kv: -float(kv[0]))[:levels]
    top_asks = sorted(asks.items(), key=lambda kv: float(kv[0]))[:levels]
    best_bid = float(top_bids[0][0]) if top_bids else None
    best_ask = float(top_asks[0][0]) if top_asks else None
    mid = (best_bid + best_ask) / 2.0 if best_bid and best_ask else (best_bid or best_ask)
    return {
        "t": at_ms,
        "timestamp": datetime.fromtimestamp(at_ms / 1000.0, timezone.utc).isoformat(),
        "mid": mid,
        "bids_prices": [float(p) for p, _ in top_bids],
        "bids_sizes": [float(q) for _, q in top_bids],
        "asks_prices": [float(p) for p, _ in top_asks],
        "asks_sizes": [float(q) for _, q in top_asks],
    }


def parse_hl_l2book(data: dict) -> tuple[dict, dict, int]:
    """Hyperliquid l2Book message → ({bid_px: sz}, {ask_px: sz}, time_ms).

    HL pushes the FULL book snapshot each message:
    ``{"coin","time","levels":[[{px,sz,n}...bids],[{px,sz,n}...asks]]}``.
    """
    levels = data.get("levels") or [[], []]
    bids = {float(l["px"]): float(l["sz"]) for l in levels[0]}
    asks = {float(l["px"]): float(l["sz"]) for l in levels[1]}
    return bids, asks, int(data.get("time") or 0)


def parse_binance_force_order(raw: dict) -> Optional[dict]:
    """Binance futures forceOrder event → normalized liquidation dict.

    ``{"e":"forceOrder","o":{"s":"BTCUSDT","S":"SELL","q":"0.014",
    "ap":"84321.1","T":1700000000000,...}}``. S is the LIQUIDATION order's
    side (provider truth): SELL = a long was liquidated, BUY = a short was.
    """
    o = raw.get("o") or {}
    try:
        qty = float(o.get("q") or 0)
        price = float(o.get("ap") or o.get("p") or 0)
    except (TypeError, ValueError):
        return None
    if qty <= 0 or price <= 0:
        return None
    return {
        "t": int(o.get("T") or 0),
        "p": price,
        "q": qty,
        "side": "sell" if (o.get("S") == "SELL") else "buy",
        "notional": qty * price,
    }


def parse_hl_trades(data: list) -> list[dict]:
    """Hyperliquid trades message → normalized trade dicts.

    HL ``side``: "B" = the taker BOUGHT, "A" = the taker SOLD. That is the
    venue's own aggressor flag — provider truth, no inference.
    """
    out = []
    for t in data or []:
        side = t.get("side")
        out.append({
            "t": int(t.get("time") or 0),
            "p": float(t.get("px") or 0),
            "q": float(t.get("sz") or 0),
            "side": "buy" if side == "B" else "sell",
        })
    return out


async def _probe(url: str, *, body: Optional[dict] = None, timeout: float = 3.0) -> Optional[str]:
    """Reachability probe. Returns None when OK, else the real error string."""
    import urllib.request

    def hit() -> None:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            url, data=data,
            headers={"Content-Type": "application/json"} if data else {},
        )
        with urllib.request.urlopen(req, timeout=timeout):
            pass

    try:
        await asyncio.to_thread(hit)
        return None
    except Exception as exc:  # noqa: BLE001 — the string IS the honest status
        return f"{type(exc).__name__}: {exc}"[:240]


class RTSession:
    """One live recording: venue connection + 1 Hz sampler for one coin."""

    def __init__(self, coin: str):
        self.coin = coin
        self.venue: Optional[str] = None
        self.error: Optional[str] = None
        self.columns: Deque[dict] = deque(maxlen=COLUMN_RING)
        self.trades: Deque[dict] = deque(maxlen=TRADE_RING)
        self.liqs: Deque[dict] = deque(maxlen=LIQ_RING)
        self.book_bids: dict = {}
        self.book_asks: dict = {}
        self.book_at_ms: int = 0
        self.last_poll = time.time()
        self.started_ms = _now_ms()
        # Honest capture accounting: ring overflow DROPS the oldest records.
        # The UI shows the real count instead of pretending nothing was lost.
        self.cols_dropped = 0
        self.trades_dropped = 0
        self._tasks: list[asyncio.Task] = []
        self._started = False

    def clear(self) -> None:
        """User-requested Clear history: recorded data goes, the live
        connection stays (the session keeps recording from now)."""
        self.columns.clear()
        self.trades.clear()
        self.liqs.clear()
        self.cols_dropped = 0
        self.trades_dropped = 0
        self.started_ms = _now_ms()

    # ── lifecycle ────────────────────────────────────────────────────────
    def ensure_started(self) -> None:
        if not self._started:
            self._started = True
            self._tasks.append(asyncio.get_running_loop().create_task(self._run()))

    def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        self._tasks.clear()
        self._started = False

    @property
    def connected(self) -> bool:
        return bool(self.venue) and (_now_ms() - self.book_at_ms) < STALE_MS

    def _push_trades(self, trades: list[dict]) -> None:
        for tr in trades:
            if len(self.trades) == TRADE_RING:
                self.trades_dropped += 1
            self.trades.append(tr)

    # ── main driver: pick a reachable venue, then record ────────────────
    async def _run(self) -> None:
        while True:
            binance_err = await _probe(BINANCE_PING_URL)
            if binance_err is None:
                self.venue, self.error = "binance", None
                await self._record(self._run_binance())
            else:
                hl_err = await _probe(HL_INFO_URL, body={"type": "meta"}, timeout=4.0)
                if hl_err is None:
                    self.venue, self.error = "hyperliquid", None
                    await self._record(self._run_hyperliquid())
                else:
                    self.venue = None
                    self.error = (
                        f"Binance unreachable ({binance_err}); "
                        f"Hyperliquid unreachable ({hl_err}). No live flow can be "
                        f"recorded from a host that cannot reach a venue — if your "
                        f"ISP blocks the exchange, run Green Terminal behind a VPN. "
                        f"Nothing is simulated in its place."
                    )
                    await asyncio.sleep(30)

    async def _record(self, feed_coro) -> None:
        """Run one venue feed + the sampler until the feed dies, then return
        to venue selection (the feed itself reconnects on transient errors)."""
        feed = asyncio.get_running_loop().create_task(feed_coro)
        sampler = asyncio.get_running_loop().create_task(self._sample_loop())
        try:
            await feed
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover — defensive
            self.error = str(exc)[:240]
        finally:
            sampler.cancel()
            feed.cancel()

    async def _sample_loop(self) -> None:
        while True:
            await asyncio.sleep(SAMPLE_SECONDS)
            # An out-of-date book is NOT sampled: a frozen-but-growing heatmap
            # would read as a live market. connected=False tells the truth.
            if (_now_ms() - self.book_at_ms) >= STALE_MS:
                continue
            col = build_column(self.book_bids, self.book_asks, _now_ms())
            if col is not None:
                if len(self.columns) == COLUMN_RING:
                    self.cols_dropped += 1
                self.columns.append(col)

    # ── Binance spot: sequence-checked depth + aggTrade prints ──────────
    async def _run_binance(self) -> None:
        pair = binance_normalise_symbol(self.coin + "USDT")
        loop = asyncio.get_running_loop()
        depth = loop.create_task(self._binance_depth(pair))
        liqs = loop.create_task(self._binance_liquidations(pair))
        try:
            await self._binance_trades(pair)
        finally:
            depth.cancel()
            liqs.cancel()

    async def _binance_depth(self, pair: str) -> None:
        async for ev in BinanceDepthStream(pair, levels=1000).events():
            kind = ev.get("type")
            if kind == "ORDER_BOOK_SNAPSHOT":
                self.book_bids = {p: q for p, q in ((float(a), float(b)) for a, b in ev["bids"]) if q > 0}
                self.book_asks = {p: q for p, q in ((float(a), float(b)) for a, b in ev["asks"]) if q > 0}
                self.book_at_ms = int(ev.get("E") or _now_ms())
            elif kind == "ORDER_BOOK_UPDATE":
                for raw_p, raw_q in ev.get("b", []):
                    p, q = float(raw_p), float(raw_q)
                    if q <= 0:
                        self.book_bids.pop(p, None)
                    else:
                        self.book_bids[p] = q
                for raw_p, raw_q in ev.get("a", []):
                    p, q = float(raw_p), float(raw_q)
                    if q <= 0:
                        self.book_asks.pop(p, None)
                    else:
                        self.book_asks[p] = q
                self.book_at_ms = int(ev.get("E") or _now_ms())
            elif kind == "DEPTH_RESET":
                self.book_bids, self.book_asks = {}, {}

    async def _binance_trades(self, pair: str) -> None:
        import websockets
        url = f"{BINANCE_WS_BASE}/{pair.lower()}@aggTrade"
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(url, ping_interval=20, close_timeout=5) as sock:
                    backoff = 1.0
                    async for raw in sock:
                        tick = parse_agg_trade(json.loads(raw))
                        self._push_trades([{
                            "t": tick.time_ms, "p": tick.price,
                            "q": tick.size, "side": tick.side,
                        }])
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("binance aggTrade %s reset: %s", pair, exc)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    async def _binance_liquidations(self, pair: str) -> None:
        """Reported liquidations from the coin's Binance futures perp.

        Real forced orders from the venue, labelled as the perp market's.
        Spot has no liquidations; nothing is invented for it.
        """
        import websockets
        url = f"{BINANCE_FUTURES_WS}/{pair.lower()}@forceOrder"
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(url, ping_interval=20, close_timeout=5) as sock:
                    backoff = 1.0
                    async for raw in sock:
                        liq = parse_binance_force_order(json.loads(raw))
                        if liq is not None:
                            self.liqs.append(liq)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("binance forceOrder %s reset: %s", pair, exc)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    # ── Hyperliquid: full-book l2Book pushes + trades, 30 s pings ───────
    async def _run_hyperliquid(self) -> None:
        import websockets
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(HL_WS_URL, ping_interval=None, close_timeout=5) as sock:
                    backoff = 1.0
                    # HL symbols are UPPERCASE coins (repo rule).
                    for sub_type in ("l2Book", "trades"):
                        await sock.send(json.dumps({
                            "method": "subscribe",
                            "subscription": {"type": sub_type, "coin": self.coin},
                        }))
                    last_ping = time.time()
                    while True:
                        if time.time() - last_ping > 30:
                            await sock.send(json.dumps({"method": "ping"}))
                            last_ping = time.time()
                        raw = await asyncio.wait_for(sock.recv(), timeout=45)
                        msg = json.loads(raw)
                        channel = msg.get("channel")
                        if channel == "l2Book":
                            self.book_bids, self.book_asks, at = parse_hl_l2book(msg.get("data") or {})
                            self.book_at_ms = at or _now_ms()
                        elif channel == "trades":
                            self._push_trades(parse_hl_trades(msg.get("data") or []))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("hyperliquid rt %s reset: %s", self.coin, exc)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    # ── poll payload ─────────────────────────────────────────────────────
    def payload(self, cols_after: float, trades_after: float,
                liqs_after: float = 0.0) -> dict:
        self.last_poll = time.time()
        cols = [c for c in self.columns if c["t"] > cols_after]
        trds = [t for t in self.trades if t["t"] > trades_after][-4000:]
        lqs = [x for x in self.liqs if x["t"] > liqs_after][-1000:]
        # Session accounting (honest): real recorded span and a byte estimate
        # of what is held, so the SESSION row shows the truth.
        recorded_ms = 0
        if self.columns:
            recorded_ms = self.columns[-1]["t"] - self.columns[0]["t"]
        approx_bytes = len(self.columns) * (DEPTH_LEVELS * 2 * 16 + 96) \
            + len(self.trades) * 40 + len(self.liqs) * 48
        return {
            "flow": "ok" if self.venue else "error",
            "coin": self.coin,
            "venue": self.venue,
            "connected": self.connected,
            "error": self.error,
            "columns": cols,
            "trades": trds,
            "liqs": lqs,
            # Liquidation provenance, stated plainly: real reports from the
            # Binance perp, or an honest "none published" on Hyperliquid.
            "liq_source": ("binance-futures perp reports" if self.venue == "binance"
                           else "none — Hyperliquid publishes no public liquidation feed"
                           if self.venue == "hyperliquid" else None),
            "recorded_ms": recorded_ms,
            "approx_bytes": approx_bytes,
            "cols_dropped": self.cols_dropped,
            "trades_dropped": self.trades_dropped,
            "now": _now_ms(),
        }


def _now_ms() -> int:
    return int(time.time() * 1000)


class RTFlowManager:
    """Session registry + idle GC. One session per coin, shared by viewers."""

    def __init__(self) -> None:
        self.sessions: dict[str, RTSession] = {}
        self._gc_task: Optional[asyncio.Task] = None

    async def poll(self, symbol: str, cols_after: float, trades_after: float,
                   liqs_after: float = 0.0) -> dict:
        coin = normalise_coin(symbol)
        if coin is None:
            return {
                "flow": "none",
                "coin": None,
                "reason": (
                    f"{symbol.upper()} has no crypto venue: the Real-time view "
                    f"needs live venue depth and trades, and nothing is simulated "
                    f"in their place. Chart candles are unaffected."
                ),
                "columns": [], "trades": [], "liqs": [], "now": _now_ms(),
            }
        if self._gc_task is None:
            self._gc_task = asyncio.get_running_loop().create_task(self._gc_loop())
        sess = self.sessions.get(coin)
        if sess is None:
            sess = self.sessions[coin] = RTSession(coin)
        sess.ensure_started()
        return sess.payload(cols_after, trades_after, liqs_after)

    def clear(self, symbol: str) -> dict:
        """Clear history for the symbol's session (keeps recording live)."""
        coin = normalise_coin(symbol)
        sess = self.sessions.get(coin) if coin else None
        if sess is not None:
            sess.clear()
        return {"cleared": bool(sess), "coin": coin}

    async def _gc_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.time()
            for coin, sess in list(self.sessions.items()):
                if now - sess.last_poll > SESSION_IDLE_STOP_S:
                    sess.stop()
                    del self.sessions[coin]


rt_flow_manager = RTFlowManager()
