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

## Item 3 — Advanced Settings tab: column/text shrinker  🔧 QUEUED
- User: "make an advanced setting tab ... shrink the columns, text, etc to make
  sure everything is visible."
- Locked design: dedicated ⚙ Settings panel (mockup advanced-settings-display.png):
  - Interface scale slider (70–130%) — shrink/enlarge everything at once.
  - Density presets: Comfortable / Compact / Ultra-compact (data tables).
  - Watchlist controls: row height, font size, per-column show/hide checkboxes.
  - Live preview of the effect.
- Mockup approved (pending any tweaks). Approach A+B.

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

## Item 7 — Advanced indicator browser (beat TradingView)  🔧 QUEUED (big)
- User: "more advanced indicator tab ... shouldnt look like TradingView ...
  more advanced than it." Editing a setting (length/stddev/source/etc.) must
  update the live candlestick preview; must scale to indicators with MANY
  settings.
- Locked design: advanced-indicator-browser-v3.png:
  - Tabs: Indicators · Strategies · Metrics; search + filter chips; favorite ★.
  - Cards with mini live preview; "On chart" badge + hover Remove.
  - Right inspector: Preset dropdown, live preview (updates as you edit),
    grouped INPUTS / STYLE / FILL / VISIBILITY / ALERTS, Remove/Reset/Apply row.

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
2 ✅ → 1 ✅ → 8 ✅ → 4 ✅ → **7 (next)** → 3.
Item 5 still BLOCKED: user must pick (a) horizontal rail at the right end of the
top toolbar, or (b) vertical rail on the chart's right edge. Item 6 pairs with 5.
