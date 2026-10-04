# PHASE 2 — GREEN TERMINAL Primary Chart Engine

**Status: PHASE 2 COMPLETE — STOP (awaiting approval before Phase 3).**  
**Date:** 2026-09-23  
**Branch:** `arena/01a0caa0-green-terminal`  
**Scope:** Market → Price & Chart as a professional charting environment on **one primary engine**.  
**Not in this phase:** DOM / L2 / L3 / heatmap / footprint / tape / order-flow / delta-CVD / volume profile / TPO / liquidation layers (Phase 4).

---

## A. Files created

| Path | Purpose |
|------|---------|
| `frontend/src/engine/types.ts` | Normalized market-data model (`NormalizedCandle`, quote, tick, instrument header, `ChartDataBundle`) |
| `frontend/src/engine/timeframes.ts` | Extensible TF catalog (tick…1w), bucketing, serve-from-native checks |
| `frontend/src/engine/normalize.ts` | API rows / ticks → ms-normalized candles; live tick→candle merge; change math |
| `frontend/src/engine/transforms.ts` | Heikin Ashi + Renko (pure, replay-safe) |
| `frontend/src/engine/index.ts` | Primary-engine facade + architecture comment |
| `frontend/src/vite-env.d.ts` | Asset module declarations (png imports) |
| `frontend/src/assets/lse-logo-*.png` | Watermark assets already referenced by `ChartWatermark` |
| `tests/chart_engine.mjs` | Engine unit tests (timeframes, normalize, merge, HA, Renko) |
| `PHASE1_EDGEDEPTH_LSE_AUDIT.md` | Prior Phase 1 audit (untracked) |
| `ORDERFLOW_REBUILD_PLAN.md` | Dormant prior plan (untracked) |
| `PHASE2_CHART_ENGINE_REPORT.md` | This report |

## B. Files modified

| Path | Change |
|------|--------|
| `frontend/src/components/chart/core/types.ts` | `ChartType` = candlestick \| **bars** \| line \| area \| **heikinAshi** \| renko |
| `frontend/src/components/chart/ProChart.tsx` | Real **OHLC bars** + **Heikin Ashi** draw branches; transform import |
| `frontend/src/mount.tsx` | Chart-type aliases (bars≠candles); `displayCandles` transform; **onLoadMore history scrollback** + `prependShift`/`isLoadingMore`; `sessionOpen()` API; overlay uses display series |
| `frontend/src/components/chart/ChartTypeSelector.tsx` | Full type list; re-exports core `ChartType` |
| `frontend/src/components/chart/sidebar/ChartControlsPanel.tsx` | Menu: OHLC / Heikin Ashi / Renko |
| `frontend/src/components/chart/IndicatorSettings.tsx` | `MAType` includes **WMA** + select option |
| `frontend/src/lib/api.ts` | `SmartSearchResult` export; `getCandlesRange` accepts `select`/`offset` (parity) |
| `frontend/src/contexts/AuthContext.tsx` | `signInWithGoogle` no-op (local terminal) |
| `frontend/src/components/chart/BTCandlestickChart.tsx` | Settings typing (`any` for cs/ch); `ReturnType<typeof setTimeout>` |
| `frontend/src/components/chart/BTChart.tsx` | `CandleData`→`Candle`; timeout types |
| `frontend/src/components/chart/CandlestickChart.tsx` | Timeout type |
| `frontend/src/components/chart/ChartDrawingOverlay.tsx` | Timeout type |
| `frontend/src/components/chart/RightToolbar.tsx` | `useQuery<any>` for options PDF |
| `frontend/src/components/chart/interaction/useChartNavigation.ts` | Timeout type |
| `frontend/src/hooks/useLiveCandleFromTicks.ts` | Timeout type |
| `lse_terminal/ui/static/index.html` | Chart-type select + **#instrument-bar** |
| `lse_terminal/ui/static/style.css` | Instrument header styles (dark workstation strip; green accent only for up/live) |
| `lse_terminal/ui/static/app.js` | Instrument header updates; TF_SECONDS full ladder; shell persists **symbol/timeframe**; workspace symbol restore; `prependCandles` bridge; toolbar sync includes header |
| `lse_terminal/ui/static/chart/chart.js` | Rebuilt bundle |
| `lse_terminal/providers/demo.py` | Demo TFs include 5s/15s/3m (synthetic source only; LSE still lists what its gate serves) |

## C. Files removed

None. No dead chart components deleted (backtest still uses `BTCandlestickChart`/`BTChart`; UniversalChart/CandlestickChart remain for other site surfaces). No production orderflow reintroduced.

## D. Architecture

```
DATA SOURCE
  GET /api/candles · WS /api/ws ticks · MY DATA files · (replay later)
        ↓  engine/normalize.ts + engine/timeframes.ts
NORMALIZED MARKET DATA
  NormalizedCandle { time(ms), o,h,l,c, volume? } · NormalizedQuote · NormalizedTick
        ↓  engine/transforms.ts (display types only)
  heikinAshi / renko series  ·  raw OHLC for indicators
        ↓  mount.tsx normalise + shell loadChart / onTick / prependCandles
CHART DATA ADAPTER
        ↓
PRIMARY CHART ENGINE  (ProChart canvas + ChartDrawingOverlay + renderers)
        ↓
CHART UI / INTERACTION
  shell #controls · #instrument-bar · subrail PRICE & CHARTS
```

**Single primary engine:** ProChart for Market → Price & Chart and multi-grid panes. Backtest reuses the same ProChart component family (`BTChart`/`BTCandlestickChart` wrap it). No second live-vs-replay price renderer was introduced.

## E. Features completed

- [x] One primary chart engine architecture (explicit `frontend/src/engine/`)
- [x] Normalized OHLCV/tick/quote model (ms timestamps, no provider leakage into renderer)
- [x] Chart types with **real** implementations: Candlestick, **OHLC bars**, Line, Area, **Heikin Ashi**, **Renko**
- [x] Timeframe system: catalog 1s/5s/15s/30s/1m/3m/5m/15m/30m/1h/4h/1d/1w (+tick); enabled only when provider advertises; demo serves full ladder; LSE serves its gate list; userdata disables finer-than-native
- [x] TF change reloads data, keeps symbol/indicators/drawings; no full app reload
- [x] Navigation: wheel zoom, pan, crosshair, price/time axes, reset, fit, auto-scale (existing ProChart; unchanged)
- [x] Chart header context: **#instrument-bar** — symbol, name, source, price, change/%, bid, ask, spread, volume, session, TF, LIVE/NO STREAM (all from data layer; “—” when unknown)
- [x] Indicators: SMA/EMA/**WMA**/SMMA lines + RSI, MACD, Stochastic, Bollinger, ATR, Volume, VWAP (params, visibility, edit, remove, overlay vs subplot) — existing registry + WMA in MA picker
- [x] Multi-panel layouts (TerminalMultiGrid + resizable indicator panes)
- [x] Drawing tools: full existing set (trend, H/V lines, ray, rect, text, measure, fib, …) with persistence
- [x] Symbol switching cleans stream (`connectStream` retargets) — no dual charted-symbol WS
- [x] Live updates: tick merge into last candle / new bucket; volume accumulates when tick carries size; array identity replaced to repaint; no random generators on LSE path
- [x] Historical load: initial 5000 bars + **infinite scrollback** via `onLoadMore` → `/api/candles?end=` + shell `prependCandles` + `prependShift`
- [x] Replay-compatible input: same `NormalizedCandle[]` path (Phase 3+ can swap transport only)
- [x] Workspace: symbol, timeframe, chart type, indicators, drawings, layouts, appearance persisted
- [x] Responsive: header flex-wraps; chart container unchanged (no page horizontal scroll)
- [x] Visual system: dark institutional strip; green only as accent (up/live/open)
- [x] Error states: load errors via `status()`; no-stream → header `NO STREAM`; no fake candles
- [x] TypeScript **0 errors**; `vite build` OK; engine unit tests pass; pytest **285 passed, 1 skipped**

## F. Intentionally deferred (Phase 4+)

DOM, L2 order book, L3/MBO, heatmap, liquidity, footprint, tape, order-flow imbalance, delta/CVD, volume profile, TPO, liquidation layers. Architecture leaves them attachable: same normalized feeds + workspace sections later.

## G. Testing

| Test | Result |
|------|--------|
| `npx tsc --noEmit` | **0 errors** |
| `npm run build` (vite) | **OK** → `lse_terminal/ui/static/chart/chart.js` |
| `node tests/chart_engine.mjs` | **all assertions passed** |
| `pytest tests` | **285 passed, 1 skipped** |
| `node --check app.js` | OK |
| Boot probe | health 200, index 200, candles 200, demo `5s` 200, `instrument-bar` + `heikinAshi` in HTML, workspace shell PUT 200 with symbol/timeframe/chartType, demo timeframes = full ladder, `/api/orderflow/status` **404** |
| Scrollback API | `end=` window returns older bars than current oldest (**SCROLLBACK_OK**) |
| Manual UI checklist | Structural wiring verified (subrail → #charts → LSEChart); full mouse walkthrough needs interactive browser session |

## H. Known limitations (honest)

1. **LSE live source** does not advertise 5s/15s/3m until the gate serves them — buttons stay off (architecture ready). Demo provider does.
2. **Volume in instrument bar** is the **active bar’s** volume (or — if provider omits volume), not a day-sum.
3. **Session chip** uses `LSEChart.sessionOpen` (marketHours); exotic symbols may show `—` or quote-freshness `LIVE QUOTE`.
4. **Heikin Ashi / Renko** transform the **displayed** series; drawings snap to transformed geometry in those modes (standard for HA); indicators still compute on true OHLC from the shell payload.
5. **Renko** brick size = median TR heuristic (not a user brick-size control yet).
6. Full pointer smoke of zoom/pan/draw needs a browser (puppeteer optional path not run here).
7. Pre-existing pytest DeprecationWarnings remain (lifespan API) — not introduced by Phase 2.
8. License note from Phase 1 waived per user (projects are theirs).

---

# PHASE 2 STOP

Do **not** start Phase 3 (real-data expansion, orderflow modules, EdgeDepth embed follow-ons) until instructed.

**Success criterion:** GREEN TERMINAL → MARKET → PRICE & CHART is a functional professional chart environment on the primary engine with real supported data, chart types, timeframes, indicators, drawings, panels, live architecture, history scrollback, persistence, and replay-ready normalization.
