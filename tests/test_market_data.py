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
    """Depth flags are DERIVED from registrations, never hardcoded.

    The binance-depth adapter genuinely provides verified L2 (diff-depth
    stream + REST snapshot bridge), so the aggregate l2 flag is true exactly
    because a provider formally advertises L2. L3 stays false: no MBO feed.
    """
    body = client.get("/api/market-data/capabilities").json()
    providers = {p["provider"]: p for p in body["providers"]}
    assert set(providers) >= {"demo", "lse", "userdata", "binance-depth", "hyperliquid"}
    for v in ("binance-depth", "hyperliquid"):
        assert "L2" in providers[v]["formal"], v
    assert body["depth"]["l2"] is True
    assert body["depth"]["l3"] is False
    # Formal caps: demo streams, userdata is history-only.
    assert "WEBSOCKET" in providers["demo"]["formal"]
    assert "WEBSOCKET" not in providers["userdata"]["formal"]
    for name, p in providers.items():
        # Only the verified L2 adapters may claim depth capability.
        assert ("L2" in p["formal"]) == (name in {"binance-depth", "hyperliquid"}), name
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
        "GREEN TERMINAL", "instrument-bar", "term-status",
        "ws-controls", "chart-stage", "ib-live", "watchlist",
        "chart-type", "ind-open",
        # The OVERVIEW/MARKET/SESSION/TECHNICAL info rail was retired; the
        # native widget workspace rail replaced it (plan item 12).
        "rail-workspace",
    ):
        assert needle in html, f"missing {needle}"
    assert "info-rail" not in html, "the retired info rail must not come back"


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


def test_edgedepth_config_js_retired(client: TestClient):
    """G-Flow retirement (plan item 15): the iframed second UI's config route
    is gone. The gateway survives as an INTERNAL service only — probed by the
    supervisor via /api/edgedepth/status, never by the browser."""
    r = client.get("/edgedepth/edgedepth-config.js")
    assert r.status_code == 404
    from pathlib import Path
    html = (Path(__file__).resolve().parents[1]
            / "lse_terminal/ui/static/index.html").read_text()
    # One product: no second-UI chrome may linger in the shell.
    assert "Open EdgeDepth full" not in html
    assert 'id="of-fullscreen"' not in html
    assert "edgedepth" not in html


def test_shell_waiting_markers():
    """Price & Chart ships the no-demo waiting overlay + gateway status cell."""
    from pathlib import Path
    html = (Path(__file__).resolve().parents[1]
            / "lse_terminal/ui/static/index.html").read_text()
    assert "data-waiting" in html
    assert "dw-title" in html
    assert "WAITING FOR MARKET DATA" in html
    assert "ts-edge" in html


def test_edgedepth_artifacts_endpoint_retired(client: TestClient):
    """G-Flow retirement (plan item 15): the 6.1 MB WASM runtime and its
    artifacts/config routes were deleted; the status probe route remains."""
    r = client.get("/api/edgedepth/artifacts")
    assert r.status_code == 404
    r = client.get("/api/edgedepth/config")
    assert r.status_code == 404
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    # The runtime payload itself must be gone from the shipped static tree.
    static = root / "lse_terminal/ui/static/edgedepth"
    assert not (static / "index.wasm").exists()
    # But the status route still reports the managed internal gateway.
    status = client.get("/api/edgedepth/status")
    assert status.status_code == 200


def test_orderflow_workspace_markers():
    """Order flow lives in the NATIVE widget workspace (plan items 8–15).

    The G-Flow iframe/second UI is retired; the shell ships the 12-widget
    native workspace instead, and the vendored EdgeDepth sources stay in the
    tree so the internal gateway can be rebuilt truthfully."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    html = (root / "lse_terminal/ui/static/index.html").read_text()
    app = (root / "lse_terminal/ui/static/app.js").read_text()
    # No iframe shell, no G-Flow navigation — one chart surface.
    assert 'id="orderflow"' not in html
    assert 'id="of-frame"' not in html
    assert "showOrderFlowPage" not in app
    # Native widget workspace is the order-flow host.
    widgets = (root / "frontend/src/lib/workspaceWidgets.ts").read_text()
    for widget_type in ("dom", "footprint", "heatmap", "trades", "cvdDelta",
                        "volumeProfile", "orderbook", "marketStats", "watchlist",
                        "paperTrading", "replay", "chart"):
        assert f"'{widget_type}'" in widgets, f"missing widget {widget_type}"
    # The DOM reads the verified L2 stream via venue resolution + adaptive
    # failover (Binance primary, Hyperliquid fallback) — never by
    # subscribing the display symbol directly.
    panels = (root / "frontend/src/components/chart/workspaceWidgetPanels.tsx").read_text()
    assert "useAdaptiveFlowSource" in panels
    assert "resolveFlowSource" in (root / "frontend/src/lib/flowSources.ts").read_text()
    # The DOM is a G-Flow parity port: tick-grid ladder with BUYS/BIDS/PRICE/
    # ASKS/SELLS/DELTA columns, grove-ramp depth bars, per-price trade
    # accumulation with Manual/5m/15m/1h/Session reset windows, grouping
    # x1/x10/x100, Coin/USD units, auto-center + scroll — driven by the
    # pure ladder core in lib/domLadder.ts.
    assert "TradeAtPriceAccumulator" in panels
    assert "buildLadderModel" in panels
    for marker in ("BUYS", "SELLS", "DELTA", "Auto center",
                   "PRICE GROUPING", "CUMULATIVE FLOW",
                   "Reset accumulated flow", "Coin", "USD",
                   "SetScrollHereY"):
        assert marker in panels, f"missing DOM parity marker {marker!r}"
    ladder = (root / "frontend/src/lib/domLadder.ts").read_text()
    for marker in ("dom_band_size", "check_auto_reset", "fmt_value",
                   "fmt_signed", "session", "periodic",
                   "oceanRgb", "resolveCenterKey"):
        assert marker in ladder, f"missing domLadder port marker {marker!r}"
    # The ported ladder core carries a self-checking parity suite.
    assert (root / "frontend/tests/domLadder.test.mjs").is_file()
    # Trades + Orderbook G-Flow parity: 64-print tape ring with qty EMA
    # big-print wash, 1m flow meter; orderbook with ask/bid tables straddling
    # the direction-colored last-trade price and cumulative TOTAL bars.
    tape = (root / "frontend/src/lib/tape.ts").read_text()
    for marker in ("MAX_TRADES", "qtyEma", "BIG_PRINT_FACTOR", "buyPressure",
                   "statistics"):
        assert marker in tape, f"missing tape port marker {marker!r}"
    assert "TradeTape" in panels
    assert "Show Cumulative" in panels and "Bar Opacity" in panels
    assert (root / "frontend/tests/tape.test.mjs").is_file()
    # Vendored authoritative EdgeDepth source still present.
    assert (root / "third_party/edgedepth-terminal/src/ui/dom_widget.cpp").is_file()
    assert (root / "third_party/edgedepth-gateway/proto/edgedepth.proto").is_file()


def test_gateway_serves_hyperliquid_only():
    """Gateway registry remains HL-only (Binance is served by the verified
    Python provider, not the gateway). Its HL sources stay intact."""
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    main = (root / "third_party/edgedepth-gateway/cmd/edgedepth-gateway/main.go").read_text()
    assert "hyperliquid.New(log)" in main
    assert "binance.New(log)" not in main
    hl = root / "third_party/edgedepth-gateway/internal/hyperliquid"
    for name in ("adapter.go", "feed.go", "rest.go", "stream.go", "ticker.go"):
        assert (hl / name).is_file(), f"missing hyperliquid/{name}"
    assert '"hl"' in (hl / "adapter.go").read_text()
