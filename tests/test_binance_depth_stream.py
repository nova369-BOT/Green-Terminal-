import inspect

import lse_terminal.engine.feeds.binance_depth_stream as module
from lse_terminal.engine.feeds.binance_depth_stream import BinanceDepthStream


def test_stream_uses_normalized_symbol_and_documented_endpoints():
    stream = BinanceDepthStream("BTC/USDT", levels=100)
    assert stream.symbol == "BTCUSDT"
    assert stream.ws_url.endswith("btcusdt@depth@100ms")
    assert "symbol=BTCUSDT" in stream.snapshot_url
    assert "limit=100" in stream.snapshot_url


def test_every_network_await_is_bounded_so_a_hang_can_never_sync_forever():
    """2026-10-02 live incident: the depth generator hung before its first
    yield (urllib per-op timeouts don't cover a DNS stall or byte-trickling
    blackhole; a middlebox answering pings while dropping app frames defeats
    ws keepalive). No DEPTH_RESET ever fired, trades kept the venue looking
    alive, and every depth widget sat "Syncing" forever. These markers pin
    the rule that every blocking phase has a hard deadline, deadlines name
    themselves for the reset reason, and orphaned snapshot tasks are
    cancelled so no urllib job leaks between reconnects."""
    src = inspect.getsource(module)
    assert "open_timeout=10" in src, "websocket connect must be bounded"
    assert "asyncio.wait_for(snapshot_task" in src, "REST snapshot await needs a hard deadline"
    assert "asyncio.wait_for(socket.recv()" in src, "recv has a per-frame deadline"
    assert "snapshot_task.cancel()" in src, "orphaned snapshot task is cancelled on timeout"
    assert "snapshot fetch hung" in src, "snapshot deadline names itself"
    assert "depth stream silent" in src, "recv deadlines name themselves"
    assert "DEPTH_RESET" in src


def test_reset_reason_never_blank_for_bare_exceptions():
    """The DEPTH_RESET reason must never render empty: bare async exceptions
    (e.g. ConnectionError with no message) fall back to the class name."""
    src = inspect.getsource(BinanceDepthStream.events)
    assert "str(exc) or type(exc).__name__" in src


def test_depth_reset_path_still_sleeps_backoff_not_hammer():
    """Timeout → DEPTH_RESET → growing backoff: a blackholed venue is
    retried on a cadence, not spammed."""
    src = inspect.getsource(BinanceDepthStream.events)
    assert "backoff = min" in src and "backoff * 2" in src
    assert "await asyncio.sleep(backoff)" in src
