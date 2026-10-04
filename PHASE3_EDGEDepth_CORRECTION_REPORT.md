# PHASE 3 CRITICAL CORRECTION — EdgeDepth Gateway Investigation + NO DEMO BTC

## EDGEDepth GATEWAY FOUND

**YES** — as a separate MIT Go service (`github.com/edgedepthhq/edgedepth-gateway`), **not** as an embedded module inside this repository.

| Item | Verified value |
|------|----------------|
| Source | `https://github.com/edgedepthhq/edgedepth-gateway` (re-cloned this session) |
| License | MIT |
| Build | `go build ./cmd/edgedepth-gateway` (Go **not installed** in this sandbox) |
| Docker | `docker compose up` → image `edgedepthhq/edgedepth-gateway:latest` (Docker **not installed**) |
| In GREEN TERMINAL | **Not wired.** Only documentation (`PHASE1_EDGEDEPTH_LSE_AUDIT.md`, `ORDERFLOW_REBUILD_PLAN.md`) references it. No provider adapter, no WS client, no env endpoint in `lse_terminal/**`. |

**Honest statement:** EdgeDepth-inspired UI/code exists (audit docs + chart comments). A usable EdgeDepth **gateway process is not present** in this checkout and was **not running** when probed.

---

## ACTUAL ENDPOINT / SERVICE

Verified from gateway `README.md` + `proto/edgedepth.proto` + `internal/hub/client.go`:

```
Binance public streams
        ↓
edgedepth-gateway (Go, default :8080, path /ws)
        ↓  binary WSPayload protobuf over WebSocket
EdgeDepth Terminal (C++/WASM)  —  NOT Green Terminal's chart today
```

| Config | Default | Notes |
|--------|---------|-------|
| Listen | `EDGEDEPTH_ADDR` = `:8080` | |
| Path | `EDGEDEPTH_PATH` = `/ws` | client URL `ws://127.0.0.1:8080/ws` |
| Auth | **None** (community gateway) | no API key |
| Upstream | Binance (`BINANCE_REST` / `BINANCE_WS`) | public USD-M futures |

**Status probe added:** `GET /api/edgedepth/status` →  
`{name, title, endpoint, reachable, state: CONNECTED|OFFLINE, streams, note}`.  
This is **status only** — never serves candles/quotes. Live check from this sandbox:

```json
{"endpoint":"ws://127.0.0.1:8080/ws","reachable":false,"state":"OFFLINE","streams":[1,2,3,4,5,8,17,26,29]}
```

---

## ACTUAL DATA FLOW DISCOVERED (today)

```
GREEN TERMINAL (this app)
  Price & Chart
       ↑ JSON /api/candles · /api/prices · /api/market-data/ws
  Provider registry
       ├── lse        ← real LSE feed (requires free API key)   ← PRIMARY live path
       ├── userdata   ← user imports (history)
       └── demo       ← synthetic walk (TESTS ONLY; auto-open REMOVED this fix)

EdgeDepth Gateway (separate process, optional, future L2/order-flow)
       ↓ protobuf WSPayload
  [NOT connected to Green Terminal chart yet]
```

Preferred target architecture (per correction §5) remains:

```
EdgeDepth Gateway → Green Terminal Adapter → Normalized MD → Store → Price & Chart
LSE key           → LseProvider           → (existing)            → Price & Chart
```

MT5: **deferred** (user instruction).

---

## WHAT THE GATEWAY PROVIDES (code-verified, not UI-inferred)

| Capability | Streams / method | Gateway serves? |
|------------|------------------|-----------------|
| Trades (tape) | 1 `STREAM_TRADES` | YES |
| Candles live | 2 `STREAM_CANDLES` (singular `Candle`) | YES |
| **Order book / L2** | 3 `STREAM_ORDERBOOK` | YES (sequence-checked Binance depth) |
| Stats (mark/funding/OI) | 4 | YES |
| Liquidations | 5 | YES |
| Historical candles | 8 `get_historical_candles` (REST klines) | YES |
| Tick-volume minutes (footprint input) | 17 | YES (bounded local history) |
| Volume profile | 26 | YES |
| Ticker24h watchlist | 29 `!ticker@arr` / REST fallback | YES |
| Heatmap history, VPIN, scanner, patterns | hosted-only | **NO** (ignored) |
| L3 / MBO | not in community gateway | **NO** |

Symbols: `Pair{exchange:"binancef", symbol:"btcusdt"}` (lowercase Binance IDs).  
Control frames: JSON text `{"method":"subscribe"|"get_historical_candles"|...}`.

---

## LIVE DATA / HISTORICAL DATA (as of this run)

| Feed | Live | Historical | Notes |
|------|------|------------|-------|
| **LSE** (with key) | YES (when key configured) | YES | Primary Price & Chart source |
| **EdgeDepth gateway** | **NO** (OFFLINE in sandbox) | N/A (not connected) | Requires running gateway process + Binance reachability |
| Binance upstream | **Blocked in sandbox** (TLS `SSL_ERROR_SYSCALL` to `fapi.binance.com`) | — | Even if Go were installed, live gateway cannot reach Binance here |
| Demo synthetic | Available in API/tests | Yes | **Removed from production auto-open path** |

---

## SYMBOL SUPPORT (verified)

| Source | Instruments |
|--------|-------------|
| LSE | Full LSE catalog via `/api/instruments?provider=lse` (key required) |
| EdgeDepth gateway | Binance USD-M perps, e.g. `btcusdt`, `ethusdt`, … (`exchange=binancef`) |
| Demo (tests only) | `DEMO:GOLD`, `DEMO:EURUSD`, `DEMO:SPX`, `DEMO:AAPL`, `DEMO:BTC`, `DEMO:VIX` |

Symbol mapping (when the gateway adapter is built):  
`GREEN TERMINAL symbol` → `binancef/<lowercase-id>` — **must be read from venue metadata**, not invented.

---

## DEMO BTC SOURCE — exact trace

| Stage | Location | Behaviour |
|-------|----------|-----------|
| Source | `lse_terminal/providers/demo.py` `_UNIVERSE` | Synthetic random-walk instruments (`DEMO:BTC` first until reordering) |
| Service | `registry.load_builtins` → `DemoProvider` | Always registered |
| State | `app.js` `state.provider` | Set by `switchProvider("demo")` |
| Component | `rail-markets` onclick | **Keyless path auto-called `switchProvider("demo")`** (Phase 3-UI) |
| Chart | `runSwitchProvider` → `instruments[0]` / GOLD preference | Charted **DEMO:BTC** (or GOLD) |

**Root cause:** Phase 3-UI opened the chart without an LSE key by auto-selecting the demo provider so the workspace would not show a connect wall. That made **DEMO BTC** the default production face of Price & Chart.

**Fix (this correction):**

1. **Removed** `switchProvider("demo")` from the MARKETS keyless path (`app.js`). Grep confirms **0** occurrences.
2. **Added** honest empty state: `#data-waiting` overlay — **WAITING FOR MARKET DATA** / connection guidance. No synthetic candles.
3. **Shell restore** strips any `DEMO:*` saved symbol so a prior session cannot resurrect demo BTC/GOLD.
4. **Status strip:** `DATA` = WAITING/OFFLINE/live title (never DEMO); new `GATEWAY` cell = real `/api/edgedepth/status` reachability only.
5. Demo remains registered for **automated tests and explicit API use** — never auto-opened on Price & Chart.

---

## CHANGES

| File | Change |
|------|--------|
| `lse_terminal/ui/static/app.js` | No demo auto-open; `enterDataWaiting`/`exitDataWaiting`; `pollEdgeGateway`; shell `DEMO:*` strip; honest `ts-data` / `ts-edge`; watchlist empty state |
| `lse_terminal/ui/static/index.html` | `#data-waiting` overlay; `#ts-edge` GATEWAY cell |
| `lse_terminal/ui/static/style.css` | Waiting overlay styles |
| `lse_terminal/engine/server.py` | `GET /api/edgedepth/status` (TCP reachability only) |
| `tests/test_market_data.py` | +3 tests (no demo auto-open, edgedepth status, waiting markers); rate-limit isolation fix |
| `PHASE3_EDGEDepth_CORRECTION_REPORT.md` | This report |

---

## TESTS

| Gate | Result |
|------|--------|
| `pytest tests/test_market_data.py` | **15 passed** (stable across 5 consecutive full runs) |
| `node --check app.js` | **exit 0** |
| `ast.parse(server.py)` | **OK** |
| Live `:7788` | `/api/health` ok; `/api/edgedepth/status` OFFLINE honest; HTML has waiting markers; served `app.js` has **0** `switchProvider("demo")` |
| Full 285+ suite | Run before push if time; market-data module is the correction surface |

---

## LIMITATIONS (verified only)

1. **EdgeDepth gateway process not running** and **not buildable here** (no Go, no Docker).
2. **Binance unreachable from this sandbox** (TLS reset) — gateway live probe cannot succeed in-sandbox even with a binary.
3. **LSE live data requires the user’s API key** — without it, Price & Chart shows WAITING FOR MARKET DATA (by design), not a real instrument.
4. **Gateway is not yet the chart’s data path** — dual-source architecture (LSE + EdgeDepth) is specified; the EdgeDepth adapter is the next build step after approval.
5. **No L2/L3/MBO/heatmap/footprint UI** — §38 HARD STOP still active; gateway stream 3 exists on the wire but is not surfaced.
6. **No screenshot** in-sandbox (browser binaries still blocked).

---

## §38 / HARD STOP

**Stopped.** No DOM, L2/L3 UI, MBO, heatmap, footprint, tape, delta, CVD, or volume-profile was implemented.  

**Immediate objective met in code:** production Price & Chart path **no longer auto-shows DEMO BTC**; it shows an honest **WAITING FOR MARKET DATA** state until a real source (LSE key) is connected.  

**Next phase (awaiting explicit approval):** EdgeDepth gateway adapter (LSE + EdgeDepth dual path; MT5 later) → then order-flow UI only after genuine gateway data is verified end-to-end.
