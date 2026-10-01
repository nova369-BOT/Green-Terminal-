"""Asyncio client for the cTrader Open API (protobuf over TLS).

WHY NOT THE OFFICIAL SDK
------------------------
Spotware's OpenApiPy is built on Twisted and pins protobuf 3.20.1. Twisted runs
its own event loop, which fights FastAPI's asyncio loop, and the pin risks
breaking unrelated dependencies. We therefore use only Spotware's *generated
message classes* (vendored, MIT, see messages/LICENSE.spotware) and implement
the transport here in ~200 lines of asyncio.

WIRE FORMAT
-----------
Exactly what the official client does (``Int32StringReceiver``):

    [ 4-byte big-endian length ][ serialised ProtoMessage ]

``ProtoMessage`` is the envelope: ``payloadType`` selects the inner message and
``payload`` carries its bytes. Everything - requests, responses and unsolicited
events - travels in that one envelope.

AUTH SEQUENCE (help.ctrader.com/open-api/account-authentication)
    1. ProtoOAApplicationAuthReq       (clientId + clientSecret)
    2. ProtoOAGetAccountListByAccessTokenReq  -> the ctidTraderAccountIds
    3. ProtoOAAccountAuthReq           (per account, with the access token)
Only then may you request symbols or subscribe to quotes.

HONESTY
-------
This client reports what actually happened. If it is not connected, not
authenticated, or the account is not authorised, callers get an error or an
empty result - never a plausible-looking fabrication.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
import struct
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from lse_terminal.engine.ctrader import oauth
from lse_terminal.engine.ctrader.messages import OpenApiCommonMessages_pb2 as common
from lse_terminal.engine.ctrader.messages import OpenApiMessages_pb2 as msgs
from lse_terminal.engine.ctrader.messages import OpenApiModelMessages_pb2 as models

log = logging.getLogger(__name__)

__all__ = [
    "CTraderError", "CTraderClient", "Quote",
    "encode_frame", "decode_frames", "FrameBuffer",
    "PRICE_SCALE", "from_api_price",
]

# Prices arrive as integers in 1/100000 of a unit: 53423782 means 534.23782.
PRICE_SCALE = 100_000.0


def from_api_price(raw: int) -> float:
    """Integer API price -> real price."""
    return raw / PRICE_SCALE


class CTraderError(RuntimeError):
    """Any failure talking to the Open API, with the server's own words."""


# ── Framing (pure, unit-testable without a socket) ──────────────────────────

def encode_frame(payload: bytes) -> bytes:
    """Length-prefix a serialised ProtoMessage."""
    return struct.pack(">I", len(payload)) + payload


class FrameBuffer:
    """Reassembles length-prefixed frames from a TCP byte stream.

    TCP gives no message boundaries: one read can hold three frames, or half
    of one. Feed it whatever arrives and it yields only complete frames.
    """

    MAX_FRAME = 15_000_000   # matches the official client's MAX_LENGTH

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> list[bytes]:
        self._buf.extend(data)
        out: list[bytes] = []
        while len(self._buf) >= 4:
            (size,) = struct.unpack(">I", self._buf[:4])
            if size > self.MAX_FRAME:
                raise CTraderError(f"frame of {size} bytes exceeds the maximum")
            if len(self._buf) < 4 + size:
                break           # the rest has not arrived yet
            out.append(bytes(self._buf[4:4 + size]))
            del self._buf[:4 + size]
        return out

    def __len__(self) -> int:
        return len(self._buf)


def decode_frames(data: bytes) -> list[bytes]:
    """One-shot helper: split a complete buffer into frames."""
    return FrameBuffer().feed(data)


# ── Public data shapes ──────────────────────────────────────────────────────

@dataclass
class Quote:
    """A spot tick. ``bid``/``ask`` may be None: cTrader sends only what moved."""
    symbol_id: int
    symbol: str
    bid: Optional[float]
    ask: Optional[float]
    timestamp_ms: int

    @property
    def mid(self) -> Optional[float]:
        if self.bid is not None and self.ask is not None:
            return (self.bid + self.ask) / 2
        return self.bid if self.bid is not None else self.ask


@dataclass
class _Pending:
    future: asyncio.Future
    sent_at: float = field(default_factory=time.time)


# ── Client ──────────────────────────────────────────────────────────────────

class CTraderClient:
    """One TLS connection to a cTrader proxy, authenticated for one account.

    Usage::

        c = CTraderClient()
        await c.connect()                 # TLS + application auth
        accounts = await c.account_list() # discovers ctidTraderAccountId
        await c.authorise_account(accounts[0]["ctidTraderAccountId"])
        await c.load_symbols()
        await c.subscribe_spots(["US30"], on_quote=handler)
    """

    HEARTBEAT_SECONDS = 10      # the server drops idle connections after ~30s
    REQUEST_TIMEOUT = 30.0

    def __init__(self, host: Optional[str] = None, port: Optional[int] = None,
                 *, access_token: Optional[str] = None):
        self.host = host or oauth.host_for_env()
        self.port = port or oauth.PROTOBUF_PORT
        self._explicit_token = access_token

        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._buffer = FrameBuffer()
        self._reader_task: Optional[asyncio.Task] = None
        self._heartbeat_task: Optional[asyncio.Task] = None

        self._pending: dict[str, _Pending] = {}
        self._msg_id = 0
        self._connected = False
        self._app_authed = False
        self.account_id: int = 0

        # symbolId <-> name, filled by load_symbols(); never hardcoded because
        # the docs warn "different brokers might have different IDs".
        self.symbols_by_name: dict[str, int] = {}
        self.symbols_by_id: dict[int, str] = {}

        self._quote_handlers: list[Callable[[Quote], Awaitable[None] | None]] = []
        self.last_error: str = ""

    # -- state ------------------------------------------------------------
    @property
    def connected(self) -> bool:
        return self._connected and self._writer is not None and not self._writer.is_closing()

    def status(self) -> dict:
        return {
            "connected": self.connected,
            "app_authenticated": self._app_authed,
            "account_id": self.account_id,
            "host": self.host,
            "port": self.port,
            "symbols_loaded": len(self.symbols_by_name),
            "last_error": self.last_error,
        }

    # -- transport ---------------------------------------------------------
    def _next_id(self) -> str:
        self._msg_id += 1
        return str(self._msg_id)

    async def connect(self) -> None:
        """Open TLS and authenticate the application."""
        if self.connected:
            return
        ctx = ssl.create_default_context()
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port, ssl=ctx), timeout=20)
        except (OSError, asyncio.TimeoutError) as e:
            self.last_error = f"cannot reach {self.host}:{self.port}: {e}"
            raise CTraderError(self.last_error) from e

        self._connected = True
        self._buffer = FrameBuffer()
        self._reader_task = asyncio.create_task(self._read_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        await self._application_auth()

    async def close(self) -> None:
        self._connected = False
        for task in (self._reader_task, self._heartbeat_task):
            if task:
                task.cancel()
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
        self._writer = self._reader = None
        self._app_authed = False
        for p in self._pending.values():
            if not p.future.done():
                p.future.set_exception(CTraderError("connection closed"))
        self._pending.clear()

    async def _send(self, message, client_msg_id: Optional[str] = None) -> None:
        if not self._writer:
            raise CTraderError("not connected")
        envelope = common.ProtoMessage()
        envelope.payloadType = message.payloadType
        envelope.payload = message.SerializeToString()
        if client_msg_id:
            envelope.clientMsgId = client_msg_id
        self._writer.write(encode_frame(envelope.SerializeToString()))
        await self._writer.drain()

    async def request(self, message, *, timeout: Optional[float] = None):
        """Send a request and await its matching response (by clientMsgId)."""
        msg_id = self._next_id()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = _Pending(fut)
        try:
            await self._send(message, client_msg_id=msg_id)
            return await asyncio.wait_for(fut, timeout or self.REQUEST_TIMEOUT)
        except asyncio.TimeoutError as e:
            raise CTraderError(
                f"no response to {type(message).__name__} within "
                f"{timeout or self.REQUEST_TIMEOUT}s") from e
        finally:
            self._pending.pop(msg_id, None)

    async def _read_loop(self) -> None:
        try:
            while self._connected and self._reader:
                data = await self._reader.read(65536)
                if not data:
                    self.last_error = "server closed the connection"
                    break
                for frame in self._buffer.feed(data):
                    try:
                        self._dispatch(frame)
                    except Exception:
                        log.exception("ctrader: failed to handle a frame")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.last_error = f"read loop ended: {e}"
            log.warning("ctrader: %s", self.last_error)
        finally:
            self._connected = False

    async def _heartbeat_loop(self) -> None:
        """The proxy closes idle connections; a periodic heartbeat holds it."""
        try:
            while self._connected:
                await asyncio.sleep(self.HEARTBEAT_SECONDS)
                if self._writer and not self._writer.is_closing():
                    await self._send(common.ProtoHeartbeatEvent())
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.debug("ctrader: heartbeat stopped: %s", e)

    # -- dispatch ----------------------------------------------------------
    def _dispatch(self, frame: bytes) -> None:
        envelope = common.ProtoMessage()
        envelope.ParseFromString(frame)
        ptype = envelope.payloadType
        payload = envelope.payload
        msg_id = envelope.clientMsgId or ""

        # Errors must reject the waiting caller rather than time out silently.
        if ptype == msgs.ProtoOAErrorRes().payloadType:
            err = msgs.ProtoOAErrorRes(); err.ParseFromString(payload)
            text = f"{err.errorCode}: {err.description}" if err.description else err.errorCode
            self.last_error = text
            pending = self._pending.get(msg_id)
            if pending and not pending.future.done():
                pending.future.set_exception(CTraderError(text))
            else:
                log.warning("ctrader error (unsolicited): %s", text)
            return

        if ptype == common.ProtoHeartbeatEvent().payloadType:
            return

        # Unsolicited market data.
        if ptype == msgs.ProtoOASpotEvent().payloadType:
            self._on_spot(payload)
            return

        pending = self._pending.get(msg_id)
        if pending and not pending.future.done():
            pending.future.set_result((ptype, payload))

    def _on_spot(self, payload: bytes) -> None:
        ev = msgs.ProtoOASpotEvent(); ev.ParseFromString(payload)
        quote = Quote(
            symbol_id=ev.symbolId,
            symbol=self.symbols_by_id.get(ev.symbolId, str(ev.symbolId)),
            bid=from_api_price(ev.bid) if ev.HasField("bid") else None,
            ask=from_api_price(ev.ask) if ev.HasField("ask") else None,
            timestamp_ms=ev.timestamp if ev.HasField("timestamp") else int(time.time() * 1000),
        )
        for handler in self._quote_handlers:
            try:
                result = handler(quote)
                if asyncio.iscoroutine(result):
                    asyncio.create_task(result)
            except Exception:
                log.exception("ctrader: quote handler raised")

    # -- authentication ----------------------------------------------------
    def _access_token(self) -> str:
        return self._explicit_token or oauth.access_token()

    async def _application_auth(self) -> None:
        client_id, client_secret = oauth.app_credentials()
        req = msgs.ProtoOAApplicationAuthReq()
        req.clientId = client_id
        req.clientSecret = client_secret
        await self.request(req)
        self._app_authed = True

    async def account_list(self) -> list[dict]:
        """Accounts this token covers - this is how ctidTraderAccountId is
        discovered, rather than asking the user to copy a number."""
        req = msgs.ProtoOAGetAccountListByAccessTokenReq()
        req.accessToken = self._access_token()
        _, payload = await self.request(req)
        res = msgs.ProtoOAGetAccountListByAccessTokenRes()
        res.ParseFromString(payload)
        return [{
            "ctidTraderAccountId": a.ctidTraderAccountId,
            "isLive": a.isLive,
            "traderLogin": a.traderLogin,
            "broker": a.brokerTitleShort,
        } for a in res.ctidTraderAccount]

    async def authorise_account(self, ctid_trader_account_id: int) -> None:
        req = msgs.ProtoOAAccountAuthReq()
        req.ctidTraderAccountId = ctid_trader_account_id
        req.accessToken = self._access_token()
        await self.request(req)
        self.account_id = ctid_trader_account_id

    async def ensure_account(self) -> int:
        """Authorise the pinned account, or the first one the token covers."""
        if self.account_id:
            return self.account_id
        pinned = oauth.account_id()
        accounts = await self.account_list()
        if not accounts:
            raise CTraderError("this access token covers no trading accounts")
        want_live = oauth.environment() == "live"
        chosen = next((a for a in accounts if a["ctidTraderAccountId"] == pinned), None)
        if chosen is None:
            # Prefer an account matching the configured environment: a demo
            # token cannot authorise a live account and vice versa.
            chosen = next((a for a in accounts if a["isLive"] == want_live), accounts[0])
        await self.authorise_account(chosen["ctidTraderAccountId"])
        return self.account_id

    # -- symbols -----------------------------------------------------------
    async def load_symbols(self) -> dict[str, int]:
        """Resolve names to this broker's symbol IDs (they differ per broker)."""
        await self.ensure_account()
        req = msgs.ProtoOASymbolsListReq()
        req.ctidTraderAccountId = self.account_id
        _, payload = await self.request(req)
        res = msgs.ProtoOASymbolsListRes()
        res.ParseFromString(payload)
        self.symbols_by_name = {s.symbolName: s.symbolId for s in res.symbol}
        self.symbols_by_id = {v: k for k, v in self.symbols_by_name.items()}
        return dict(self.symbols_by_name)

    def resolve_symbol(self, name: str) -> int:
        """Symbol id for a name, case-insensitively, else a helpful error."""
        if not self.symbols_by_name:
            raise CTraderError("symbols not loaded; call load_symbols() first")
        if name in self.symbols_by_name:
            return self.symbols_by_name[name]
        lowered = {k.lower(): v for k, v in self.symbols_by_name.items()}
        if name.lower() in lowered:
            return lowered[name.lower()]
        close = [k for k in self.symbols_by_name if name.lower() in k.lower()][:8]
        raise CTraderError(
            f"symbol {name!r} is not offered on this account"
            + (f"; did you mean {close}?" if close else ""))

    # -- subscriptions -----------------------------------------------------
    def on_quote(self, handler: Callable[[Quote], Awaitable[None] | None]) -> None:
        self._quote_handlers.append(handler)

    async def subscribe_spots(self, symbols: list[str], *,
                              on_quote: Optional[Callable] = None) -> list[int]:
        """Subscribe to tick quotes. These ticks drive the footprint."""
        await self.ensure_account()
        if not self.symbols_by_name:
            await self.load_symbols()
        if on_quote:
            self.on_quote(on_quote)
        ids = [self.resolve_symbol(s) for s in symbols]
        req = msgs.ProtoOASubscribeSpotsReq()
        req.ctidTraderAccountId = self.account_id
        req.symbolId.extend(ids)
        await self.request(req)
        return ids

    async def unsubscribe_spots(self, symbols: list[str]) -> None:
        ids = [self.resolve_symbol(s) for s in symbols]
        req = msgs.ProtoOAUnsubscribeSpotsReq()
        req.ctidTraderAccountId = self.account_id
        req.symbolId.extend(ids)
        await self.request(req)
