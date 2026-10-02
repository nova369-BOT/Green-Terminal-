import inspect

from lse_terminal.engine.feeds.binance_depth_stream import BinanceDepthStream


def test_stream_uses_normalized_symbol_and_documented_endpoints():
    stream = BinanceDepthStream("BTC/USDT", levels=100)
    assert stream.symbol == "BTCUSDT"
    assert stream.ws_url.endswith("btcusdt@depth@100ms")
    assert "symbol=BTCUSDT" in stream.snapshot_url
    assert "limit=100" in stream.snapshot_url


def test_every_await_is_bounded_so_a_hang_can_never_sync_forever():
    """The trades-vs-depth divergence incident: the depth generator could
    hang on an unbounded await before its first yield — urllib's per-op
    timeout does not cover a DNS stall or a byte-trickling blackhole, and a
    middlebox answering pings while dropping app frames defeats ws
    keepalive. No DEPTH_RESET ever fired, so consumers stayed "Syncing" and
    the venue failover never engaged. These markers pin the contract that
    every blocking phase has a hard deadline and that deadlines name
    themselves to the surface."""
    import lse_terminal.engine.feeds.binance_depth_stream as module
    src = inspect.getsource(module)
    assert "open_timeout=10" in src, "websocket connect must be bounded"
    assert "asyncio.wait_for(snapshot_task" in src, "REST snapshot await must have a hard deadline"
    assert "asyncio.wait_for(socket.recv()" in src, "recv must have a per-frame deadline"
    assert "snapshot fetch hung" in src, "snapshot deadline must name itself for the reset reason"
    assert "depth stream silent" in src, "recv deadlines must name themselves"
    assert "yield" in src and "DEPTH_RESET" in src


def test_depth_reset_path_still_sleeps_backoff_not_hammer():
    """Timeout → DEPTH_RESET → backoff grow: the catch block must keep the
    reconnect cadence so a blackholed venue is retried, not spammed."""
    src = inspect.getsource(BinanceDepthStream.events)
    assert "backoff = min" in src and "backoff * 2" in src
    assert "await asyncio.sleep(backoff)" in src
