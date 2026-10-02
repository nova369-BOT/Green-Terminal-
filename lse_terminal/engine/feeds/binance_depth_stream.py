"""Verified Binance diff-depth stream.

The stream emits normalized dictionaries consumed by MarketData's depth route:
ORDER_BOOK_SNAPSHOT, ORDER_BOOK_UPDATE, and DEPTH_RESET. It never emits a
partial book as ready data; sequence gaps force a reset signal.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from .binance import REST_BASE, WS_BASE, normalise_symbol
from .binance_depth import DepthSequenceError, LocalOrderBook, parse_snapshot, parse_update

log = logging.getLogger(__name__)


class BinanceDepthStream:
    def __init__(self, symbol: str, *, levels: int = 1000):
        self.symbol = normalise_symbol(symbol)
        if not self.symbol:
            raise ValueError("a symbol is required")
        self.levels = max(5, min(int(levels), 5000))
        self.snapshot_url = f"{REST_BASE}/api/v3/depth?symbol={self.symbol}&limit={self.levels}"
        self.ws_url = f"{WS_BASE}/{self.symbol.lower()}@depth@100ms"

    async def _snapshot(self) -> dict:
        import urllib.request
        def get() -> dict:
            req = urllib.request.Request(self.snapshot_url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        return await asyncio.to_thread(get)

    async def events(self) -> AsyncIterator[dict]:
        """Yield depth events forever, reconnecting after a reset or failure."""
        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("websockets package is required for Binance depth") from exc
        backoff = 1.0
        while True:
            book = LocalOrderBook(self.symbol)
            try:
                async with websockets.connect(self.ws_url, ping_interval=20,
                                              close_timeout=5, open_timeout=10) as socket:
                    # Binance's documented order is snapshot then buffered
                    # diffs. The socket is opened first so updates are not
                    # missed while the REST snapshot is requested.
                    buffered: list[dict] = []
                    snapshot_task = asyncio.create_task(self._snapshot())
                    try:
                        while not snapshot_task.done():
                            # The 100ms stream is never quiet: a recv silent for
                            # this long means the connection is dead to us no
                            # matter what ping/pong claims (middleboxes ping
                            # back while dropping application frames).
                            raw = json.loads(await asyncio.wait_for(socket.recv(), timeout=25.0))
                            if raw.get("s", "").upper() == self.symbol:
                                buffered.append(raw)
                    except asyncio.TimeoutError:
                        # Do not leak the urllib job between reconnects.
                        snapshot_task.cancel()
                        raise TimeoutError("depth stream silent while waiting for REST snapshot")
                    try:
                        snapshot = await asyncio.wait_for(snapshot_task, timeout=30.0)
                    except asyncio.TimeoutError:
                        # A REST fetch may hang forever behind a DNS stall or
                        # a byte-trickling blackholed connection — per-op
                        # timeouts inside urllib do not bound that. Without a
                        # hard deadline the generator would hang without ever
                        # yielding, leaving every consumer permanently
                        # "syncing" with no reset reason.
                        snapshot_task.cancel()
                        raise TimeoutError("depth snapshot fetch hung past 30s — venue blocked or unreachable")
                    snapshot = parse_snapshot(snapshot)
                    book.apply_snapshot(snapshot)
                    yield {"type": "ORDER_BOOK_SNAPSHOT", "symbol": self.symbol,
                           "lastUpdateId": snapshot.last_update_id,
                           "bids": [[str(x.price), str(x.quantity)] for x in snapshot.bids],
                           "asks": [[str(x.price), str(x.quantity)] for x in snapshot.asks],
                           "E": snapshot.event_time_ms}
                    for raw in buffered:
                        update = parse_update(raw)
                        try:
                            book.apply_update(update)
                        except DepthSequenceError:
                            raise
                        yield self._update_payload(update)
                    backoff = 1.0
                    while True:
                        # Steady phase: the 100ms depth feed is never quiet;
                        # 30s without an application frame means a middlebox
                        # answering pings while dropping traffic. Without this
                        # deadline the generator hangs forever and every widget
                        # shows "Syncing" with no DEPTH_RESET to drive failover.
                        try:
                            raw_text = await asyncio.wait_for(socket.recv(), timeout=30.0)
                        except asyncio.TimeoutError:
                            raise TimeoutError("depth stream silent after snapshot — middlebox alive but frames dropped")
                        update = parse_update(json.loads(raw_text))
                        book.apply_update(update)
                        yield self._update_payload(update)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # str() can be empty for bare async exceptions (e.g. a bare
                # ConnectionError from websockets); fall back to the exception
                # class so the consumer never shows a blank reason.
                reason = (str(exc) or type(exc).__name__)[:240]
                log.warning("binance depth %s reset: %s", self.symbol, reason)
                yield {"type": "DEPTH_RESET", "symbol": self.symbol, "reason": reason}
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    def _update_payload(self, update) -> dict:
        return {
            "type": "ORDER_BOOK_UPDATE", "symbol": self.symbol,
            "U": update.first_update_id, "u": update.final_update_id,
            "b": [[str(x.price), str(x.quantity)] for x in update.bids],
            "a": [[str(x.price), str(x.quantity)] for x in update.asks],
            "E": update.event_time_ms,
        }
