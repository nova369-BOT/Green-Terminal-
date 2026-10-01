from decimal import Decimal

import pytest

from lse_terminal.engine.feeds.binance_depth import (
    DepthSequenceError,
    LocalOrderBook,
    parse_snapshot,
    parse_update,
)


def test_snapshot_and_bridging_update_produce_ready_book():
    book = LocalOrderBook("BTCUSDT")
    book.apply_snapshot(parse_snapshot({
        "symbol": "BTCUSDT", "lastUpdateId": 100,
        "bids": [["100", "2"], ["99", "1"]],
        "asks": [["101", "3"]],
    }))
    assert not book.ready
    book.apply_update(parse_update({
        "s": "BTCUSDT", "U": 101, "u": 102,
        "b": [["100", "1.5"]], "a": [["101", "0"]],
    }))
    bids, asks = book.top()
    assert book.ready
    assert bids[0].price == Decimal("100") and bids[0].quantity == Decimal("1.5")
    assert asks == ()


def test_gap_invalidates_book_and_never_paints_stale_depth():
    book = LocalOrderBook("BTCUSDT")
    book.apply_snapshot(parse_snapshot({"s": "BTCUSDT", "lastUpdateId": 10, "bids": [], "asks": []}))
    with pytest.raises(DepthSequenceError):
        book.apply_update(parse_update({"s": "BTCUSDT", "U": 12, "u": 12, "b": [], "a": []}))
    assert not book.ready
    assert book.top() == ((), ())


def test_zero_quantity_removes_level_and_symbol_is_checked():
    book = LocalOrderBook("BTCUSDT")
    book.apply_snapshot(parse_snapshot({"s": "BTCUSDT", "lastUpdateId": 1, "bids": [["100", "1"]], "asks": []}))
    with pytest.raises(ValueError):
        book.apply_update(parse_update({"s": "ETHUSDT", "U": 2, "u": 2, "b": [], "a": []}))
    book.apply_update(parse_update({"s": "BTCUSDT", "U": 2, "u": 2, "b": [["100", "0"]], "a": []}))
    assert book.top() == ((), ())
