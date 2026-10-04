from lse_terminal.engine.feeds.binance_depth_stream import BinanceDepthStream


def test_stream_uses_normalized_symbol_and_documented_endpoints():
    stream = BinanceDepthStream("BTC/USDT", levels=100)
    assert stream.symbol == "BTCUSDT"
    assert stream.ws_url.endswith("btcusdt@depth@100ms")
    assert "symbol=BTCUSDT" in stream.snapshot_url
    assert "limit=100" in stream.snapshot_url
