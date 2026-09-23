# GREEN TERMINAL — Advanced Phase 3 (Visible UI): Market → Price & Chart

## VISUAL CHANGES

What the user can now see immediately on MARKET → PRICE & CHART:

1. **Workspace opens without an LSE API key.** The previous connect-wall hid the entire chart surface. Without a key the shell now lands on the bundled **Demo (synthetic)** provider so the full Price & Chart workspace is visible on first open. Adding a key via the top-left connection bar still switches to live LSE.
2. **GREEN TERMINAL branding** — document title, header brand slot.
3. **Professional instrument header** (`#instrument-bar`) — symbol, name, provider title, last, change vs prior bar, BID/ASK/SPREAD, VOL, session badge, timeframe chip, honest `● LIVE / DELAYED / RECONNECTING / OFFLINE / HISTORICAL / REPLAY` feed badge.
4. **Workspace controls** — Fullscreen / Save / Load / Reset strip under the header (wired to the existing shell workspace store).
5. **Right information rail** — dense OVERVIEW / MARKET / SESSION / TECHNICAL columns filled only from real series and quotes (missing cells stay `—`).
6. **Bottom status strip** — DATA · FEED · LATENCY · SESSION · SYMBOL · TF · WORKSPACE. Latency only renders when `/api/market-data/health` reports a real EWMA; never invented.
7. **Watchlist change %** — each live row now shows price, spread, and board `change_pct` (demo + LSE board shape).
8. **GREEN TERMINAL accent** on active rail / subrail items (restrained green, not a green-washed UI).

## FUNCTIONAL CHANGES

| Control | Behaviour |
|---|---|
| MARKETS rail (no key) | Opens Price & Chart on `demo` instead of blocking on connect form |
| Fullscreen | Body class expands `#charts` to the viewport; chrome hides; chart resize fires |
| Save / Load / Reset | Persist / restore / reset instrument, TF, chart type, active indicators via `/api/workspace/shell` |
| Watchlist % | Polled from `/api/prices` (demo board now serves real walk closes + change) |
| Info rail | Recalculates OHLC/session/SMA/EMA/RSI/VWAP from the active candle series on every bar update |
| Status strip | Ticks with instrument bar; health poll every 5s for honest latency |
| Chart engine | Unchanged from Phase 2: candles/OHLC/line/area/HA/renko, TFs, indicators, drawings, multi-grid layout button, crosshair, volume |

## DATA

| Source | Supplies | Notes |
|---|---|---|
| **demo** | OHLCV, L1 quotes, trades, stream, **price board** (new) | Synthetic walk — labeled “Demo (synthetic)” everywhere it appears |
| **lse** | OHLCV, price board, options, screener (key required) | Connect form still one click away |
| **userdata** | History-only imports | No live board rows (history label) |

No L2/L3 is simulated. No prices are hardcoded in the UI. Status labels never claim LIVE for a dead socket.

## FILES

**Created**
- `PHASE3_UI_REPORT.md` (this file)

**Modified**
- `lse_terminal/providers/demo.py` — `prices()` board (price/bid/ask/change/change_pct from the 1m walk)
- `lse_terminal/contracts/provider.py` — `prices` capability detection
- `lse_terminal/ui/static/index.html` — GREEN TERMINAL title/brand; `#chart-stage` / `#chart-col` / `#info-rail` / `#ws-controls`; bottom `#term-status`
- `lse_terminal/ui/static/style.css` — chart-stage layout, info rail, workspace buttons, status strip, fullscreen, watchlist % column, green accents
- `lse_terminal/ui/static/app.js` — markets gate opens demo without key; `updateInfoRail` / `updateTermStatus` / `pollMdHealth` / `setupWsControls`; board change paint; provider title in header; watchlist % cell
- `tests/test_market_data.py` — +2 tests (demo board shape, shell UI markers)

**Removed** — none.

## TESTS

| Gate | Result |
|---|---|
| `pytest tests/test_market_data.py` | **12 passed** |
| `node tests/chart_engine.mjs` | **all assertions passed** |
| `node --check app.js` | **exit 0** |
| `ast.parse` demo.py / provider.py | **OK** |
| HTML structure (tag balance) | **0 errors** |
| Live smoke (`:7788`) | capabilities / prices / candles / GREEN TERMINAL + chrome markers present |

**Not completed here:** headless Chromium screenshot — every browser binary download is blocked in this sandbox (TLS resets to googlechromelabs / playwright CDN / debian mirrors; no root apt). The rendered-UI acceptance must be confirmed on the **Render preview** (or any local browser) after deploy.

## REMAINING LIMITATIONS

1. **Screenshot checkpoint (§37)** deferred to the live Render URL — sandbox cannot install a browser.
2. Demo feed is **synthetic** (existing provider purpose); source label and provider title say so. LSE live needs a key.
3. Latency cell stays `—` until market-data health has an EWMA sample (honest, not fake).
4. Drawing tools / indicator menus / multi-chart grid are Phase-2 chart-engine surfaces already in `chart.js` — not re-built this phase; Fullscreen + workspace Save/Load/Reset are the new shell controls.
5. First watchlist paint of % waits for the first `/api/prices` poll (~1s).

## §38 / §40 HARD STOP

No DOM, L2/L3 UI, MBO, heatmap, footprint, tape, delta, CVD, or volume-profile was implemented. Awaiting explicit approval for the next phase.
