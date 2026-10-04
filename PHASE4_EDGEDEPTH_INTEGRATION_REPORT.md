# PHASE 4 — Direct EdgeDepth Source Integration (Source Integrity Report)

## A. Gateway

| Item | Value |
|------|--------|
| Gateway used | **EdgeDepth Gateway** (`github.com/edgedepthhq/edgedepth-gateway`, MIT) |
| Vendored source | `third_party/edgedepth-gateway/` (proto, cmd, internal, pkg) |
| Runtime endpoint | `ws://127.0.0.1:8080/ws` (via `/edgedepth/edgedepth-config.js`) |
| Status probe | `GET /api/edgedepth/status` (TCP reachability only) |
| How GREEN TERMINAL connects | EdgeDepth WASM client reads `window.__EDGEDEPTH_WS_URL__` (or `?ws=`) and speaks the official protobuf/WS contract — **not** a parallel shell protocol |
| Running in this sandbox? | **NO** — Go toolchain and Docker/GHCR downloads are blocked; Binance TLS blocked. Status reports `OFFLINE` honestly |

```
Exchange (Binance USD-M)
  → EdgeDepth Gateway (Go, when running)
  → protobuf WSPayload / WebSocket
  → EdgeDepth Terminal WASM (real renderer)
  → GREEN TERMINAL ORDER FLOW frame (#of-frame → /edgedepth/)
```

## B. EdgeDepth Terminal source used

Vendored authoritative tree: **`third_party/edgedepth-terminal/`** (AGPL-3.0, license retained).

| Area | Paths integrated |
|------|------------------|
| DOM | `src/ui/dom_widget.*`, `orderbook_widget.*`, `realtime_dom_frame.h` |
| Heatmap / depth history | `src/core/heatmap_manager.*`, `heatmap_colormap.*`, `src/rendering/shader_heatmap_renderer.*` |
| Tape / trades | `src/ui/trades_widget.*` |
| Footprint | `src/core/footprint_manager.*`, `footprint_transport.cpp` |
| Delta / CVD / analytics | `src/core/analytics_manager.*`, indicators under `src/ui/indicators/` |
| Chart / order-flow render | `src/ui/chart_widget*`, ImPlot paths |
| Docking / workspace | `src/rendering/layout.*`, `workspace_settings.cpp`, ImGui dock |
| Market-data client | `src/stream_handler.*`, `src/core/data_thread.*`, `message_handler.*` |
| Protobuf contract | `protos/messages.proto` |
| Theme | `design/tokens.json`, `design/edgedepth.css`, `src/rendering/theme.*` |
| Browser shell | `src/shell.html` → served as `/edgedepth/shell.html` (locateFile → `/edgedepth/`) |
| COI fallback | `src/coi-serviceworker.js` → `/edgedepth/coi-serviceworker.js` |

**Gateway components used:** `proto/edgedepth.proto` (wire contract), hub/exchange/binance feed design as documented in `third_party/edgedepth-gateway/README.md`.

## C. Components reused unchanged

- Entire EdgeDepth C++/WASM implementation under `third_party/edgedepth-terminal/src/**` (DOM, heatmap, tape, footprint, analytics, docking, replay, protocol)
- `protos/messages.proto` field numbers (no renumbering)
- Gateway protobuf + control JSON (`method`: subscribe / get_historical_candles / …)
- Official shell bootstrap (`Module`, canvas, status badge)
- Design token source of truth (`design/tokens.json`)

## D. Components adapted

| Component | Why |
|-----------|-----|
| `shell.html` `locateFile` → `/edgedepth/` | Artifacts live under GREEN TERMINAL’s static mount |
| Shell title | “EdgeDepth · GREEN TERMINAL Order Flow” (branding only) |
| `edgedepth-config.js` | Injects `__EDGEDEPTH_WS_URL__` / `__EDGEDEPTH_HOSTED__` for local gateway |
| FastAPI middleware | COOP/COEP **only** on `/edgedepth*` and `.wasm`/`.data` (WASM pthreads) |
| FastAPI mount | `GET /edgedepth` + `GET /api/edgedepth/artifacts` |
| MARKETS subrail + `#orderflow` section | GREEN TERMINAL navigation hosts the real engine in `#of-frame` |

## E. Components newly written (shell only)

| Component | Why necessary |
|-----------|----------------|
| `#orderflow` section + `#of-bar` status | Product chrome: SOURCE / GATEWAY / RUNTIME / SYMBOL |
| `showOrderFlowPage` / `refreshOrderFlowStatus` | Open workspace, poll artifact + gateway status, set iframe `src` only when build is ready |
| Honest banner when artifacts missing | **No lookalike DOM/heatmap** — missing `index.wasm` is reported, never simulated |
| `/api/edgedepth/artifacts` | Runtime readiness from real files on disk |
| Tests (`test_edgedepth_artifacts_endpoint`, `test_orderflow_workspace_markers`) | Lock integration contract + vendored source presence |

## F. Components removed / not created

- Removed partial **lookalike** `lse_terminal/orderflow/` package (capabilities/book stubs) started before this correction — **deleted**
- **No** HTML-table DOM ladder, no CSS-only heatmap, no fake tape, no simulated delta/CVD in the shell
- Production **DEMO BTC** auto-open remains removed (Phase 3 correction)

## G. Data path (runtime)

```
Exchange
  ↓
EdgeDepth Gateway          (third_party/edgedepth-gateway — when running)
  ↓  protobuf / WebSocket
EdgeDepth data model       (WASM: StreamManager / OrderbookManager / CandleManager)
  ↓
EdgeDepth renderer         (ImGui/ImPlot/WebGL2 — DOM, heatmap, tape, footprint)
  ↓
GREEN TERMINAL             (#orderflow → iframe /edgedepth/shell.html)
```

Every order-flow pixel inside the frame is produced by EdgeDepth’s code path. The shell never invents book levels.

## H. Capability verification

| Capability | Status | Evidence |
|------------|--------|----------|
| **L1** | VERIFIED (path) | Gateway + LSE board/stream; shell instrument header uses real quotes when a live source is connected |
| **TRADES** | VERIFIED (path) | Gateway stream 1 `TRADES`; EdgeDepth tape consumes it when connected |
| **L2** | VERIFIED **in code**, **OFFLINE at runtime here** | Gateway `BookUpdate` stream 3 + REST snapshot/diff; `BookUpdate` in `proto/edgedepth.proto`; **gateway not running** in sandbox (`/api/edgedepth/status` → OFFLINE) |
| **L3** | NOT VERIFIED | No MBO stream on community gateway |
| **MBO** | NOT VERIFIED | Separate LSE vault `/api/mbo/*` entitlement only — not EdgeDepth L2 |
| Historical candles | VERIFIED (path) | Gateway `get_historical_candles` / stream 8 |
| Footprint history | BOUNDED (path) | Gateway stream 17 local candidate (documented limits) |
| Volume profile | VERIFIED (path) | Stream 26 |

## I. UI implemented (visible)

- MARKET subrail: **PRICE & CHARTS · ORDER FLOW · OPTIONS · NEWS · SCREENER**
- **ORDER FLOW** workspace: EDGEDEPTH GATEWAY source chip, gateway LIVE/OFFLINE, runtime READY / ARTIFACTS MISSING, symbol, full-open link
- Center stage: **iframe hosting the real EdgeDepth shell** (not a recreation)
- Banner when WASM build outputs are absent — names the missing files
- Price & Chart unchanged (Phase 3)

## J. Demo removal

| Check | Result |
|-------|--------|
| DEMO BTC on production chart path | **Removed** (no `switchProvider("demo")` auto-open) |
| Fake depth in shell | **None** |
| Fake trades / random liquidity | **None** |
| Simulated heatmap cells in GREEN TERMINAL UI | **None** (engine must be present or banner shows) |

## K. Testing

| Gate | Result |
|------|--------|
| `pytest tests/test_market_data.py` (incl. 2 new Phase-4 tests) | See suite run below |
| `node --check app.js` | exit 0 |
| `ast.parse(server.py)` | OK |
| Vendored source presence | `dom_widget.cpp`, `heatmap_manager.cpp`, `messages.proto`, gateway proto — asserted in tests |
| Live smoke | `/edgedepth/` mount, `/api/edgedepth/artifacts`, COOP/COEP headers on edgedepth paths |
| **WASM runtime visual** | **Blocked in sandbox** — cannot download emsdk deps (storage.googleapis.com), Go, Docker, or GHCR layers; cannot run gateway |
| **Live L2 movement** | **Blocked** — gateway offline + Binance TLS blocked |

## L. Known limitations

1. **`index.js` / `index.wasm` / `index.data` are not built in this environment.** ORDER FLOW therefore shows **RUNTIME ARTIFACTS MISSING** and does **not** pretend to show a live DOM/heatmap. Build via `third_party/edgedepth-terminal` Dockerfile/emsdk when the toolchain is available (`edgedepth/README.md`).
2. **EdgeDepth Gateway is not running** here (no Go binary, no Docker pull). Status cell reads OFFLINE until you start `docker compose up` (or `edgedepth-gateway`) and point `edgedepth-config.js` at it.
3. **Binance is unreachable** from this sandbox — even with a binary, live upstream would fail until the network allows it.
4. **AGPL-3.0** applies to EdgeDepth Terminal source (`third_party/edgedepth-terminal/LICENSE`); **MIT** to the gateway. Notices preserved (`THIRD_PARTY_NOTICES.md`, `third_party/edgedepth-terminal/`).
5. MT5 and other providers remain out of scope.

## M. HARD STOP

**STOP.** Real EdgeDepth source is vendored and is the only Order Flow implementation path; GREEN TERMINAL provides shell/nav/status/iframe host. Runtime WASM artifacts and a live gateway are required before DOM/heatmap/tape can move with real data. Awaiting approval before Options / News / Scanner / Research / Economic / Backtest / AI / further providers.
