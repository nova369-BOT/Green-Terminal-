"""Tests for the Binance tick source. No network: parsing is pure."""

from lse_terminal.engine.feeds import binance as bn
from lse_terminal.engine.footprint import build_footprint_bar


def test_buyer_maker_true_means_the_SELLER_was_the_aggressor():
    """Getting this backwards would mirror every delta on the chart."""
    tick = bn.parse_agg_trade({"T": 1700000000000, "p": "64000.5", "q": "0.25", "m": True})
    assert tick.side == "sell"
    assert tick.price == 64000.5
    assert tick.size == 0.25
    assert tick.time_ms == 1700000000000


def test_buyer_maker_false_means_the_BUYER_was_the_aggressor():
    tick = bn.parse_agg_trade({"T": 1700000000001, "p": "64001", "q": "1.5", "m": False})
    assert tick.side == "buy"
    assert tick.size == 1.5


def test_side_is_real_so_the_footprint_is_not_an_estimate():
    ticks = [
        bn.parse_agg_trade({"T": 1, "p": "100", "q": "3", "m": False}),  # buy 3
        bn.parse_agg_trade({"T": 2, "p": "100", "q": "1", "m": True}),   # sell 1
    ]
    fp = build_footprint_bar(
        {"time_ms": 0, "open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0},
        ticks, 1.0)
    assert fp.value_buy == 3
    assert fp.value_sell == 1
    assert fp.delta_value == 2
    assert fp.inferred is False, "exchange-published sides must not be labelled an estimate"


def test_symbol_normalisation():
    for raw, want in [
        ("BTC", "BTCUSDT"), ("btc", "BTCUSDT"), ("BTC/USDT", "BTCUSDT"),
        ("btc-usdt", "BTCUSDT"), ("BTCUSD", "BTCUSDT"), ("BTCUSDT", "BTCUSDT"),
        ("ETHBTC", "ETHBTC"), ("SOL", "SOLUSDT"),
    ]:
        assert bn.normalise_symbol(raw) == want, f"{raw} -> {bn.normalise_symbol(raw)}"
    assert bn.normalise_symbol("") == ""


def test_kline_row_becomes_a_bar():
    row = [1700000000000, "64000.1", "64100.5", "63900.2", "64050.0", "123.45",
           1700000059999, "7900000", 456, "60.0", "3800000", "0"]
    bar = bn.parse_kline(row)
    assert bar == {"time_ms": 1700000000000, "open": 64000.1, "high": 64100.5,
                   "low": 63900.2, "close": 64050.0, "volume": 123.45}


def test_unsupported_interval_is_rejected_before_any_request():
    for good in ("1m", "5m", "1h", "1d"):
        assert bn.interval_to_ms(good) > 0
    try:
        bn.interval_to_ms("7m")
    except bn.BinanceError as e:
        assert "unsupported interval" in str(e)
    else:
        raise AssertionError("an invalid interval must raise")


def test_stream_status_is_honest_before_starting():
    s = bn.BinanceTickStream("BTC").status()
    assert s["symbol"] == "BTCUSDT"
    assert s["connected"] is False
    assert s["running"] is False
    assert s["ticks_received"] == 0
    assert s["url"] == "wss://stream.binance.com:9443/ws/btcusdt@aggTrade"


def test_stream_requires_a_symbol():
    try:
        bn.BinanceTickStream("")
    except bn.BinanceError:
        pass
    else:
        raise AssertionError("an empty symbol must raise")


def test_one_bad_handler_does_not_stop_the_others():
    stream = bn.BinanceTickStream("BTC")
    good = []
    stream.on_tick(lambda t: (_ for _ in ()).throw(ValueError("boom")))
    stream.on_tick(lambda t: good.append(t))
    stream._emit(bn.parse_agg_trade({"T": 5, "p": "1", "q": "1", "m": False}))
    assert len(good) == 1
    assert stream.ticks_received == 1
