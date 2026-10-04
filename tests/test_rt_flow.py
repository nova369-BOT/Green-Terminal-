"""Unit tests for the RT order-flow recorder (pure parts + honest routing).

No network is touched: these cover symbol→coin routing (the doctrine's
gatekeeper), column building from a live book dict, and the Hyperliquid
message parsers against the documented payload shapes. Live venue behaviour
can only be verified from a host that can reach a venue (the user's Docker),
and nothing here pretends otherwise.
"""
from __future__ import annotations

import pytest

from lse_terminal.engine.rt_flow import (
    build_column,
    normalise_coin,
    parse_hl_l2book,
    parse_hl_trades,
)


# ── Doctrine gatekeeper: crypto routes, everything else honestly refuses ────

@pytest.mark.parametrize("symbol,coin", [
    ("DEMO:BTC", "BTC"),
    ("BTC", "BTC"),
    ("btcusdt", "BTC"),
    ("BTC/USDT", "BTC"),
    ("BTC-USD", "BTC"),
    ("ETHUSD", "ETH"),
    ("BINANCE:SOLUSDC", "SOL"),
    ("DOGEPERP", "DOGE"),
])
def test_normalise_coin_routes_crypto(symbol, coin):
    assert normalise_coin(symbol) == coin


@pytest.mark.parametrize("symbol", [
    "DEMO:GOLD",   # metal — no crypto venue
    "EURUSD",      # FX — honestly flow-less (user decree, stated twice)
    "GBPUSD",
    "XAUUSD",
    "AAPL",
    "US500",
    "",
])
def test_normalise_coin_refuses_non_crypto(symbol):
    assert normalise_coin(symbol) is None


# ── Column building: live book dict → heatmap column ────────────────────────

def test_build_column_shapes_and_sorting():
    bids = {100.0: 2.0, 99.5: 1.0, 101.0: 3.0}   # unsorted on purpose
    asks = {102.0: 4.0, 101.5: 0.5, 103.0: 1.5}
    col = build_column(bids, asks, 1_700_000_000_000, levels=2)
    assert col is not None
    # Bids descending from best; asks ascending from best; top-2 only.
    assert col["bids_prices"] == [101.0, 100.0]
    assert col["bids_sizes"] == [3.0, 2.0]
    assert col["asks_prices"] == [101.5, 102.0]
    assert col["asks_sizes"] == [0.5, 4.0]
    # Mid from best bid/ask; renderer-compatible ISO timestamp present.
    assert col["mid"] == pytest.approx((101.0 + 101.5) / 2)
    assert col["t"] == 1_700_000_000_000
    assert col["timestamp"].startswith("2023-11-14T")


def test_build_column_empty_book_yields_none():
    # No column is better than a fake one (honesty rule).
    assert build_column({}, {}, 1_700_000_000_000) is None


def test_build_column_one_sided_book():
    col = build_column({100.0: 1.0}, {}, 1_700_000_000_000)
    assert col is not None
    assert col["mid"] == 100.0
    assert col["asks_prices"] == []


# ── Hyperliquid parsers against the documented shapes ───────────────────────

def test_parse_hl_l2book():
    data = {
        "coin": "BTC", "time": 1_700_000_000_123,
        "levels": [
            [{"px": "84000.0", "sz": "1.5", "n": 3}, {"px": "83999.0", "sz": "2.0", "n": 1}],
            [{"px": "84001.0", "sz": "0.7", "n": 2}],
        ],
    }
    bids, asks, at = parse_hl_l2book(data)
    assert bids == {84000.0: 1.5, 83999.0: 2.0}
    assert asks == {84001.0: 0.7}
    assert at == 1_700_000_000_123


def test_parse_hl_trades_provider_truth_sides():
    # HL side flags: "B" = taker bought, "A" = taker sold. Provider truth —
    # never inferred from price movement.
    out = parse_hl_trades([
        {"coin": "BTC", "side": "B", "px": "84000.5", "sz": "0.25", "time": 1},
        {"coin": "BTC", "side": "A", "px": "84000.0", "sz": "1.0", "time": 2},
    ])
    assert out == [
        {"t": 1, "p": 84000.5, "q": 0.25, "side": "buy"},
        {"t": 2, "p": 84000.0, "q": 1.0, "side": "sell"},
    ]


# ── The endpoint refuses non-crypto symbols honestly (no session spawned) ───

def test_rt_flow_endpoint_non_crypto_is_honest():
    from starlette.testclient import TestClient
    from lse_terminal.engine.server import create_app

    # GT's loopback guard rejects foreign Host headers by design; the test
    # client must present itself as localhost like a real browser would.
    client = TestClient(create_app(), headers={"host": "127.0.0.1"})
    r = client.get("/api/rt/flow", params={"symbol": "DEMO:GOLD"})
    assert r.status_code == 200
    body = r.json()
    assert body["flow"] == "none"
    assert body["columns"] == [] and body["trades"] == []
    assert "no crypto venue" in body["reason"]
    assert "simulated" in body["reason"]  # the honesty sentence stays


# ── v2 parity: liquidations, session accounting, clear ─────────────────────

def test_parse_binance_force_order_provider_truth():
    from lse_terminal.engine.rt_flow import parse_binance_force_order
    # S is the LIQUIDATION order's side (provider truth): SELL = a long was
    # liquidated → normalized side "sell"; BUY = a short was → "buy".
    out = parse_binance_force_order({"e": "forceOrder", "o": {
        "s": "BTCUSDT", "S": "SELL", "q": "0.5", "ap": "84000", "p": "83999",
        "T": 1700000000000,
    }})
    assert out == {"t": 1700000000000, "p": 84000.0, "q": 0.5,
                   "side": "sell", "notional": 42000.0}
    out = parse_binance_force_order({"o": {
        "S": "BUY", "q": "2", "ap": "", "p": "3000", "T": 5,
    }})
    assert out["side"] == "buy" and out["p"] == 3000.0  # ap fallback → p


def test_parse_binance_force_order_rejects_garbage():
    from lse_terminal.engine.rt_flow import parse_binance_force_order
    assert parse_binance_force_order({}) is None
    assert parse_binance_force_order({"o": {"S": "SELL", "q": "0", "ap": "1"}}) is None
    assert parse_binance_force_order({"o": {"S": "SELL", "q": "x", "ap": "1"}}) is None


def test_session_payload_v2_fields_and_clear():
    from lse_terminal.engine.rt_flow import RTSession
    s = RTSession("BTC")
    s.venue = "binance"
    s.columns.extend([
        {"t": 1000, "bids_prices": [1.0], "bids_sizes": [2.0],
         "asks_prices": [1.1], "asks_sizes": [3.0], "mid": 1.05},
        {"t": 61000, "bids_prices": [1.0], "bids_sizes": [2.0],
         "asks_prices": [1.1], "asks_sizes": [3.0], "mid": 1.05},
    ])
    s._push_trades([{"t": 500, "p": 1.0, "q": 1.0, "side": "buy"}])
    s.liqs.append({"t": 700, "p": 1.0, "q": 9.0, "side": "sell", "notional": 9.0})
    body = s.payload(0.0, 0.0, 0.0)
    assert body["recorded_ms"] == 60000
    assert body["approx_bytes"] > 0
    assert body["cols_dropped"] == 0 and body["trades_dropped"] == 0
    assert body["liqs"] == [{"t": 700, "p": 1.0, "q": 9.0,
                             "side": "sell", "notional": 9.0}]
    assert body["liq_source"] == "binance-futures perp reports"
    # liqs_after cursor filters like the other cursors
    assert s.payload(0.0, 0.0, 700)["liqs"] == []
    # Clear history: data gone, accounting reset, connection fields untouched.
    s.clear()
    assert not s.columns and not s.trades and not s.liqs
    assert s.venue == "binance"
    body = s.payload(0.0, 0.0, 0.0)
    assert body["recorded_ms"] == 0 and body["liqs"] == []


def test_hl_session_states_liq_gap_honestly():
    from lse_terminal.engine.rt_flow import RTSession
    s = RTSession("BTC")
    s.venue = "hyperliquid"
    src = s.payload(0.0, 0.0, 0.0)["liq_source"]
    assert "no public liquidation feed" in src


def test_trade_ring_overflow_counts_drops():
    from lse_terminal.engine import rt_flow as rf
    s = rf.RTSession("BTC")
    # Shrink the ring for the test (deque maxlen is fixed at construction).
    import collections
    s.trades = collections.deque(maxlen=3)
    old_ring = rf.TRADE_RING
    rf.TRADE_RING = 3
    try:
        s._push_trades([{"t": i, "p": 1.0, "q": 1.0, "side": "buy"}
                        for i in range(5)])
    finally:
        rf.TRADE_RING = old_ring
    assert len(s.trades) == 3
    assert s.trades_dropped == 2  # honest loss count, not silence


def test_rt_clear_endpoint():
    from starlette.testclient import TestClient
    from lse_terminal.engine.server import create_app

    client = TestClient(create_app(), headers={"host": "127.0.0.1"})
    # No session yet → honest cleared:false, never a fake success.
    r = client.post("/api/rt/clear", params={"symbol": "DEMO:BTC"})
    assert r.status_code == 200
    body = r.json()
    assert body["coin"] == "BTC"
    assert body["cleared"] is False
    # Non-crypto symbol → no coin, nothing cleared.
    r = client.post("/api/rt/clear", params={"symbol": "DEMO:GOLD"})
    assert r.json() == {"cleared": False, "coin": None}
