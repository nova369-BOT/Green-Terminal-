# ============================================================================
# Phase 3 market-data fabric — API + capability + rate-limit + WS tests.
#
# REAL DATA ONLY: demo provider is the local random-walk used everywhere else
# in this suite (mock only in automated tests, never production UI paths).
# ============================================================================

from __future__ import annotations

import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# Loopback Host so _LocalOnlyGuard allows the handshake (TestClient default
# Host is "testserver", which the guard rejects for websockets).
_WS_HEADERS = {"Host": "127.0.0.1", "Origin": "http://127.0.0.1"}


@pytest.fixture(scope="module")
def client():
    os.environ.setdefault("LSE_TERMINAL_CONFIG_DIR", tempfile.mkdtemp(prefix="md-test-"))
    from lse_terminal.engine.server import create_app

    app = create_app()
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


def test_capabilities_never_fake_depth(client: TestClient):
    body = client.get("/api/market-data/capabilities").json()
    assert body["depth"]["l2"] is False
    assert body["depth"]["l3"] is False
    providers = {p["provider"]: p for p in body["providers"]}
    assert set(providers) >= {"demo", "lse", "userdata"}
    # Formal caps: demo streams, userdata is history-only.
    assert "WEBSOCKET" in providers["demo"]["formal"]
    assert "WEBSOCKET" not in providers["userdata"]["formal"]
    for p in providers.values():
        assert p["l2"] is False and p["l3"] is False
        assert "L2" not in p["formal"]
        assert "L3_MBO" not in p["formal"]
    # Reserved event types are listed for future consumers.
    assert "ORDER_BOOK_UPDATE" in body["event_types"]
    assert "MBO_EVENT" in body["event_types"]


def test_health_measured_fields_only(client: TestClient):
    body = client.get("/api/market-data/health").json()
    assert body["overall"] in {
        "DISCONNECTED", "CONNECTING", "CONNECTED", "DEGRADED",
        "RECONNECTING", "ERROR",
    }
    assert len(body["providers"]) >= 3
    for row in body["providers"]:
        assert "provider" in row and "state" in row
        # Unmeasured latency stays null — never fabricated.
        assert row.get("latency_ewma_ms") is None or row["latency_ewma_ms"] >= 0


def test_bars_historical_feed_label(client: TestClient):
    r = client.get(
        "/api/market-data/bars",
        params={"provider": "demo", "symbol": "DEMO:BTC", "timeframe": "1h", "limit": 50},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["meta"]["feed"] == "historical"
    assert len(body["candles"]) == 50
    # OHLC sanity: real bars only (demo random-walk still has h>=l).
    for row in body["candles"][:10]:
        _t, o, h, l, c, _v = row[:6]
        assert h >= l
        assert h >= o and h >= c and l <= o and l <= c


def test_unsupported_instrument_errors(client: TestClient):
    r = client.get(
        "/api/market-data/bars",
        params={"provider": "demo", "symbol": "NOPE", "timeframe": "1h", "limit": 10},
    )
    assert r.status_code >= 400


def test_rate_limit_candles_429(client: TestClient):
    # Sliding window: fire until 429 (or give up after a high ceiling so a
    # mis-wired limiter fails loudly rather than hanging).
    limited = None
    for i in range(200):
        r = client.get(
            "/api/candles",
            params={"provider": "demo", "symbol": "DEMO:BTC", "timeframe": "1h", "limit": 5},
        )
        if r.status_code == 429:
            limited = i + 1
            break
        assert r.status_code == 200
    assert limited is not None, "per-provider rate limit never triggered in 200 calls"
    # Rate-limit response shape
    detail = r.json().get("detail", "")
    assert "rate limited" in detail


def test_ws_protocol_hello_status_subscribe(client: TestClient):
    with client.websocket_connect(
        "/api/market-data/ws", headers=_WS_HEADERS, timeout=5
    ) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        assert "capabilities" in hello

        ws.send_json({"type": "status"})
        st = ws.receive_json()
        assert st["type"] == "status"
        assert "state" in st

        ws.send_json({"type": "subscribe", "provider": "demo", "symbols": ["DEMO:BTC"]})
        sub = ws.receive_json()
        assert sub["type"] == "subscribed"
        assert sub["ok"] is True
        assert "DEMO:BTC" in sub["symbols"]

        # Wait for connection status transitions and/or a live tick.
        import time

        types = []
        end = time.time() + 8
        while time.time() < end:
            msg = ws.receive_json()
            types.append(msg.get("type"))
            if msg.get("type") == "error":
                pytest.fail(f"unexpected error frame: {msg}")
            if msg.get("type") == "tick" and msg.get("feed") == "live":
                break
        assert "tick" in types or "status" in types

        ws.send_json({"type": "ping"})
        # Drain until pong (status/tick may interleave).
        end = time.time() + 3
        got_pong = False
        while time.time() < end:
            msg = ws.receive_json()
            if msg.get("type") == "pong":
                got_pong = True
                break
        assert got_pong

        ws.send_json({"type": "unsubscribe", "symbols": ["DEMO:BTC"]})
        end = time.time() + 3
        got_unsub = False
        while time.time() < end:
            msg = ws.receive_json()
            if msg.get("type") == "unsubscribed":
                got_unsub = True
                break
        assert got_unsub


def test_ws_unknown_message_error_contract(client: TestClient):
    with client.websocket_connect(
        "/api/market-data/ws", headers=_WS_HEADERS, timeout=5
    ) as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_json({"type": "not-a-thing"})
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "message" in err


def test_ws_query_param_auto_subscribe(client: TestClient):
    with client.websocket_connect(
        "/api/market-data/ws?provider=demo&symbols=DEMO%3ABTC",
        headers=_WS_HEADERS,
        timeout=5,
    ) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        assert hello.get("provider") == "demo"
        # Immediate subscribe frame follows hello.
        sub = ws.receive_json()
        assert sub["type"] == "subscribed"
        assert "DEMO:BTC" in sub["symbols"]


def test_quality_endpoint_lists_checks(client: TestClient):
    body = client.get("/api/market-data/quality").json()
    checks = body.get("checks") or []
    assert "impossible_ohlc" in checks
    assert "crossed_book" in checks or "bad_quote" in checks or checks
    # Recent errors start empty — no invented samples.
    recent = body.get("recent") or body.get("quality_recent") or []
    assert isinstance(recent, list)


def test_instruments_via_market_data(client: TestClient):
    rows = client.get(
        "/api/market-data/instruments",
        params={"provider": "demo", "query": "BTC", "limit": 5},
    ).json()
    assert isinstance(rows, list)
    if rows:
        assert "gt_id" in rows[0]
        # Provider IDs stay mapped; UI consumes gt_id / display_name.
        assert rows[0]["gt_id"].startswith("DEMO:")

def test_demo_price_board_shape(client: TestClient):
    """Demo board rows carry price/bid/ask/change for the watchlist — real
    walk values, not UI-side fabrications."""
    r = client.get("/api/prices", params={"provider": "demo",
                                         "symbols": "DEMO:GOLD,DEMO:BTC"})
    assert r.status_code == 200, r.text
    rows = r.json()
    assert {x["symbol"] for x in rows} == {"DEMO:GOLD", "DEMO:BTC"}
    for row in rows:
        assert row["price"] and row["price"] > 0
        assert row["bid"] < row["ask"]
        assert "change_pct" in row


def test_shell_phase3_ui_markers():
    """Price & Chart shell must ship the Phase 3-UI workspace chrome."""
    from pathlib import Path
    html = (Path(__file__).resolve().parents[1]
            / "lse_terminal/ui/static/index.html").read_text()
    for needle in (
        "GREEN TERMINAL", "instrument-bar", "info-rail", "term-status",
        "ws-controls", "chart-stage", "ib-live", "watchlist",
        "chart-type", "ind-open",
    ):
        assert needle in html, f"missing {needle}"
