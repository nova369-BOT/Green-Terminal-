# G‑Flow × Chart — Integration Plan (sketch + research, pre‑code)

**Goal:** bring order flow (G‑Flow) and the price chart into ONE workspace, the way
pro order‑flow terminals do — so you read the candle and the liquidity at the same
moment — instead of jumping to a separate G‑Flow page. This is a *planning* doc:
mockups + research + phased approach. No code until a layout is approved.

---

## 1. How the pros lay it out (research)

Every serious order‑flow platform puts the flow **next to / on** the chart, all
sharing the **same price axis**, in a **dockable** workspace:

- **Bookmap** — the "chart" IS a liquidity **heatmap** over price×time (resting
  limit orders as colour), with **volume bubbles** (executed trades), best bid/ask
  lines, a **DOM ladder** pinned to the right edge, and a **CVD** subpane below.
- **ATAS** — **footprint/cluster candles** on the chart (bid×ask volume inside each
  bar, imbalances highlighted), a **Depth‑of‑Market histogram** on the right of the
  chart, a separate **Smart DOM** ladder, **volume profile** beside the chart, and a
  **delta/CVD** subpane.
- **Quantower** — chart + **Footprint (cluster)** + **DOM ladder** + **DOM Surface**
  (heatmap) as dockable panels, one shared instrument, saveable layouts.

**The common recipe:** center = price (candles or footprint); right edge = DOM
ladder + heatmap sharing the price levels; bottom = CVD / delta; everything locked
to one symbol; panels are collapsible/resizable.

**The lesson for us:** don't fuse the two rendering engines on day one. Dock them
side‑by‑side, share the symbol, and align the price axis. That's 80% of the value at
a fraction of the risk. Footprint‑on‑our‑chart is a later, bigger phase.

---

## 2. What we have today

- **Chart** = our React/canvas `ProChart` (drawing tools, indicators, etc.).
- **G‑Flow** = the real **EdgeDepth WASM** runtime loaded in an **iframe**
  (`/edgedepth/index.html`) inside a separate `#orderflow` page. It already renders
  DOM, heatmap, tape, footprint, and already has a **"Use chart symbol"** button.

So the pieces exist; they're just in two different rooms. Integration = put them in
one room and keep their symbol in lock‑step.

---

## 3. The three sketched layouts

Files (open in the viewer):
- `design/gflow/layout_A_docked_ladder.png`
- `design/gflow/layout_B_split.png`
- `design/gflow/layout_C_footprint_vision.png`

### Layout A — Chart center + G‑Flow **docked ladder/heatmap** on the right  ★ recommended Phase 1
Candles fill the center; a G‑Flow strip on the right shows a liquidity **heatmap
column + numeric DOM ladder** aligned to the chart's price levels; a slim **CVD**
subpane sits under the chart. One shared symbol with a `SYNCED` badge.
- **Pros:** most information‑dense, price levels line up, closest to Bookmap/ATAS,
  fits our existing right‑docking pattern, ladder is collapsible on small screens.
- **Cons:** the docked strip is narrow — deep DOM study still wants Expand.

### Layout B — **50/50 split**: chart left, full G‑Flow right
A draggable divider; left = chart with tools, right = the full EdgeDepth heatmap +
bubbles + edge ladder. One unified symbol header drives both.
- **Pros:** simplest to build (we already have both surfaces; just place them side by
  side in one view), gives G‑Flow real room, lowest risk.
- **Cons:** price axes are independent unless we sync scales; less "fused" than A.

### Layout C — **Footprint candles** (Phase 2 vision)
Our chart itself renders footprint/cluster candles (bid×ask per level, delta totals,
imbalance highlights) with a DOM ladder on the right and cumulative‑delta strip below.
- **Pros:** the ultimate, ATAS‑grade view; fully native.
- **Cons:** big engineering — needs real per‑price traded‑volume (bid/ask) data piped
  into ProChart and a new renderer. Treat as a later phase, not now.

---

## 4. Recommendation

1. **Phase 1 — build Layout B first (fast, low risk):** one "Chart + Flow" workspace
   = chart | draggable divider | G‑Flow, with a **single shared symbol** (change once,
   both follow) and a collapse/expand toggle. Keep the standalone full‑screen G‑Flow.
2. **Phase 1.5 — evolve toward Layout A:** align the price axis and add the slim CVD
   subpane so the docked flow reads like Bookmap/ATAS.
3. **Phase 2 — Layout C (footprint):** only after we confirm the data feed can give
   real bid/ask volume at each price; then build a native footprint renderer.

Rationale: reuses what we already have, ships value quickly, and keeps every step
**honest** — real WASM flow + real candles, no fabricated data.

---

## 5. Technical notes / risks

- **Two engines, one room:** chart (canvas/React) + G‑Flow (WASM iframe). We compose
  them in one flex layout; we do **not** rewrite either for Phase 1.
- **Symbol sync:** one source of truth for the active symbol; when it changes, call the
  existing G‑Flow symbol switch (`/edgedepth` `?symbol=` / the in‑app fast switch) so
  FLOW retargets without a full WASM reboot. Broker↔chart symbol spelling already has a
  normaliser in `app.js` — reuse it.
- **Price‑axis alignment (Layout A):** the hard part — the iframe owns its own scale.
  Options: (a) keep them visually adjacent without pixel‑perfect lock (Phase 1), or
  (b) later, drive both from a shared price range. Ship (a) first.
- **Performance:** order flow updates very fast. Verify chart + WASM side‑by‑side stays
  smooth; make the flow panel collapsible and pause it when hidden.
- **Small screens:** flow panel collapses to an icon; Expand opens full G‑Flow.
- **Honesty (house rule):** never fabricate DOM/volume; if the provider can't serve
  depth for a symbol, show an honest "no depth for this instrument" state.

---

## 6. Open questions for you

1. **Start with Layout B (split) or go straight for Layout A (docked ladder)?**
2. **Where does it live?** A new "Chart + Flow" entry in the MARKETS menu, or a toggle
   on the existing Chart page that slides G‑Flow in from the right?
3. **Default split ratio** (e.g. 60/40 chart/flow) and should it remember your drag?
4. **Phase 2 footprint** — do you want me to first check whether the live feed exposes
   real bid/ask volume per price (required before we can build true footprint)?
