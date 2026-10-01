"""Hyperliquid stream parsing — the wire-shape contract mirrored from the
vendored authoritative adapter (third_party/edgedepth-gateway)."""
import pytest

from lse_terminal.engine.feeds.hyperliquid_stream import (
    normalise_coin,
    parse_hl_book,
    parse_hl_trade,
)
from lse_terminal.providers.hyperliquid_depth import HyperliquidDepthProvider


class TestNormaliseCoin:
    @pytest.mark.parametrize("raw,want", [
        ("BTC", "BTC"), ("BTCUSDT", "BTC"), ("btc/USD", "BTC"),
        ("BTC-USDT", "BTC"), ("ETH.P", "ETH"), ("SOLUSDC", "SOL"),
    ])
    def test_forms(self, raw, want):
        assert normalise_coin(raw) == want


class TestParseTrade:
    def test_buy_side_verified(self):
        t = parse_hl_trade({"coin": "BTC", "side": "B", "px": "65000.5",
                            "sz": "0.25", "time": 1700000000000, "tid": 42})
        assert t["side"] == "buy"
        assert t["price"] == 65000.5
        assert t["size"] == 0.25
        assert t["symbol"] == "BTC"
        assert t["trade_id"] == 42

    def test_sell_side_verified(self):
        t = parse_hl_trade({"coin": "ETH", "side": "A", "px": "3200",
                            "sz": "1", "time": 1700000000000, "tid": 1})
        assert t["side"] == "sell"

    @pytest.mark.parametrize("raw", [
        {"coin": "BTC", "side": "X", "px": "1", "sz": "1", "time": 1},   # unknown side
        {"coin": "BTC", "side": "B", "px": "0", "sz": "1", "time": 1},   # bad price
        {"coin": "BTC", "side": "B", "px": "1", "sz": "0", "time": 1},   # bad size
        {"coin": "BTC", "side": "B", "px": "1", "sz": "1", "time": 0},   # bad ts
        {"coin": "BTC", "side": "B", "px": "x", "sz": "1", "time": 1},   # nan string
        "not-a-dict",
    ])
    def test_never_fabricates(self, raw):
        assert parse_hl_trade(raw) is None


class TestParseBook:
    FRAME = {"coin": "BTC", "time": 1700000000000, "levels": [
        [{"px": "99.5", "sz": "0.5"}, {"px": "98", "sz": "1"}],
        [{"px": "100.5", "sz": "0.2"}],
    ]}

    def test_full_book_order(self):
        snap = parse_hl_book(self.FRAME)
        assert snap["type"] == "ORDER_BOOK_SNAPSHOT"
        assert snap["full_book"] is True
        assert snap["bids"] == [["99.5", "0.5"], ["98", "1"]]
        assert snap["asks"] == [["100.5", "0.2"]]
        assert snap["E"] == 1700000000000

    @pytest.mark.parametrize("data", [
        {"coin": "BTC", "levels": []},                # wrong levels arity
        {"coin": "BTC", "levels": None},
        {"coin": "", "levels": [[], []]},              # no coin
        {"coin": "BTC", "levels": [[{"py": "1"}], []]},  # bad level shape
        None,
    ])
    def test_never_fabricates(self, data):
        assert parse_hl_book(data) is None


class TestProviderContract:
    def test_catalog_is_verified_majors(self):
        p = HyperliquidDepthProvider()
        syms = {i.symbol for i in p.search("")}
        assert {"BTC", "ETH", "SOL"} <= syms
        assert all(i.provider == "hyperliquid" for i in p.search(""))

    def test_formal_capabilities_advertise_only_what_streams(self):
        caps = HyperliquidDepthProvider.FORMAL_CAPABILITIES
        assert {"L2", "TRADES", "WEBSOCKET"} <= caps
        assert "L3_MBO" not in caps

    def test_coin_in_candles_signature(self):
        # Normalisation accepts display forms; real fetch needs network, so
        # only the argument path is asserted here.
        assert normalise_coin("BTC/USD") == "BTC"
