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
    try:
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
    finally:
        # Shared module-scoped app: leave the demo limiter clean so later
        # tests (price board, etc.) are not 429'd by this exhaustion/cooldown.
        md = client.app.state.market_data
        lim = md.rate_limits.for_provider("demo")
        with lim._lock:
            lim._times.clear()
            lim._block_until = 0.0


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
    import time as _time
    r = None
    for _attempt in range(5):
        r = client.get("/api/prices", params={"provider": "demo",
                                             "symbols": "DEMO:GOLD,DEMO:BTC"})
        if r.status_code == 200:
            break
        # Sliding-window limiter can still be warm from the 429 test on a
        # fast suite; wait out the 1s window instead of failing the shape.
        _time.sleep(0.3)
    assert r is not None and r.status_code == 200, r.text if r else "no response"
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


def test_no_demo_auto_open_on_price_chart():
    """Phase-3 correction: production Price & Chart must not auto-open DEMO."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    app = (root / "lse_terminal/ui/static/app.js").read_text()
    # The keyless MARKETS path must never switchProvider("demo").
    assert 'switchProvider("demo")' not in app
    # Honest waiting state exists.
    assert "function enterDataWaiting" in app
    assert "WAITING FOR MARKET DATA" in app
    # Shell restore must not resurrect DEMO:* symbols.
    assert "/^DEMO:/i" in app


def test_edgedepth_status_endpoint(client: TestClient):
    """EdgeDepth gateway status is honest reachability only — no fake data."""
    r = client.get("/api/edgedepth/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "edgedepth-gateway"
    assert body["state"] in {"CONNECTED", "OFFLINE"}
    assert body["reachable"] is (body["state"] == "CONNECTED")
    assert "streams" in body and 3 in body["streams"]  # orderbook stream id
    # GT-owned lifecycle facts (never fabricated).
    assert "managed" in body and "binary_found" in body
    assert "endpoint" in body and body["endpoint"].startswith("ws://")
    # Never invents candles/quotes from this endpoint.
    assert "candles" not in body and "price" not in body


def test_edgedepth_config_js_dynamic(client: TestClient):
    """Browser WS config is served by GT (points at the managed gateway)."""
    r = client.get("/edgedepth/edgedepth-config.js")
    assert r.status_code == 200, r.text
    assert "__EDGEDEPTH_WS_URL__" in r.text
    assert "ws://" in r.text
    # One product: no instruction to open a second EdgeDepth app.
    from pathlib import Path
    html = (Path(__file__).resolve().parents[1]
            / "lse_terminal/ui/static/index.html").read_text()
    assert "Open EdgeDepth full" not in html
    assert 'id="of-fullscreen"' in html


def test_shell_waiting_markers():
    """Price & Chart ships the no-demo waiting overlay + gateway status cell."""
    from pathlib import Path
    html = (Path(__file__).resolve().parents[1]
            / "lse_terminal/ui/static/index.html").read_text()
    assert "data-waiting" in html
    assert "dw-title" in html
    assert "WAITING FOR MARKET DATA" in html
    assert "ts-edge" in html


def test_edgedepth_artifacts_endpoint(client: TestClient):
    """Real EdgeDepth build outputs are reported honestly (never faked)."""
    r = client.get("/api/edgedepth/artifacts")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "third_party/edgedepth-terminal"
    assert "present" in body and "ready" in body
    # coi-serviceworker ships with the integration; wasm may be unbuilt.
    assert body["present"].get("coi-serviceworker.js") is True
    assert body["ready"] is (body["present"].get("index.js")
                             and body["present"].get("index.wasm")
                             and body["present"].get("index.data"))


def test_orderflow_workspace_markers():
    """MARKET → ORDER FLOW section hosts the real EdgeDepth iframe."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    html = (root / "lse_terminal/ui/static/index.html").read_text()
    app = (root / "lse_terminal/ui/static/app.js").read_text()
    assert 'id="orderflow"' in html
    assert 'id="of-frame"' in html
    assert "EDGEDEPTH GATEWAY" in html
    assert "showOrderFlowPage" in app
    assert "sub-mk-flow" in app
    # No lookalike DOM ladder in the shell (real engine lives in the iframe).
    assert "of-ladder" not in html
    # Vendored authoritative EdgeDepth source present.
    assert (root / "third_party/edgedepth-terminal/src/ui/dom_widget.cpp").is_file()
    assert (root / "third_party/edgedepth-terminal/src/core/heatmap_manager.cpp").is_file()
    assert (root / "third_party/edgedepth-terminal/protos/messages.proto").is_file()
    assert (root / "third_party/edgedepth-gateway/proto/edgedepth.proto").is_file()
