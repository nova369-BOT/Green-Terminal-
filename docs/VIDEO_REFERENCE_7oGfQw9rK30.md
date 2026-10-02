# Reference video study — "I SPENT 2,471 HOURS BUILDING THE ULTIMATE ORDERFLOW PLATFORM"

- URL: https://youtu.be/7oGfQw9rK30 · Channel: XFlow Charts · Length 48:27 · Uploaded 2026-09-12
- Creator: "Vaslaf" (Czech Republic), sole developer of XFlow Charts (futures/crypto order-flow platform).
- Full transcript captured 2026-10-02 (auto captions). This file is the Phase-0 understanding record
  used as the UX/behaviour specification for the Green Terminal × EdgeDepth integration.

## What the video demonstrates (feature inventory)

### 1. One unified chart environment
- "Open chart" → a chart window opens INSIDE the platform. Additional windows of type:
  **Price chart · Depth of Market (DOM) · Times & Sales · Tick heatmap** can be opened and
  **connected to a chart** (linked symbol + replay clock). Everything lives in ONE app.
- Split screen 4/16 panels, shift-click placement, per-panel resize, multi-monitor.
- Symbol switching in-place (ES → NQ → MNQ, dated/stitched/continuous contracts, crypto tab).
  All linked panels follow the symbol.

### 2. Chart behaviour (TradingView-like)
- Zoom/squeeze/stretch axes, pan; Alt = select drawings, Ctrl = magnet snap.
- Annotations: draw, select, delete, edit (template, zones, border, text, alerts, per-interval
  visibility, import/export, pencil free-draw with shape recognition).
- Timeframes incl. range bars (e.g. 40R) + "history to load" (5 days … 3 months) selection;
  tick-level accuracy emphasised; extreme load speed emphasised.

### 3. Order-flow features shown
- **Footprint charts** (bid×ask), chart statistics panel, **CVD** (resizable sub-pane),
  **Big Trades** (aggregated / volume / MBO modes, threshold, average-fill-size readout),
  **speed of tape**, **stacked imbalances**, **Times & Sales** (filter by MBO/aggregated/volume/size),
  **Icebergs (MBO)**, **L2/L3 order-book indicators**, **heatmap** (liquidity contrast filter,
  recalibration on zoom, 8–48 h history), heatmap patterns discussion.
- **Volume profiles**: session/composite/visible/custom-period, volume vs delta vs volume+delta,
  POC/VA/VWAP/max-delta levels, "true levels" (tick granularity), tick grouping, single prints,
  peaks & valleys, extensive styling.
- Indicator categories: options flow (GEX via gigsbot), order book, order flow, price action
  (FVG, CCI, ATR, IVB/ORB), proprietary effort-zones + range-absorption.

### 4. Replay / backtesting
- Replay engine: 1x…200x speed, arrow-key skip, session hot-buttons (e.g. "NY open" with TZ),
  replay progress bar; DOM + T&S + heatmap all replayable and synchronized to one clock across
  multiple connected panels; SIM trading inside replay with PnL/positions.

### 5. Trading
- Trading panel: quantity / risk-based sizing ($ risk → auto SL), OCO, cancel-all, flat,
  SIM vs live accounts, prop-firm/Rithmic/dxFeed connections, drag SL/TP on chart,
  DOM click-trading (stops above, limits below, right-click cancel).
- P&L display in $ or ticks; positions page as lightweight emergency close.

### 6. Platform chrome
- Left rail: data provider (dxFeed/Rithmic), GEX connection, trading panel ($), screenshot,
  split-screen, settings (light/dark/custom colors, chart/position/order settings, keybinds,
  cache clearing), indicators dialog, replay, workspaces, templates.
- **Workspaces** (full multi-window layouts; personal/pre-made/community-shared),
  **chart templates** (per-chart), **indicator templates** — all shareable.
- Journal/statistics suite, macro news terminal, AI lab (private) — out of scope for GT phase 1.

## What this means for Green Terminal (mapping conclusions)
The video's core demonstrated experience — chart + DOM + tape + heatmap + footprint + CVD +
volume profile + replay operating as ONE linked environment with symbol-driven routing — is
exactly what the vendored EdgeDepth terminal (C++/ImGui/WASM) already implements natively
(dockable widgets, linked instrument, replay, DOM, heatmap, footprint, CVD, big-trade bubbles,
volume profile). Therefore the correct implementation is NOT to rebuild these in React/JS but to
surface the complete EdgeDepth engine inside Green Terminal's Market → chart environment, with:
- GT-owned symbol routing (GT symbol → venue instrument, e.g. BTC/USD → Hyperliquid BTC),
- honest connection states (gateway LIVE/OFFLINE, runtime READY/MISSING),
- preserved LSE chart + existing GT navigation/workspaces,
- one visual language (GT dark emerald/gold identity).
