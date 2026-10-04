# Green Terminal — Unified Symbol + G‑Flow-on-Chart · MASTER PLAN

**Status:** planning only. No code until you approve.
**Target look:** `design/gflow/layout_A_docked_ladder.png` (chart center, G‑Flow ladder + heatmap docked right, CVD strip below).
**Big idea you asked for:** *before* docking G‑Flow onto the chart, make the whole app share **ONE active symbol** — a unified watchlist/symbol bus so G‑Flow, the chart, the ticket, and the watchlist are always on the same instrument, automatically.

---

## 1. Vision in one line

Pick a symbol **once** (from the watchlist, search, or a chart) and **everything** —
chart, order flow (G‑Flow), trade ticket, watchlist highlight — snaps to it together,
then show the flow **docked on the chart** (Layout A). One product, one symbol, one glance.

---

## 2. What the code actually does today (ground truth)

I read the real files. Here's the honest current state:

| Concern | Where | Reality |
|---|---|---|
| Chart symbol | `app.js` `state.symbol`, `setSymbol()` @4041 | Single source of truth for chart. `setSymbol` re‑renders watchlist, loads chart, reconnects stream, follows the ticket (`tpbFollowChart`). |
| Multi‑pane symbol | `LSEChart.layoutStore` (`setPanelSymbol`) | Per‑pane override when sync is off. |
| Watchlist | `state.watchlists` (per provider), `renderWatchlist()` @2443 | Rows call `setSymbol()` on click. Named lists, favorites, tiles/list views already exist. |
| **G‑Flow symbol** | `ofState.symbol`, `loadOrderFlowSymbol()` @12920 | **SEPARATE** state. Reloads the EdgeDepth WASM iframe with `?exchange=hl&symbol=COIN`. |
| G‑Flow ↔ chart link | `#of-usechart` button @12936 | **Manual only** — user must click "Use chart symbol". Not automatic. |
| G‑Flow scope | `loadOrderFlowSymbol` normalizes to a bare coin (BTC), `exchange=hl` | **Hyperliquid perps only** (crypto). LSE stocks / FX have no depth here. |
| G‑Flow page | `#orderflow` section, `showOrderFlowPage()` @13021 | A **separate full page**; iframe stays warm when hidden. |

**Two conclusions:**
1. There are **two symbol states** (`state.symbol` vs `ofState.symbol`). Unifying = make G‑Flow *follow* the one bus automatically instead of via a button.
2. G‑Flow only has data for **Hyperliquid crypto**. A unified symbol must know *which instruments actually have order flow* and show an honest empty state for the rest (house rule: no fake depth).

---

## 3. Architecture: the Unified Symbol Bus

Introduce a tiny, single owner of "what is the app looking at":

```
activeContext = {
  symbol,        // canonical app symbol, e.g. "BTC/USD" or "VOD.L"
  provider,      // hl | lse | fx | userdata ...
  timeframe,
  flow: {                 // capability + mapping for order flow
    available: bool,      // does this instrument have real depth?
    venue: "hl" | null,   // which flow venue serves it
    coin: "BTC" | null    // the symbol G-Flow/EdgeDepth expects
  }
}
```

- **One setter** — extend the existing `setSymbol()` (don't invent a parallel path).
  After it sets `state.symbol` and does its current work, it also:
  1. computes `flow` via a **capability map** (below), and
  2. calls `loadOrderFlowSymbol(flow.coin)` **only if** `flow.available` — otherwise puts
     G‑Flow into an honest "no order flow for VOD.L" state.
- **Subscribers** react to the bus: chart (already), watchlist highlight (already),
  ticket (already), and now G‑Flow (new auto‑follow) + the docked flow panel (Layout A).
- Multi‑pane stays as is: when panes have their own symbol, the docked flow follows the
  **active pane's** symbol.

### Capability map (which symbols have flow)
A small function `flowCapability(symbol, provider)`:
- crypto with a Hyperliquid perp → `{available:true, venue:"hl", coin: ofNormalizeSymbol(symbol)}`
  (reuse existing `ofNormalizeSymbol` @12905 and the `OF_HL_PRESETS` list).
- everything else → `{available:false}`.
This is the honest gate: it never pretends LSE/FX has depth.

---

## 4. Phased plan

### Phase 0 — Unified Symbol Bus (foundation, no visual change) ★ start here
- Add `activeContext` + `flowCapability()` + a single `broadcastSymbol()` helper.
- Wire the *existing* `setSymbol()` to compute `flow` and auto‑drive G‑Flow (replacing the
  manual `#of-usechart` dependency; keep the button as a manual override).
- Make G‑Flow's own `#of-symbol` input feed back into the bus (so changing it there also
  moves the chart, if you want that — or keep it local; decision in §7).
- **Acceptance:** click any Hyperliquid coin in the watchlist → G‑Flow retargets with no
  extra click; click an LSE stock → G‑Flow shows an honest "no depth" state; no console
  errors; chart/ticket/watchlist behave exactly as before.

### Phase 1 — Dock G‑Flow onto the chart (Layout A, first pass)
- New workspace: chart center + a right **G‑Flow dock** hosting the SAME warm
  `#of-frame` iframe (move it, don't duplicate — one WASM client only).
- Dock is **collapsible** (icon when closed) and **resizable** (drag handle), remembers
  width in `localStorage` (like watchlist prefs already do).
- Header shows the one shared symbol + `SYNCED` badge; the standalone full‑page G‑Flow and
  "Expand" fullscreen stay for deep study.
- **Acceptance:** one screen shows candles + live DOM/heatmap for the same coin; changing
  symbol moves both; collapse/expand works; only ONE EdgeDepth instance exists.

### Phase 1.5 — Make it read like Bookmap/ATAS
- Add the slim **CVD / delta subpane** under the chart.
- Best‑effort **price‑axis alignment** so the docked ladder's levels line up with the
  chart's right axis (visual adjacency first; shared price range later).

### Phase 2 — Native footprint candles (`layout_C`, big)
- Only after confirming the feed exposes **real bid×ask volume per price**.
- Build a footprint renderer in `frontend/src` (`ProChart` bar type), delta totals +
  imbalance highlights. This is a large, separate effort — not part of the first ship.

---

## 5. File change map (where the work lands)

- `lse_terminal/ui/static/app.js`
  - `setSymbol()` @4041 — hook in bus + auto‑flow follow.
  - new `activeContext`, `flowCapability()`, `broadcastSymbol()`.
  - `loadOrderFlowSymbol()` @12920 / `bindOrderFlowControls()` @12933 — accept bus updates;
    add honest "no flow" state.
  - new dock mount + collapse/resize logic (Phase 1).
- `lse_terminal/ui/static/index.html`
  - add the right‑dock container in `#charts`/`#chart-stage` (@420) that can host `#of-frame`;
    keep `#orderflow` page for full‑screen.
- `lse_terminal/ui/static/style.css` — dock layout, drag handle, collapsed state, teal/brass.
- `lse_terminal/engine/server.py` — only if we need a capability/flow endpoint (probably not
  for Phase 0; `/api/edgedepth/status` already tells us if the runtime is live).
- `frontend/src/**` — untouched until Phase 2 (footprint). Chart bundle only rebuilt if we
  touch it; **never hand‑edit** `chart/chart.js`.

---

## 6. Cross‑cutting rules

- **Honesty:** never fabricate depth. No HL perp → "No order flow for this instrument" panel.
  (Matches AGENTS.md: EdgeDepth is internal, never fake data.)
- **One WASM client:** the `#of-frame` iframe is expensive — move it between the page and the
  dock, never run two.
- **Performance (you flagged this):** flow updates fast. Pause/hide the iframe when the dock
  is collapsed; verify chart + flow side‑by‑side stays smooth on the live :7787 preview
  before claiming done.
- **Small screens:** dock auto‑collapses; "Expand" opens full G‑Flow.
- **Keep every existing feature:** watchlists, multi‑pane, ticket sync all keep working.

---

## 7. Decisions I need from you

1. **Two‑way or one‑way sync?** Changing the symbol in the *chart/watchlist* moves G‑Flow —
   yes. Should changing it *inside G‑Flow's own box* also move the chart? (I recommend **yes**,
   fully unified.)
2. **Non‑crypto behavior:** when you select an LSE stock (no depth), should the flow dock
   (a) show an honest "no order flow" message, or (b) auto‑hide until you pick a crypto?
   (I recommend **a** — visible + honest.)
3. **Where the docked view lives:** a toggle on the existing Chart page (slide G‑Flow in from
   the right) vs a new "Chart + Flow" menu entry. (I recommend a **toggle on Chart**.)
4. **Default dock width** (e.g. 320px / 26%) and remember your drag? (I recommend yes.)

---

## 8. How we start (first concrete step)

**Phase 0, one small PR:** the Unified Symbol Bus.
1. Add `flowCapability()` + `activeContext` near the top of `app.js`.
2. In `setSymbol()`, after the existing body, compute `flow` and call `loadOrderFlowSymbol`
   automatically when available (keep `#of-usechart` as manual override).
3. Add the honest "no order flow" state to the G‑Flow status render.
4. Verify on live :7787: pick BTC → flow follows with zero clicks; pick an LSE name → honest
   empty state; no regressions.

That single step makes the whole app "one symbol" with **no layout risk**, and every later
phase (docking, CVD, footprint) builds on it. Approve the four decisions in §7 and I'll start
with Phase 0.
