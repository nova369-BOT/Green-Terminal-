# Orderflow — Step-by-Step Fidelity Build (on the restored dd07 base)

Baseline: branch `arena/01a0f82b-green-terminal` = `3b7b6fc`
("version persisted workspace documents"). Preview = Docker on the user's
machine (`docker compose up`, port 7787); sandbox used for gates only
(this sandbox has no exchange network access — structural + honesty-labeled
demo verification here, live verification on the user's preview).

Accuracy law: verified provider frames only; aggressive side from provider
aggressor flag only; honest Syncing/Reset/Offline states with reasons;
per-widget venue/product labels; no interpolation, no simulated depth.

## Existing inventory (verified in tree)
- 12-type catalog (`workspaceWidgets.ts`), add/remove/reorder/link/preset/reset,
  persisted layout.
- Live panels already wired: Trades (24 prints, plain), DOM (validated L2,
  top-8), CVD/Delta, Footprint, Heatmap, Volume Profile, Market Stats.
- Missing renderer: **orderbook** (declared, no mount).
- Backend: StreamHub + bus; Binance trades/depth feeds; depth book with
  sequence-validated bridge (LocalOrderBook). Depth stream lacks bounded
  awaits (proven hang class — fix in Step 1).
- Gapped: G-Flow-grade ladder (grouping, columns, accumulator, fps),
  real-time settings panel, chart layers.

## Steps (each = vertical: lib + renderer + wiring + tests + commit + preview check)

### Step 1 — Data-plane reliability + Orderbook + tape backbone ✅ current batch
1a. Depth stream bounded awaits (backport of the incident-proven fix:
    open/per-frame/snapshot deadlines, self-named TimeoutError→DEPTH_RESET,
    bare-exception reason fallback, cancel on timeout) + 3 pytest contracts.
1b. `frontend/src/lib/tape.ts` — ring-buffer tape + session stats
    (count, VWAP, buy/sell volume, open/high/low/last) + node test suite.
1c. Trades panel → ring-backed tape (side-colored rows, stats footer,
    reason-honored empty state); **add missing Orderbook renderer**
    (bid/ask with running totals, mid + spread strip, same validated depth
    state as DOM).
Verify: tsc clean, vite build, node+pytest suites green, preview boots
(demo-labeled stream flows), commit, report.

### Step 2 — G-Flow DOM ladder v1
Contract `src/ui/realtime_dom_ladder.{cpp,h}` + `dom_widget.{cpp,h}`:
centered price ladder around mid, grouping selector (Coin / 5-min volume),
columns BUYS | BIDS | PRICE | ASKS | SELLS | DELTA, top-of-book delta tint,
settings pane. Node parity tests vs contract points.

### Step 3 — DOM accumulator + fps + reset presets
Trade-at-price accumulator from real prints (ring per level), reset
presets, visible fps/render counter, instrument-change flush.

### Step 4 — Real-time settings panel (G-Flow menu)
Pause display, follow price / auto-fit, recent window, min trade value,
session retention bounds — live-wired to tape/DOM/heatmap.

### Step 5 — Chart layer: order-book depth heatmap (on main chart)
Canvas layer behind candles from accumulated real book states only;
brightness control.

### Step 6 — Chart layer: trade bubbles
Sized from real executions (radius = min(24, 3 + 2·log2(1 + 8·v/ref)));
recalibrate control.

### Step 7 — Footprint per-period columns + VPVR side profile
Bucketed buy/sell cells, 3:1 imbalance shading, POC band.

### Step 8 — CVD/Delta canvas series
Cumulative line + per-period hist from real prints.

### Step 9 — Watchlist (24h change) · Step 10 — Replay (record live JSONL,
scrub/speed) · Step 11 — Paper trading (fills at real top-of-book) ·
Step 12 — Ledger cleanup.

## Ledger
- 2026-10-02 Step 1 started.
