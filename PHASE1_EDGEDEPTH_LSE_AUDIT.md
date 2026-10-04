# PHASE 1 — Deep EdgeDepth × LSE Integration Audit

**Status: AUDIT COMPLETE — IMPLEMENTATION HAS NOT STARTED.**  
**Date:** 2026-09-23  
**Scope:** Read-only inspection of LSE Terminal (this checkout) and both EdgeDepth repos. No production code, routing, UI, deps, or config was modified for this audit.

---

## A. REPOSITORY STATUS

### A.1 LSE (target app)

| Item | Value |
|------|--------|
| Path | `/home/user/Green-Terminal-` |
| Branch | `arena/01a0caa0-green-terminal` |
| Commit | `80ef5b51992fdb61a9daf011bc8f0d2bacd9623b` — *Replace GREEN TERMINAL scaffold with flatmoonsociety/lse-terminal* |
| Tree | `795b805787b952ae5da9642ea78e79bc5f66aa5d` |
| Status (before & after audit) | Clean vs HEAD; only untracked `ORDERFLOW_REBUILD_PLAN.md` (prior plan note, not app code) |
| Submodules | none |
| Remote | `origin` → `https://github.com/nova369-BOT/Green-Terminal-.git` (history also contains prior orderflow/Render work on later commits; **working tree is baseline lse-terminal only**) |
| Upstream source of truth | `https://github.com/londonstrategicedge/lse-terminal` (imported as `80ef5b5`) |

**Build / toolchain (LSE)**

| Item | Value |
|------|--------|
| Package | hatchling → `pip install -e .` → console script `lset = lse_terminal.cli:main` |
| Python | `requires-python >= 3.10` (sandbox: 3.11.2) |
| Runtime deps | fastapi, uvicorn, websockets, pandas, numpy, pyarrow, lse-data, brue-language, … |
| Frontend | `frontend/` Vite **library** build → IIFE `lse_terminal/ui/static/chart/chart.js` (`window.LSEChart`) |
| Node | sandbox Node 22; chart scripts: `vite build` / `tsc --noEmit` |
| Desktop | Electron-style `desktop/` (main.js, preload); not required for browser use of Price & Chart |
| OS assumptions | Local desktop engine; `LocalOnlyGuard` allows loopback Host/Origin unless hosted/remote flags |
| Config dir | `~/.config/lse-terminal/` (`config.json`, `workspace.json`) |

**Integrity after audit:** `git rev-parse HEAD` and tree hash unchanged (`80ef5b5` / `795b805…`). No staged/unstaged production diffs.

### A.2 EdgeDepth Terminal

| Item | Value |
|------|--------|
| Path | `/home/user/edgedepth-terminal` |
| Branch | `master` |
| Commit | `1fea3c432a35063fbb2674a4f9b2932c977c3afb` |
| Tree | `08e6ff3bcbec7b18ae23c6ca5e51e8ce61734227` |
| Status | clean clone |
| License | **AGPL-3.0** (`LICENSE`); fonts OFL; see README §License |

**Build requirements (from `CMakeLists.txt` + `ARCHITECTURE.md` + CI):**  
CMake ≥ 3.15, C++20, **Emscripten** (CI pins **4.0.15**), host **protoc 21.x** (v21.12), Ninja recommended; FetchContent for ImGui/ImPlot/zstd/protobuf/nlohmann; SDL3 via `-sUSE_SDL=3`; **`-pthread`** (pthread pool of 2); artifacts `index.html`, `index.js`, `index.wasm`, `index.data` + `coi-serviceworker.js`.  
**Sandbox gap:** `emcc` / `protoc` / `cmake` / `ninja` **not installed** here.

### A.3 EdgeDepth Gateway

| Item | Value |
|------|--------|
| Path | `/home/user/edgedepth-gateway` |
| Branch | `master` |
| Commit | `b8222849b6baeaae8ed54f336fced0125ebb0df5` |
| Tree | `6e648d936af45c03fc2084d7815bf54cbb437175` |
| Status | clean clone |
| License | **MIT** |
| Build | Go module; `go build ./cmd/edgedepth-gateway` (Go **not** installed in this sandbox) |

---

## B. LSE ARCHITECTURE (discovered)

### B.1 Application entry → Price & Chart

```
lset (lse_terminal/cli.py:main)
  → argparse --host/--port/--no-browser
  → uvicorn.run(create_app(), host, port)
      create_app (lse_terminal/engine/server.py ~L569)
        · Registry: UserDataProvider, DemoProvider, LseProvider + Python backtest engine
        · import lse_terminal.indicators → registers built-ins
        · middleware: _LocalOnlyGuard (loopback Host/Origin) unless hosted/remote
        · API routes: /api/candles, /api/prices, /api/ws, /api/indicators, workspace, …
        · app.mount("/", StaticFiles(ui/static, html=True))   # L7827
  → optional webbrowser.open(url)
```

Browser load:

```
GET /  → ui/static/index.html
  <script src="./chart/chart.js">   # IIFE LSEChart (Vite lib build of frontend/src/mount.tsx)
  <script src="./app.js">           # shell: rails, subrail, watchlist, chart data
```

### B.2 Markets → Price & Chart (exact path)

| Step | Evidence |
|------|----------|
| Rail | `#rail-markets` button → `setActive` + `renderSubrail("markets", "sub-mk-charts")` (`app.js` ~L11878) |
| Subrail | `SUBRAIL.markets` entry `{ id: "sub-mk-charts", label: "PRICE & CHARTS", go: () => $("rail-markets").click() }` (`app.js` ~L8947–8951) |
| Surface | Child pages (`#optpage`, `#scrpage`, `#news`) are hidden; **`#charts`** is shown (`app.js` ~L11918) |
| Chart host | `index.html` L280: `<section id="charts">` … host div `#chart` / `#chart-pro` for the React mount |
| Without LSE key | `#lse-connect` form instead of `#charts` if `!state.lseConfigured && !isLiveSource` |

**There is no SPA route table for Markets children** — navigation is imperative DOM section visibility in `app.js`. `UI_SECTIONS` on the server (`server.py` ~L3005) is only for AI `open_in_app` navigation names (`markets`, `backtest*`, …), not HTTP routes.

### B.3 Current chart pipeline (real implementation)

```
provider (state.provider, default "lse" when configured)
  → GET /api/candles?provider&symbol&timeframe&limit=5000&indicators=…
      server: reg.get(provider).candles() + contracts.compute() indicators
  → state.candleData = [{time,open,high,low,close,volume}, …]
  → state.engineIndicators = data.indicators
  → pushToChart()  (app.js ~L194)
        window.LSEChart.mount($("#chart-pro"), payload)  # first time
        window.LSEChart.update(payload)                 # subsequent
  → frontend/src/mount.tsx → ProChart + ChartDrawingOverlay + MultiGrid
  → canvas 2D (ProChart) + overlay canvas (drawings/crosshair)
  → React state / refs (scroll via refs to avoid re-render storms)

LIVE ticks:
  WS /api/ws?provider&symbols=<charted>  → JSON {type:"tick", price, bid, ask, …}
      onTick merges into last candle → pushToChart()
  Watchlist prices: 1s poll GET /api/prices (not per-row WS)

Persistence: workspace.json via PUT /api/workspace/{section}
  sections: settings, drawings, indicators, layouts, watchlist, shell, …
```

**Mount bridge:** `frontend/src/mount.tsx` documents that the shell is plain JS and the chart is an imperative `window.LSEChart` API (`mount` / `update` / `unmount` / layout button). Baseline **`mount.tsx` has no `heatmapEnabled` / `l2DepthData` props** (those appeared only in later orderflow commits, not in this tree).

### B.4 Routing / layout / state / events

| Concern | Owner |
|---------|--------|
| Top-level sections | `index.html` `#rail-*` + `app.js` `setActive` / `renderSubrail` |
| Global shell state | module-level `state` in `app.js` (provider, symbol, timeframe, candles, prices, quotes) |
| Chart React state | `ChartSettingsContext`, `layoutStore`, component state inside mount tree |
| Events | Direct DOM onclick handlers; no global event bus for chart |
| Auth / key | LSE API key in `config.json`; `#lse-connect`; providers `configured()` |
| Persistence | `workspace.json` + `config.json` under config dir |
| Logging / errors | `status()` text in shell; `console.error` in React; HTTPException JSON |
| Hosted/local split | `_LocalOnlyGuard` / `_HostedRateLimit` middleware |

---

## C. EDGEDEPTH ARCHITECTURE (discovered)

### C.1 Core runtime

Authoritative: `ARCHITECTURE.md` (cross-checked against `main.cpp`, `data_thread`, `message_handler`, `CMakeLists.txt`).

```
External gateway ── protobuf/WSPayload binary WS ──► browser WebSocket callback
                                                      │ copy bytes
                                                      ▼
                                         DataThread (pthread) queue
                                           · zstd sniff/decompress
                                           · parse pb::WSPayload
                                           · MessageHandler switch(Stream)
                                                      │
                    ┌─────────────────────────────────┼──────────────────────────┐
                    ▼                                 ▼                          ▼
           OrderbookManager write            DispatchQueue (typed CB)    (special streams)
           model (mutex)                     3 ms/frame budget           heatmap/liq/footprint…
                    │                                 │
                    ▼ once/frame publish              ▼
              read snapshot                     managers (Candle, Footprint, …)
                    └────────────► AppContext pointers ──► Widgets (ImGui/ImPlot)
                                                          │
                                                          ▼
                                              ImGui draw lists → WebGL2 (SDL3)
                                              emscripten_set_main_loop(main_loop)
```

- **WASM entry:** `src/main.cpp` (`main` creates SDL window, GL, managers, `DataThread`, widgets, ImGui/ImPlot, `emscripten_set_main_loop`).
- **Shell:** `src/shell.html` — `#canvas` full viewport, `Module.locateFile`, loads `coi-serviceworker.js`.
- **Isolation:** production page **must** send `COOP: same-origin` + `COEP: require-corp` for `SharedArrayBuffer` / pthreads (`ARCHITECTURE.md` “Browser deployment requirements”; `docker/nginx.conf`, `serve_threaded.py`).
- **JS boundary:** exported C functions (viewport, education, replay scrub, `set_chart_timeframe`, …) in `CMakeLists.txt` `WASM_EXPORTED_FUNCTIONS`; JS must not mutate ImGui mid-frame.
- **Live vs replay:** same wire + managers; replay swaps `AppContext` manager pointers (`ReplayManager` + `DataContext`); packs via `PackReplayEngine` + `PackFrame`/`PackHeader`.

### C.2 Wire contract

- Schema: `protos/messages.proto` (858 lines). Envelope `WSPayload { pair, stream, timeframe, data, event_time_ms }`.
- **One binary frame = one protobuf; no length prefix.** Optional outer zstd (magic `28 B5 2F FD`); nested `TickVolumeUpdate.levels_data` is zstd **inside** the payload.
- **Control:** JSON **text** frames keyed on **`method`** (not `type`): `subscribe` / `unsubscribe` / `get_historical_candles` / `get_footprint_history` / `get_volume_profile` (gateway `client.go` L239+).
- Stream IDs (terminal enum): Trades=1, Candles=2, Orderbook=3, Stats=4, Liquidations=5, HistoricalCandles=8, Heatmap=11, TickVolume=17, VolumeProfile=26, Ticker24h=29, … through RT_HISTORY=36 (`messages.proto` L16–73).
- Gateway **serves** a subset: 1,2,3,4,5,8,17,26,29 (`gateway proto/edgedepth.proto`).
- Hot path helpers: `src/types/types.h` (`MAX_ORDERBOOK_LEVELS=100`, `MAX_HEATMAP_LEVELS=200`); `StreamManager` refcounted subscribe (`stream_handler.cpp`).

### C.3 UI / terminal architecture (source map)

| Feature | Directory | Primary files / symbols |
|---------|-----------|-------------------------|
| Chart | `src/ui/` | `chart_widget.{h,cpp}`, `chart_widget_flow.cpp`, `chart_widget_realtime.cpp`, `ChartWidget::render/update` |
| Chart types | `chart_widget.h` | `ChartType`: Candles, FP Cluster, FP Profile, HeikinAshi, Line, TPO, Renko |
| DOM ladder | `src/ui/dom_widget.*` | `DOMWidget`, linked RT frame `RealtimeDOMFrame` |
| Order book panel | `src/ui/orderbook_widget.*` | separate widget |
| Tape | `src/ui/trades_widget.*` | `TradesWidget`, stats header |
| Footprint data | `src/core/footprint_manager.*`, `footprint_transport.cpp` | `on_tick_volume_update`, `on_trade`, imbalance Diagonal/SamePrice, stack levels, ratio |
| Heatmap | `src/core/heatmap_manager.*`, `shader_heatmap_renderer.*` | depth history → GPU textures |
| Volume profile | `src/core/volume_profile_manager.*`, `price_profile_renderer.*` | POC / VAH / VAL toggles |
| TPO | `src/core/tpo_manager.*` | sessions, IB, poor H/L |
| Liquidation | `liquidation_heatmap_manager.*`, `liq_field_*` | modelled field + levels stream |
| Indicators | `src/ui/indicators/` | CVD, MACD, RSI, Volume, VPIN, OI, funding |
| Drawing | `src/ui/drawing/` | layer, toolbar, style editor, icons |
| Replay | `src/replayer/` | `ReplayManager`, `PackReplayEngine`, library widget |
| Workspace/dock | ImGui dock + `workspace_manager.*` | JSON settings load/save per widget |
| Watchlist | `watchlist_widget.*` | + Ticker24h stream |
| Stats | `stats_widget.*` | mark/funding/OI |
| Paper trading | `paper_trading_manager.*` + proto | client-side (gateway/hosted gated) |
| App chrome | `src/rendering/app_shell.*`, `menu.*`, `layout.*` | topbar, TF pill, dockspace |
| Message path | `src/core/message_parser.*`, `message_handler.*`, `stream_handler.*` | decode → route → subscribe |

**Default widgets at boot** (`main.cpp` ~L651–700): `ChartWidget` + `DOMWidget` + `TradesWidget` + `WatchlistWidget` (layout-dependent).

---

## D. EDGEDEPTH FEATURE MATRIX (source → data → integration)

| Feature | Source files | Main symbols | Data required | Render | State / persistence | Integration risk |
|---------|--------------|--------------|---------------|--------|---------------------|------------------|
| Candles / chart | `candle_manager.*`, `chart_widget.*` | `CandleManager`, `ChartWidget` | STREAM 2 + 8 (hist), trades for building bar | ImPlot/GL | workspace JSON | **Low** if streams fed |
| Heikin Ashi / Renko / TPO chart modes | `chart_widget.h` `ChartType` | same | same candles (+ derived) | same | same | Low |
| DOM | `dom_widget.*`, `orderbook_manager.*` | `DOMWidget`, `OrderbookManager` | STREAM 3 (+ snapshots 18 in replay) | ImGui table | settings | **Medium** — needs real book |
| Tape | `trades_widget.*` | `TradesWidget` | STREAM 1 (aggressor side) | ImGui | settings | Medium |
| Footprint | `footprint_manager.*` | closed-minute TickVolume | STREAM 17 / `get_footprint_history`; live trades | ImGui grid | mode/ratio/stack | **High data** — needs continuous trades |
| Heatmap / RT depth | `heatmap_manager.*`, `shader_heatmap_*`, `docs/REALTIME_DEPTH.md` | snapshots stream 11/13 | depth observations | WebGL textures | fidelity/palette | High — gateway has **no** heatmap stream |
| Volume profile | `volume_profile_manager.*` | `get_volume_profile` → stream 26 | footprint minutes + tick size | ImGui/GL | POC/VA toggles | Medium — gateway can compute from local volume history |
| TPO | `tpo_manager.*` | build from candles or hist | candles / TPO stream 27 | ImGui | session prefs | Medium |
| Liquidations / field | `liquidation_heatmap_manager.*` | streams 5, 12, 34 | liq stream (gateway: 5 only) | texture | opacity | High without hosted modelled field |
| Drawing tools | `drawing/*` | layer + toolbar | none (local geometry) | ImDrawList | workspace | Low — lives inside WASM |
| Indicators (native) | `indicators/*` | CVD, MACD, RSI, … | trades/candles | ImPlot | workspace | Low |
| Replay / packs | `replayer/*` | ReplayManager, Pack engine | WSPayload replay or `.edpack` + CORS Range | same widgets | library manifest | **High env** (Range, CORS, COEP) |
| Watchlist | `watchlist_widget.*` | Ticker24h | stream 29 | ImGui | list | Low if gateway running |
| Stats panel | `stats_widget.*` | mark/funding/OI | stream 4 | ImGui | — | Low if gateway |
| Paper trading | `paper_trading_manager.*` | stream 28 | hosted/paper backend | ImGui | account | Medium / optional |
| Scanner | `scanner_manager.*` | stream 30 | hosted only (gateway ignores) | ImGui | — | **Not available** on community gateway |
| Workspace dock | ImGui docking + `workspace_manager` | layouts | none | ImGui | JSON files | Contained inside WASM |

Gateway-supported orderflow truth: **trades, book, candles (+ sub-minute agg), stats, liq, hist klines, tick-volume minutes (footprint), volume profile, ticker24h**. Hosted-only: heatmap history, VPIN, positioning, patterns, scanner, modelled liq field.

---

## E. LSE FEATURE MATRIX (keep / replace / extend for Price & Chart goal)

| LSE feature | Source location | Role under “EdgeDepth in Price & Chart” |
|-------------|-----------------|------------------------------------------|
| Shell rails + Markets subrail | `ui/static/app.js`, `index.html` | **KEEP** — navigation, OPTIONS/NEWS/SCREENER |
| Watchlist sidebar | `app.js` | **KEEP** (or later link symbol → EdgeDepth pair) |
| Trade ticket / account dock | `app.js`, `#trade-panel` | **KEEP** — orthogonal to chart engine |
| Price & Chart host `#charts` | `index.html` | **KEEP shell; EXTEND** host container for EdgeDepth runtime |
| React ProChart + drawings | `frontend/src/components/chart/**`, `mount.tsx` | **KEEP for BACKTEST charts**; Price & Chart may switch primary host to EdgeDepth while ProChart remains for BT/manual |
| ECharts UniversalChart / BTChart | same package | **KEEP** (backtest) |
| Python indicators + `/api/indicators` | `indicators/*`, `contracts` | **KEEP** for LSE chart; EdgeDepth uses its own indicator set inside WASM |
| `/api/candles`, `/api/ws`, `/api/prices` | `server.py` | **KEEP** — still feeds LSE surfaces; optional bridge source for EdgeDepth |
| Providers LSE/Demo/UserData | `providers/*` | **KEEP**; **do not assume** they supply L2/trades-for-footprint |
| Options / News / Screener pages | `app.js` show*Page | **KEEP** |
| Backtest / Workspace / Economic / Research | rails + mounts | **KEEP** untouched |
| Workspace persistence | `engine/workspace.py` | **KEEP**; EdgeDepth has its own workspace inside WASM |
| `l2_heatmap_snapshots` client call | `ProChart.tsx` / `BTChart.tsx` | **Client-only in baseline** — **no Python route** found; heatmap path is incomplete without orderflow backend |
| Level-3 / MBO vault routes | `server.py` ~L1342 | **KEEP** separate; not the chart feed |

---

## F. DATA COMPATIBILITY

| Data type | EdgeDepth requires | LSE provides (verified) | Compatible? | Transformation |
|-----------|--------------------|-------------------------|-------------|----------------|
| Candles OHLCV | STREAM 2/8 protobuf `Candle` | `/api/candles` JSON arrays; provider REST | **Yes** | JSON → protobuf `Candle`/`Candles` or run gateway |
| Tick / trade prints | STREAM 1 with **is_buy** aggressor | `/api/ws` JSON tick: symbol, price, bid, ask, volume, ts — **no verified aggressor flag** in LSE stream | **Partial / No** for true tape & footprint | Need LSE field proof or external trades (gateway) |
| Quotes L1 | BookTicker (not core of gateway list) | bid/ask on tick or synthesizer (`spread.py`) | Partial | Map to BookUpdate/book ticker if needed |
| L2 depth / book | STREAM 3 `BookUpdate` sequence-checked | **No orderbook provider** in `providers/*`; no `/api/book` | **No** | Must add venue feed (gateway) or new LSE source |
| L3 / MBO | not required by community terminal path; LSE has gated vault MBO API | `/api/mbo/*` when entitled | Separate product | Not wired to Price & Chart chart |
| Heatmap snapshots | STREAM 11/13 | **No backend** for `l2_heatmap_snapshots` | **No** | Hosted/gateway only today |
| Footprint minutes | STREAM 17 closed minutes buy/sell levels | **None** | **No** without continuous trades + aggregator (gateway `internal/volume`) | Use gateway or reimplement history rules |
| Volume profile | STREAM 26 | **None** | **No** | From footprint minutes (gateway) |
| Stats (mark/funding/OI) | STREAM 4 | Not on `/api/ws`; LSE key features elsewhere | Partial | Gateway polls Binance premium |
| Ticker24h watchlist | STREAM 29 | `/api/prices` poll | Partial | Map symbols; different protocol |
| Liquidations | STREAM 5 | Not in LSE provider stream | **No** on LSE-only | Gateway Binance forceOrder |
| Timestamps | exchange ms in messages | `ts` epoch seconds on candles; tick may be sec/ms mix | Careful unit conversion | Normalize to ms |
| Symbol IDs | `Pair{exchange, symbol}` e.g. `binancef/btcusdt` | LSE symbol codes (`EURUSD`, …) | **Mapping table required** | Never assume 1:1 |
| Sequence / update ids | book `first/last_update_id` | N/A without book | N/A | Comes with real book feed |
| Tick size / precision | needed for profile bucketing | instrument meta partial | Must source from venue metadata | |

**Summary:** LSE is strong on **candles + L1 ticks + catalog/backtest**. It does **not** currently provide the **orderbook, aggressor trades, heatmap, or footprint streams** EdgeDepth’s orderflow UI is built around. Those must come from **EdgeDepth gateway (or equivalent feed)** or a new LSE data pipeline — not from “the chart already has L2 overlays.”

---

## G. ORDERFLOW PIPELINE (end-to-end)

### EdgeDepth (gateway path — community)

| Stage | EdgeDepth implementation |
|-------|---------------------------|
| Market feed | `internal/binance/feed.go` (aggTrade, depth diff, REST snapshot resync) |
| Transport | `internal/hub` + `internal/wire.Encode` → binary WS |
| Decoder (client) | `message_parser.cpp` → `MessageHandler.cpp` |
| Normalized msg | pb Trade / BookUpdate / TickVolumeUpdate |
| Orderbook | `OrderbookManager` write → frame publish |
| Trade / volume engine | `CandleManager` + gateway `internal/volume.History` (closed minutes) |
| Historical state | gateway `History.Range` (≤60 min / 50k cells) → stream 17 |
| DOM | `DOMWidget` ← book + linked RT |
| Tape | `TradesWidget` ← trades |
| Footprint | `FootprintManager` ← stream 17 / `on_trade` forming minute |
| Heatmap | `HeatmapManager` ← stream 11 (hosted/local candidate — **not** community gateway) |
| Render | ImGui/ImPlot/WebGL2 on main thread |

### LSE equivalent

| Stage | LSE today |
|-------|-----------|
| Market feed | `LseProvider` REST+tick WS / `DemoProvider` random walk |
| Transport | JSON HTTP + JSON WS only |
| Decoder | `server.py` JSON handlers |
| Orderbook | **absent** |
| Trade engine | candle merge in `app.js` for chart only |
| Footprint/heatmap | **absent** (client heatmap hooks lack API) |
| Render | React canvas ProChart |

**Integration required:** either (1) run **EdgeDepth gateway** beside LSE and point EdgeDepth WASM at it, or (2) build a **new LSE-side protocol adapter** that emits WSPayload on a WS EdgeDepth understands — that is a new pipeline, not a reuse of LSE’s `/api/ws`.

---

## H. RENDERING PIPELINE (EdgeDepth)

1. Browser schedules `main_loop` (`emscripten_set_main_loop`).  
2. SDL events + ImGui new frame.  
3. Drain `DispatchQueue` (**3 ms** budget).  
4. Publish orderbook dirty state once per frame.  
5. Widgets `update()` then `render()` (ImPlot/ImGui).  
6. Submit ImGui draw data → WebGL2; swap.  
7. High-rate book never goes through React/JS re-render; JS only shuttles **bytes** into the data pthread queue.

**Implication:** do **not** force EdgeDepth frames through LSE React state. Host the canvas at the edge of the shell; pass only **symbol/timeframe/viewport commands** and **market bytes**.

---

## I. DEPENDENCY CONFLICTS

| Area | LSE | EdgeDepth | Conflict |
|------|-----|-----------|----------|
| Language / runtime | Python 3.10+ FastAPI | C++20 → WASM + pthreads | Different stacks; coexist if isolated |
| UI | DOM + React 18 + canvas 2D | Dear ImGui + WebGL2 | Two toolkits; iframe vs same-page host |
| Build | pip + Vite | CMake + Emscripten + protoc 21 | **Heavy**; sandbox lacks emsdk/protoc |
| WS | JSON asyncio WS | Binary protobuf WS | Protocol gap |
| Compression | none on candles | optional zstd | Need zstd only if bridging |
| Headers | **No COOP/COEP** in FastAPI static today | **Requires** COOP/COEP | **Hard requirement** to change server middleware (Phase 2) |
| Isolation | Loopback Host guard | Browser cross-origin isolation | Both must be satisfied for local + embed |
| Node chart bundle | IIFE 4.4 MB `chart.js` | separate artifacts | Cache/layout coordination when both visible |
| Package managers | pip / npm | CMake FetchContent / go | No shared lockfile |

---

## J. DUPLICATION

| Concern | LSE copy | EdgeDepth copy | Note |
|---------|----------|----------------|------|
| Chart engine | ProChart/BTChart/Universal (React/canvas) | ChartWidget (ImGui) | Will **both exist** if only Price & Chart embeds EdgeDepth — intentional for BACKTEST vs Markets |
| Watchlist | shell + `/api/prices` | WatchlistWidget + stream 29 | Parallel UIs |
| Indicators | 104+ Python + TS calculators | small native set | Different catalogs |
| Drawing | ChartDrawingOverlay (huge) | drawing layer | Parallel |
| Workspace persistence | `workspace.json` | workspace_manager JSON | Parallel files |
| WS clients | `/api/ws` JSON | WebSocketClient binary | Parallel |
| Orderbook | **none** | OrderbookManager | No duplicate book |
| Replay | manual backtest bar replay | Pack/Network replay | Different domains |
| Symbol picker | shell sidebar/search | Menu symbol picker | Parallel |

**Do not delete LSE chart/backtest stack** while integrating EdgeDepth; isolate Price & Chart host first.

---

## K. INTEGRATION OPTIONS

### Option A — Full WASM app in iframe / nested document
- Load EdgeDepth `index.html` as iframe inside `#charts`.  
- **Pros:** isolation, own Module lifecycle, least invasive.  
- **Cons:** COOP/COEP still required for pthreads (**iframe needs same isolation headers**); input/focus and “feels native” worse; symbol sync via `postMessage`.  
- **Feasibility:** high for milestone 1; medium for deep LSE chrome fusion.

### Option B — Same-page WASM module + narrow JS bridge (recommended)
- Serve EdgeDepth artifacts from LSE FastAPI (or static mount).  
- Host page sets COOP/COEP (or COI service worker).  
- Shell creates a container div (or full `#charts` replace) with `#canvas`, bootstraps `Module`, passes `set_chart_timeframe` / symbol exports; optional `postMessage` for LSE watchlist.  
- **Pros:** single origin, real EdgeDepth code path, no rewrite; matches `shell.html` + exported functions.  
- **Cons:** must not React-remount canvas carelessly; two drawing systems coexist unless BT chart kept separate; header changes affect whole app.  
- **Feasibility:** highest fidelity to “actual EdgeDepth engine.”

### Option C — Shared data bridge only (EdgeDepth stays separate app)
- LSE runs a WSPayload WS adapter; EdgeDepth still a second URL.  
- **Pros:** no embed complexity.  
- **Cons:** fails mission “inside Price & Chart” as one experience.  
- **Feasibility:** good for data only, not for UI containment.

### Option D — Extract/rehost EdgeDepth widgets as non-WASM
- Port DOM/tape/footprint to React.  
- **Pros:** pure JS.  
- **Cons:** **recreates EdgeDepth** — violates “do not rewrite.”  
- **Reject** as primary strategy.

**Selection for blueprint (evidence-based): Option B primary, Option A fallback if COOP/COEP or multi-instance lifecycle forces isolation. Option C only as data feeder (gateway or LSE→WSPayload bridge) — not as the UI answer.**

---

## L. RECOMMENDED ARCHITECTURE

```
LSE APPLICATION (FastAPI + app.js shell)
│
├── MARKETS
│   ├── PRICE & CHARTS  ← Integration target
│   │     ├── Shell chrome (subrail, ticket, watchlist, status)   [LSE KEEP]
│   │     ├── EdgeDepth Host container (replaces React chart mount for this page only)
│   │     │     └── EdgeDepth WASM runtime (real build: index.js/wasm/data)
│   │     │           ├── Chart / FP modes / Drawing / Indicators (native)
│   │     │           ├── DOM / Tape / Footprint / Profile / TPO
│   │     │           └── Replay (pack/network) when data present
│   │     ├── Market data: EdgeDepth gateway (MIT) on localhost
│   │     │     or later LSE→WSPayload bridge for LSE-listed symbols
│   │     └── LSE bridge: symbol/timeframe sync, open/close lifecycle
│   ├── OPTIONS | NEWS | SCREENER                             [LSE KEEP]
│   └── (ORDERFLOW subrail only if product still wants an LSE-native page)
│
├── BACKTEST (ProChart / BTChart / manual replay)             [LSE KEEP]
├── ECONOMIC | WORKSPACE | RESEARCH | MY DATA | GUIDE         [LSE KEEP]
└── config/workspace persistence                              [LSE KEEP]
        EdgeDepth workspace stays inside WASM (separate files)
```

**Ownership after integration**

| Responsibility | Canonical owner |
|----------------|-----------------|
| App navigation, watchlist, ticket, API keys | LSE |
| Price & Chart pixels for Markets chart surface | **EdgeDepth WASM** |
| Backtest charting | LSE React ProChart |
| Market microstructure streams (book/trades/footprint) | EdgeDepth gateway (or future LSE bridge implementing same wire) |
| Candles for LSE features | LSE providers |
| Isolation headers / static artifact serving | LSE FastAPI (Phase 2 change) |
| Drawing/indicators **on Price & Chart** | EdgeDepth |
| Drawing/indicators **on Backtest** | LSE |

---

## M. FILE-BY-FILE PLAN (for eventual Phase 2 — not executed)

### Files to ADD (intended paths)
| Path | Why |
|------|-----|
| `lse_terminal/ui/static/edgedepth/**` (or `static/edge/`) | Checked-in **or build-output** copy of EdgeDepth `index.html/index.js/index.wasm/index.data` + `coi-serviceworker.js` |
| `frontend/src/edgedepth/host.ts` (or `ui/static/edgedepth-host.js`) | Boot/teardown Module, resize, symbol/TF bridge |
| `docs/edgedepth-integration.md` | Ops: emsdk/protoc pins, gateway run, COOP/COEP notes |
| Optional `scripts/build-edgedepth.sh` | Documented Emscripten + protoc 21 build |
| Tests: `tests/test_edgedepth_assets.py` | Artifacts present, headers set |

### Files to MODIFY (Phase 2)
| Path | Why / risk |
|------|------------|
| `lse_terminal/engine/server.py` | Add **COOP/COEP** (or COI) middleware; static route for EdgeDepth artifacts + correct `application/wasm`; possibly reverse-proxy or document gateway URL. **Risk:** breaks clients that mishandle COEP unless CORP/CORS correct for LSE JS/CSS/fonts. |
| `lse_terminal/ui/static/index.html` | Host container div next to `#charts` / `#chart-pro`; script tags for host loader. **Risk:** layout of ticket/dock. |
| `lse_terminal/ui/static/app.js` | On PRICE & CHARTS open: start EdgeDepth host; on leave: stop; wire `setSymbol`/timeframe to bridge. **Risk:** regressions to LSE chart if both mounts fight `#charts`. |
| Possibly `pyproject.toml` | Only if packaging static wasm — prefer no new deps. |

### Files to RETAIN UNCHANGED
- Entire EdgeDepth `src/**` used as upstream for builds (adapt only if a thin embed wrapper is required upstream — prefer zero edits).  
- EdgeDepth `protos/messages.proto` field numbers.  
- LSE `frontend/**` chart package (backtest).  
- LSE providers, backtest, ML, research, etc.

### Files to ADAPT
| File | Change |
|------|--------|
| `src/shell.html` **or** a new thin host page | Canvas id / locateFile base path for non-root mount; **do not fork architecture** |
| Optional `main.cpp` exports | Only if missing symbol/TF hooks beyond existing `__set_chart_timeframe` |

### Files to REMOVE
- None required for Phase 1/2 milestone. Legacy LSE chart on Price & Chart is **hidden/disabled**, not deleted.

---

## N. PERFORMANCE RISKS

| Risk | Level | Reason (source) |
|------|-------|-----------------|
| React re-render driving EdgeDepth frames | **HIGH** if done | EdgeDepth assumes main-thread ImGui loop, 3 ms dispatch budget |
| COOP/COEP applied incorrectly → wasm/JS fail to load | **HIGH** | missing `application/wasm` or blocked workers |
| Two canvases + 4.4 MB `chart.js` + wasm memory | **MEDIUM** | memory pressure on low-RAM machines |
| JSON `/api/ws` + binary gateway WS both hot | **MEDIUM** | dual feeds; avoid double candle merge |
| Symbol sync chatter (watchlist → EdgeDepth) | **LOW–MED** | debounce; use exported commands not per-tick React |
| pthread without isolation headers | **HIGH** | `SharedArrayBuffer` undefined → boot fail |
| Pack replay Range requests through LSE middleware | **MEDIUM** | must not break HTTP Range/CORS |
| LocalOnlyGuard vs EdgeDepth gateway WS origin | **MEDIUM** | gateway is separate origin/port; browser may need CORS/COEP for subresources |

---

## O. DATA LIMITATIONS

**Supported by real data (with gateway):** candles, trades, book, stats, liquidations, hist klines, closed-minute footprint (warmup 1–2 min), volume profile from those minutes, ticker24h, sub-minute candles.

**Calculated from available data:** TPO from candles; building footprint minute from live trades; POC/VA 70% from minutes.

**Inferred / incomplete:** RT heatmap **history** (docs: community gateway = live observations only, no manufacturing); LSE-provided symbols outside Binance IDs.

**Not possible with current LSE feed alone:** true L2 DOM, aggressor tape, footprint, heatmap stream, gateway-grade orderbook continuity.

**Not possible with community gateway alone:** hosted scanner, VPIN/positioning/patterns, modelled liq field, venue coverage beyond configured exchange (Binance fapi routing constraints in this network — **Binance may be blocked in this sandbox**).

**LSE-only mode:** EdgeDepth can still render **candles + drawings + HA/Renko + TPO from LSE-candles bridge**, but **DOM/tape/footprint/heatmap will stay empty or wrong** unless a book/trades source exists. Product must choose: (i) gateway feed (Binance symbols), (ii) LSE symbol bridge with **synthetic** book (**forbidden as “fake orderflow”** by mission), or (iii) LSE vault MBO/L2 if ever exposed (not verified as chart stream today).

---

## P. LICENSE FLAGS (from license texts only — not legal advice)

| Component | License (file) | Integration note (flag for human/legal) |
|-----------|----------------|------------------------------------------|
| LSE Terminal | **MIT** | Permissive; compatible with shipping AGPL **as a separate work** if boundaries clear |
| EdgeDepth Terminal | **AGPL-3.0** | Network-use / distribution obligations for modified **terminal** service; embedding the **compiled AGPL app** as the Price & Chart experience likely makes the **offered service** subject to AGPL source obligations for the terminal — **must be reviewed by counsel** before production SaaS |
| EdgeDepth Gateway | **MIT** | Separate; can be used more freely as data plane |
| Fonts (EdgeDepth) | OFL | Attribution / no-modification-of-font-name rules |
| Third-party (ImGui, etc.) | see `THIRD_PARTY_NOTICES.md` | Follow notices when distributing builds |

**Flag:** mixing MIT app UI with AGPL WASM in one user-facing service is the **primary compliance decision** for Phase 2. Do not treat this audit as clearance.

---

## Q. PHASE 2 ACCEPTANCE TESTS

| ID | Test | Pass criteria |
|----|------|----------------|
| A | LSE starts | `lset` healthy; existing pytest suite still green |
| B | Markets → Price & Charts | Section opens; shell nav works |
| C | EdgeDepth runtime init | `index.wasm` loads; no COOP/COEP/`SharedArrayBuffer` console errors; status leaves “Initializing…” |
| D | Canvas renders | Visible chart (even if empty book) with EdgeDepth chrome/TF control |
| E | Mouse input | pan/zoom/crosshair inside canvas; LSE outside still works |
| F | Keyboard | EdgeDepth shortcuts work when canvas focused; LSE not broken |
| G | Resize | Sidebar collapse / window resize → canvas resizes without 1×1 stuck canvas |
| H | Unmount | Leaving Price & Charts tears down or sleeps runtime without crash |
| I | Navigate away | BACKTEST/ECONOMIC open normally |
| J | Remount | Return to Price & Charts: **no** second `Module` / duplicate canvas |
| K | Repeat open/close ×10 | No unbounded JS heap growth; ports/threads stable |
| L | Data (if gateway on) | Subscribe trades+book; DOM/tape update; footprint after warmup minutes |
| M | LSE regression | `/api/candles`, workspace drawings, backtest chart unchanged |
| N | Headers | Response headers include required isolation; wasm MIME `application/wasm` |
| O | License packaging | Notices shipped; human sign-off recorded before public deploy |

---

## R. GO / NO-GO

| Question | Answer |
|----------|--------|
| How does LSE render Price & Chart today? | **Yes — traced** (`app.js` loadChart → `LSEChart.mount` → ProChart canvas). |
| How does EdgeDepth render? | **Yes — traced** (ARCHITECTURE.md + main loop + managers + ImGui/WebGL2). |
| Where are major EdgeDepth features? | **Yes — source map §D/C.3** |
| What data EdgeDepth needs? | **Yes — §F/G** |
| What LSE provides? | **Yes — verified gaps (no L2/footprint API)** |
| How can systems communicate? | **Yes — embed + optional gateway/WSPayload bridge (§K/L)** |
| What must change / must not change? | **Yes — §M** |
| Architectural conflicts? | **Yes — COOP/COEP, dual chart stacks, data gaps, AGPL (§I/P)** |
| Integrate without rebuilding EdgeDepth? | **Yes — Option B (WASM host), not port** |
| What could break? | **Yes — §N/Q** |
| How Phase 2 proves it? | **Yes — tests A–O** |

### GO / NO-GO: **CONDITIONAL GO**

**GO** to design Phase 2 implementation **for Option B embed** because both architectures and the wire contract are understood from source.

**Gates before coding Phase 2:**
1. **Human/legal:** AGPL terminal embedded in MIT product (§P).  
2. **Product:** data strategy for Price & Chart (gateway Binance symbols vs future LSE↔wire bridge) — **no fake book**.  
3. **Toolchain:** ability to build or obtain EdgeDepth artifacts (emsdk 4.0.15 + protoc 21.x) — **not present in this sandbox**.  
4. **Server:** acceptance that COOP/COEP (or COI worker) will be added to LSE — that is a production change deferred to Phase 2.  
5. **Binance reachability** from deploy environment (this sandbox previously could not reach Binance).

**NO-GO** for: rewriting EdgeDepth in React; enabling heatmap/DOM UI without a real book feed; starting Phase 2 file edits in this phase.

---

## ANTI-SHORTCUT COMPLIANCE (§26)

| Rule | Status |
|------|--------|
| Not README-only | Used README + `ARCHITECTURE.md` + headers/impl of managers, hub, server, app.js, mount, protos |
| Not filename inference | Functions/paths cited (loadChart, pushToChart, MessageHandler cases, Hub.VolumeHistory, …) |
| No memory-recreated EdgeDepth | Structure from checkout `1fea3c4` |
| No TradingView/React chart substitution proposed as EdgeDepth | Rejected Option D |
| No fake DOM/heatmap claims | Data gaps explicit |
| No L2/L3 assumption | L2 **absent** in LSE; L3 vault exists separately, not chart-wired |
| No production edits during audit | HEAD/tree unchanged; only new audit + prior plan files untracked |
| No “integration ready” without file evidence | Evidence in-line throughout |

---

## COMPLETION CHECK (§27)

Phase 1 answers **1–12** are in sections B–Q with path-level citations.

---

# AUDIT COMPLETE — IMPLEMENTATION HAS NOT STARTED.

**Stop.** Do not copy EdgeDepth into LSE, do not modify the chart, do not begin Phase 2 until instructed (and gates in **R** are addressed).
