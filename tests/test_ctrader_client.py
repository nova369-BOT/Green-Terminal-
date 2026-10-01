"""Tests for the cTrader asyncio client.

No network. The framing and dispatch logic is exercised directly, because
that is where a hand-written protobuf transport actually goes wrong: split
packets, coalesced packets, error responses that must reject the caller
instead of hanging, and symbol IDs that differ per broker.
"""

import asyncio
import os
import struct
import tempfile

from lse_terminal.engine.ctrader import client as cc
from lse_terminal.engine.ctrader.messages import OpenApiCommonMessages_pb2 as common
from lse_terminal.engine.ctrader.messages import OpenApiMessages_pb2 as msgs


def _isolate():
    os.environ["LSE_TERMINAL_CONFIG_DIR"] = tempfile.mkdtemp(prefix="ct-client-")
    os.environ["CTRADER_CLIENT_ID"] = "cid"
    os.environ["CTRADER_CLIENT_SECRET"] = "sec"


# ── framing ────────────────────────────────────────────────────────────────

def test_encode_frame_is_4_byte_big_endian_length_prefixed():
    body = b"hello"
    frame = cc.encode_frame(body)
    assert frame[:4] == struct.pack(">I", 5)
    assert frame[4:] == body


def test_buffer_reassembles_a_frame_split_across_reads():
    """TCP can deliver half a frame; nothing may be emitted until it is whole."""
    buf = cc.FrameBuffer()
    frame = cc.encode_frame(b"abcdefghij")
    assert buf.feed(frame[:3]) == []     # not even the length word yet
    assert buf.feed(frame[3:7]) == []    # length known, body incomplete
    assert buf.feed(frame[7:]) == [b"abcdefghij"]


def test_buffer_splits_several_frames_from_one_read():
    buf = cc.FrameBuffer()
    data = cc.encode_frame(b"one") + cc.encode_frame(b"two") + cc.encode_frame(b"three")
    assert buf.feed(data) == [b"one", b"two", b"three"]


def test_buffer_keeps_a_trailing_partial_frame_for_later():
    buf = cc.FrameBuffer()
    data = cc.encode_frame(b"done") + cc.encode_frame(b"partial")[:5]
    assert buf.feed(data) == [b"done"]
    assert len(buf) > 0, "the incomplete tail must be retained"


def test_absurd_frame_length_is_rejected_not_allocated():
    buf = cc.FrameBuffer()
    try:
        buf.feed(struct.pack(">I", 99_000_000) + b"x")
    except cc.CTraderError as e:
        assert "maximum" in str(e)
    else:
        raise AssertionError("an oversized frame length must be refused")


def test_price_scaling_matches_the_documented_examples():
    # docs: 123000 means 1.23, 53423782 means 534.23782
    assert cc.from_api_price(123000) == 1.23
    assert cc.from_api_price(53423782) == 534.23782


# ── dispatch ───────────────────────────────────────────────────────────────

def _envelope(message, client_msg_id=""):
    env = common.ProtoMessage()
    env.payloadType = message.payloadType
    env.payload = message.SerializeToString()
    if client_msg_id:
        env.clientMsgId = client_msg_id
    return env.SerializeToString()


def test_error_response_rejects_the_waiting_caller():
    """An error must raise, not leave the request hanging until timeout."""
    _isolate()
    c = cc.CTraderClient()

    async def run():
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        c._pending["7"] = cc._Pending(fut)
        err = msgs.ProtoOAErrorRes()
        err.errorCode = "ACCOUNT_NOT_AUTHORIZED"
        err.description = "account is not authorised"
        c._dispatch(_envelope(err, "7"))
        try:
            await fut
        except cc.CTraderError as e:
            assert "ACCOUNT_NOT_AUTHORIZED" in str(e)
            assert "not authorised" in str(e)
            return True
        return False

    assert asyncio.run(run()) is True
    assert "ACCOUNT_NOT_AUTHORIZED" in c.last_error


def test_response_is_routed_to_its_own_request():
    """Two requests in flight must not get each other's answers."""
    _isolate()
    c = cc.CTraderClient()

    async def run():
        loop = asyncio.get_running_loop()
        f1, f2 = loop.create_future(), loop.create_future()
        c._pending["1"] = cc._Pending(f1)
        c._pending["2"] = cc._Pending(f2)
        res = msgs.ProtoOASymbolsListRes()
        res.ctidTraderAccountId = 42
        c._dispatch(_envelope(res, "2"))
        assert f2.done() and not f1.done(), "only the matching request resolves"

    asyncio.run(run())


def test_spot_event_becomes_a_quote_with_real_prices():
    _isolate()
    c = cc.CTraderClient()
    c.symbols_by_id = {101: "US30"}
    seen = []
    c.on_quote(lambda q: seen.append(q))

    ev = msgs.ProtoOASpotEvent()
    ev.ctidTraderAccountId = 1
    ev.symbolId = 101
    ev.bid = 4183830      # 41.8383 at 1/100000
    ev.ask = 4183940
    c._dispatch(_envelope(ev))

    assert len(seen) == 1
    q = seen[0]
    assert q.symbol == "US30"
    assert q.bid == 41.8383
    assert q.ask == 41.8394
    assert abs(q.mid - 41.83885) < 1e-9


def test_spot_event_with_only_one_side_is_not_invented():
    """cTrader sends only what changed; the missing side must stay None."""
    _isolate()
    c = cc.CTraderClient()
    seen = []
    c.on_quote(lambda q: seen.append(q))
    ev = msgs.ProtoOASpotEvent()
    ev.ctidTraderAccountId = 1
    ev.symbolId = 55
    ev.bid = 100000
    c._dispatch(_envelope(ev))
    assert seen[0].bid == 1.0
    assert seen[0].ask is None, "an unsent ask must never be fabricated"
    assert seen[0].mid == 1.0


def test_a_raising_handler_does_not_kill_the_feed():
    _isolate()
    c = cc.CTraderClient()
    good = []
    c.on_quote(lambda q: (_ for _ in ()).throw(ValueError("boom")))
    c.on_quote(lambda q: good.append(q))
    ev = msgs.ProtoOASpotEvent()
    ev.ctidTraderAccountId = 1
    ev.symbolId = 7
    ev.bid = 200000
    c._dispatch(_envelope(ev))
    assert len(good) == 1, "one bad handler must not stop the others"


def test_heartbeat_is_ignored_silently():
    _isolate()
    c = cc.CTraderClient()
    c._dispatch(_envelope(common.ProtoHeartbeatEvent()))   # must not raise


# ── symbols ────────────────────────────────────────────────────────────────

def test_symbol_resolution_is_case_insensitive_and_suggests_on_miss():
    _isolate()
    c = cc.CTraderClient()
    c.symbols_by_name = {"US30": 101, "XAUUSD": 41, "EURUSD": 1}
    assert c.resolve_symbol("US30") == 101
    assert c.resolve_symbol("us30") == 101
    try:
        c.resolve_symbol("USD")
    except cc.CTraderError as e:
        assert "not offered" in str(e)
        assert "XAUUSD" in str(e) or "EURUSD" in str(e), "should suggest near matches"
    else:
        raise AssertionError("an unknown symbol must raise")


def test_resolving_before_loading_says_so():
    _isolate()
    c = cc.CTraderClient()
    try:
        c.resolve_symbol("US30")
    except cc.CTraderError as e:
        assert "load_symbols" in str(e)
    else:
        raise AssertionError("must not silently return a wrong id")


def test_status_is_honest_before_connecting():
    _isolate()
    c = cc.CTraderClient()
    s = c.status()
    assert s["connected"] is False
    assert s["app_authenticated"] is False
    assert s["account_id"] == 0
    assert s["symbols_loaded"] == 0


def test_environment_picks_the_right_host():
    _isolate()
    os.environ["CTRADER_ENV"] = "demo"
    assert cc.CTraderClient().host == "demo.ctraderapi.com"
    os.environ["CTRADER_ENV"] = "live"
    assert cc.CTraderClient().host == "live.ctraderapi.com"
    os.environ["CTRADER_ENV"] = "demo"
