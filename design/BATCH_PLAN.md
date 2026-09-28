# Green Terminal — Active Batch (source of truth)

This is the definitive list of the 8 items the user asked for in this batch,
transcribed from the user's own words. Nothing here is inferred. Update status
only; never silently drop or add an item.

Quality bar (user, verbatim intent): professional, advanced, NOT vibe-coded.
Every function well-built to avoid bugs while looking + functioning advanced.
Rules: PLAN → show mockup → get approval → code. Never claim done when not done.

---

## Item 1 — Seconds chart not loading  ✅ SHIPPED (399ae61)
- User: "The seconds chart isnt loading which is bad" ... "1 on render deploy".
- Diagnosis: seconds bars build only from LIVE trades; market was CLOSED
  (weekend gold) → no trades → blank. Not a code bug per se.
- Built: honest non-destructive on-chart notice (#seconds-notice) with 3 states:
  market closed / building live (waiting on first trade) / no live feed.
- OPEN VERIFICATION: confirm on the Render deploy WITH THE MARKET OPEN that a
  real seconds bar actually prints. If it stays blank with market open + live
  feed, there is a further real bug to fix.

## Item 2 — G-FLOW / yellow dock button hover  ✅ SHIPPED (7c92a87)
- User: pop out G-FLOW/options ONLY when the mouse is DIRECTLY on the button,
  never when merely close/near it.
- Built: trigger only on direct #dock-handle hover; stays open inside pill/focus.

## Item 3 — Advanced Settings tab: column/text shrinker  🔨 BUILD LANDED, needs on-app check
- User: "make an advanced setting tab ... shrink the columns, text, etc to make
  sure everything is visible."
- Locked design: dedicated ⚙ Settings panel (mockup advanced-settings-display.png):
  - Interface scale slider (70–130%) — shrink/enlarge everything at once.
  - Density presets: Comfortable / Compact / Ultra-compact (data tables).
  - Watchlist controls: row height, font size, per-column show/hide checkboxes.
  - Live preview of the effect.
- BUILT (DISPLAY panel, #display-panel): interface scale (80–120%) × density
  presets (comfortable/compact/dense) were already in; ADDED the Watchlist
  section — font-size slider (10–17px), row-height slider (auto/22–46px), and
  per-column checkboxes (Logo / Name / Bid/Ask / Change) — all applied live to
  the sidebar (the panel overlays it, so the preview IS the real watchlist) and
  persisted with the rest of state.display in the workspace shell section
  (Reset covers the new fields too). CSS vars --wl-font/--wl-rowh + gt-wl-no*
  body classes; density/scale path untouched.
- OPEN VERIFICATION: open ⚙ DISPLAY on the deploy, drag each slider and flip
  each checkbox — the sidebar should respond instantly and survive a restart.

## Item 4 — Multi-chart first-load shows OLD mode + blank panels  ✅ FIX SHIPPED (77d00aa)
- User: "whenever i first load the multi chart it just doesnt show the change of
  pairs functions it instead shows our old mode of setting the multi window."
- ROOT CAUSE (found in code, no screenshot): the shell's read-only pane badges
  (app.js paneBadgesUpdate) were anchored at each pane's TOP-left, sitting on
  top of the new per-pane header's pair picker → first load showed "SYM · TF"
  instead of the change-of-pair control. (The old LSEChartPanes system is dead
  code, never invoked — ruled out.)
- FIX: (a) moved pane badges to the pane's BOTTOM-left so the interactive header
  is never covered; (b) blank panels now show an explicit Loading/No-data state,
  with staggered fetches + exponential-backoff retry.
- OPEN VERIFICATION: confirm on Render with live data (sandbox has no feed, so
  panes read "No data" here by design).

## Item 5 — Move timeframe rail to the RIGHT-hand side  🔧 QUEUED / BLOCKED
- User: "fix this timeframe shift it to the right hand side."
- BLOCKED: need choice (a) horizontal rail moved to the right end of the top
  toolbar, or (b) vertical timeframe rail on the chart's right edge.

## Item 6 — Move search + watchlist UPWARD  🔧 QUEUED
- User: "move that search and watchlist upward this should be done professionally."
- Pairs with Item 5 (freeing the top-left).

## Item 7 — Advanced indicator browser (beat TradingView)  🔨 BUILD LANDED, needs on-app check
- User: "more advanced indicator tab ... shouldnt look like TradingView ...
  more advanced than it." Editing a setting (length/stddev/source/etc.) must
  update the live candlestick preview; must scale to indicators with MANY
  settings.
- Locked design: advanced-indicator-browser-v3.png:
  - Tabs: Indicators · Strategies · Metrics; search + filter chips; favorite ★.
  - Cards with mini live preview; "On chart" badge + hover Remove.
  - Right inspector: Preset dropdown, live preview (updates as you edit),
    grouped INPUTS / STYLE / FILL / VISIBILITY / ALERTS, Remove/Reset/Apply row.
- LANDED in the shell (#ind-panel, app.js Item-7 block): category rail +
  counts, search, filter chips, favourites, cards+columns views (persisted),
  "On chart" badge with hover-Remove on cards AND column rows, live preview
  (engine-computed for all 103 specs, client fallback in embed, zoom + wheel),
  and the inspector as the mockup's stacked sections:
  - PRESET row: Default + saved named sets per indicator (inline save form,
    delete), "Custom" shown the moment you edit away; applies to draft AND a
    live chart. Persisted (indPresets).
  - INPUTS: typed/bounded per spec, edits live-update preview AND chart.
  - STYLE: per-plot colour/width from the plots the engine actually returns
    (scales to indicators with many plots).
  - FILL: band fill between any two plots — toggle, From/To, colour, opacity
    (5–60%), gradient fade. Drawn in the preview AND on the real chart
    (series carry fillTo/fillColor/... through engineIndicators →
    toCustomIndicators → subplotRenderer band-fill pass, overlay + grouped
    subplot panes).
  - VISIBILITY: per-plot show/hide + timeframe chips — an indicator hidden on
    the current TF drops out of the chart payload but keeps everything
    (params/styles/alerts) and returns when the TF is back (indTfVis).
  - ALERTS: enable, plot, condition (crosses above/below · is above/below),
    value. Evaluated whenever a fresh indicator payload lands (bar refresh),
    once per bar; fires to the topline status + desktop notification
    (permission asked on first arm). Armed only when the indicator is on the
    chart; the row says so when it isn't. Persisted (indAlerts).
  - Footer matches mockup: Reset + Add to chart / Remove from chart.
- Persistence gap CLOSED: indStyle (was session-only!), indPresets, indTfVis,
  indAlerts now ride /api/workspace/shell both ways (boot + Save/Load buttons).
- HUD edit bridge upgraded: the on-chart HUD pencil for an engine indicator
  opens THIS browser at that indicator instead of the legacy chip popup.
- Verified: app.js syntax; 11 logic checks (presets/fill/tf-vis/alerts/payload
  merge non-mutation); 11 renderer checks for the new drawBandFill polygon
  (NaN-gap segmentation, gradient bounds) via esbuild; tsc clean; vite bundle
  rebuilt; repo suites chart_engine + tf_aggregate + indicators pass.
- OPEN VERIFICATION: drive it on the deploy — add Bollinger, set a fill, arm
  an alert, hide a band on 1m only, save+reload the workspace.
- Strategies + Metrics header tabs: 🔨 BUILD LANDED (this commit), needs on-app
  check. User: "no this has all been implemented already except Strategies tab
  … and Metrics tab … THE METRIC AND STRATEGY LAB". The modal is now the
  Indicator & Strategy Lab with a titlebar (tabs Indicators · Strategies ·
  Metrics + ×) over the shared 3-column body, matching
  mockups item7-tab-strategies.png / item7-tab-metrics.png.
  - Strategies tab: cards from the real workspace (`/api/ws-files`
    strategies/*.py incl. the 8 quant starters; rail All/Backtested/Starters/
    My strategies/Saved runs). A card's equity sparkline + win/net/trades line
    come from the NEWEST saved run whose report strategy label names the file
    (new `/api/backtest/saved/{id}/sparkline` endpoint returns an evenly
    thinned curve, first/last kept) — with no run the card honestly says
    "Not backtested yet" (no fabricated equity). Inspector = the file's own
    `#`-header description + last-run stat tiles + gold ▶ Run backtest (on the
    charted symbol/timeframe, zero costs — reuses runBacktest's contract so
    trades overlay the chart + full report opens; the saved report inherits
    the file path, which links the run back to the card) + Open in IDE
    (openScriptInIDE) + Open last report (openBacktestReport from the saved
    payload). Run cards: Open full report + Delete (DELETE route).
  - Metrics tab: 9 live metrics computed client-side over state.candleData
    (ATR, ATR%, Realized vol annualised from median bar spacing, Avg range %,
    Session range % (UTC day buckets), Sharpe, Trailing-window Max DD,
    20-bar return, Live spread bp from the quote stream — no spread history,
    honestly labelled). Gold-value cards with area sparklines + pinned/armed
    badges; inspector = lookback (defaults per metric), above/below + threshold
    → one-shot bar-close-crossing alert that disarms after firing, Pin to
    chart → floating live tiles top-right of #chart-stage (5s supervisor
    recomputes off the live candles). indMetrics (pins+arms+lookbacks) rides
    /api/workspace/shell next to indStyle/indAlerts.
  - Verified: server e2e (8 files listed; 7/8 starters backtest OK on
    DEMO:GOLD 1h — atr_normalized_phase_momentum's param guard surfaces its
    own honest 400; save→listing→sparkline (48pts/6000, endpoints+monotonic)
    →full-doc→delete round-trip); node harness driving the REAL extracted
    metr*/stratHead/stratSparkSvg functions on synthetic bars with analytic
    expectations (atr 10.000, rvol 187% ann on ±2% bars, maxdd -10.00%→0 as
    the drop rolls out of the window, sharpe sign, UTC day buckets);
    win_rate scale fixed (already a percent); node --check; tsc clean; vite
    rebuilt; pytest 23 pass (test_pack_size needed brue-language in the venv).
  - OPEN VERIFICATION: on the deploy — open all three tabs, run a starter from
    the card, pin ATR + arm a crossing alert, watch a tile live.

## Item 8 — Advanced on-chart indicator HUD/legend  ✅ SHIPPED (Part A 1dc50c3, Part B 974819d)
- User: replace the plain on-chart readout (SMA/EMA/OHLC text at top) with
  something unique, more advanced, professional; must let you EDIT / HIDE /
  DELETE each indicator right there.
- Locked design: onchart-hud-pro.png (flat instrument-cluster, radial gauge per
  indicator, per-indicator pencil/eye/× on hover, dashed "+ Add" tile).
- Accent: BRASS/GOLD (user final: "the yellow looks more professional" —
  reversed the earlier green choice).
- OHLC: REMOVED entirely (user: "remove that ohlc totally"). Keep only the slim
  symbol module (e.g. XAU/USD + GOLD tag).
- Build note: must live INSIDE ProChart.tsx (React) to access computed indicator
  values/colors. Hover controls wire to edit (open config) / hide (toggle) /
  delete (remove from activeIndicators); "+ Add" opens the Item-7 browser.

---

## Build order (agreed)
2 ✅ → 1 ✅ → 8 ✅ → 4 ✅ → **7 🔨 landed (on-app check next)** → 3 🔨 landed
(on-app check next). Item 5 still BLOCKED: user must pick (a) horizontal rail
at the right end of the top toolbar, or (b) vertical rail on the chart's right
edge. Item 6 pairs with 5.
