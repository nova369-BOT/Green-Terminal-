# Green Terminal ↔ G-Flow linked controls proposal (comparison option A)

**Status:** not selected. The user chose option B on 2026-10-05: one canonical Green Terminal price chart with G-Flow flow-only companion panels. This document remains only as the audited alternative behind `design/mockups/gflow-architecture-comparison.png`; it is not the implementation plan.

## Goal

Green Terminal remains the only product and the only primary control surface. When a user changes a supported chart style, drawing, or indicator from the Green Terminal chart controls, the adjacent G-Flow chart changes too. G-Flow reports what it actually applied; it never pretends to support a mode or study that its engine cannot render.

## Recommended architecture: capability-aware dual-engine link

1. Green Terminal is the authority for standard chart controls.
2. A versioned, revision-based host bridge sends semantic commands to the existing EdgeDepth WASM instance. It does not send ticks and does not create another WebSocket.
3. EdgeDepth acknowledges the applied state. The shell shows one small status strip in the G-Flow header:
   - `LINKED` when both engines match.
   - `PARTIAL` with the unsupported feature names when only a subset can be mirrored.
   - `G-FLOW NATIVE` while an EdgeDepth-only Footprint, TPO, Flow & Positioning, or other flow view is selected.
4. Commands are emitted only when state changes; drawing snapshots are debounced and revisioned. There is no per-frame host polling and no duplicate data subscription.

## Exact capability plan

### Chart styles

All 15 Green Terminal styles will be exact on both chart surfaces. Existing EdgeDepth modes remain intact.

| Green Terminal style | EdgeDepth action |
|---|---|
| Candles | Existing native Candles |
| Heikin Ashi | Existing native Heikin Ashi |
| Line | Existing native Line |
| Renko | Existing native Renko |
| Bars | Add native OHLC bars |
| Hollow Candles | Add native previous-close-aware hollow candles |
| Volume Candles | Add native volume-width/volume-colour candles to the same contract used by Green Terminal |
| Line Markers | Add native close line + point markers |
| Step Line | Add native step renderer |
| Area | Add native close-line area renderer |
| HLC Area | Add native high/low/close area renderer |
| Baseline | Add native baseline renderer |
| Line Break | Port Green Terminal's line-break transform into EdgeDepth |
| Kagi | Port Green Terminal's Kagi transform into EdgeDepth |
| Point & Figure | Port Green Terminal's point-and-figure transform into EdgeDepth |

EdgeDepth-only modes — Footprint Cluster, Footprint Profile, TPO, and Flow & Positioning — stay available under the retained **Flow views** control. Green Terminal will not fake those modes on its chart.

### Drawings

The common geometry set will be bidirectional: selecting the tool from Green Terminal arms both surfaces; placement or editing on either chart updates one canonical Green Terminal drawing object and mirrors it to the other chart.

Direct mappings include Trendline, Arrow, Ray, Extended Line, Horizontal Line, Horizontal Ray, Vertical Line, Cross Line, Rectangle, Brush, Measure, Fibonacci Retracement, Long Position, Short Position, Text, and Parallel Channel. Colour, width, line pattern, anchors, locks, visibility, text, and supported per-tool settings are converted.

Green Terminal's advanced shapes/patterns that have no EdgeDepth semantic equivalent remain Green Terminal-only. Selecting one disarms that tool in G-Flow and changes the link strip to `PARTIAL · <tool> is GT-only`; it never substitutes a different shape. EdgeDepth-only drawing semantics remain available in standalone/default EdgeDepth and are not deleted.

Green Terminal owns persistence for mirrored objects. EdgeDepth's existing standalone drawing persistence remains untouched; mirrored objects are tagged as external so they cannot be double-saved or merged as unrelated local drawings.

### Indicators

The first coherent linked set will be exact, parameter-aware, and computed from each engine's own real candles:

- Existing EdgeDepth: Volume, RSI, MACD.
- Added natively because they are core Green Terminal/default studies: SMA, EMA, VWAP.

Add/remove/edit operations synchronize, including RSI length, MACD fast/slow/signal, and moving-average length. The bridge sends indicator specifications, never fabricated values.

Other Green Terminal studies remain GT-only until EdgeDepth has a mathematically equivalent native implementation. EdgeDepth flow studies — CVD, Absorption, Funding Rate, Open Interest, and VPIN — remain G-Flow-only. The status strip reports partial capability instead of claiming a false match.

## State and conflict policy

- **Canonical standard state:** Green Terminal.
- **Canonical mirrored drawings:** Green Terminal drawing IDs and persistence.
- **EdgeDepth acknowledgements:** current chart type, mirrored drawings revision, mirrored indicator specs, native flow-mode state, and last command error.
- **Flow-native override:** choosing Footprint/TPO/etc. on G-Flow changes only the right surface and marks it `G-FLOW NATIVE`. The next Green Terminal chart-style choice returns both to linked standard mode.
- **Real-time view:** keeps its existing takeover behavior. It reports `G-FLOW NATIVE · REAL-TIME`; standard chart/drawing/indicator commands remain queued as canonical state and are reapplied after Real-time exits.
- **Unsupported actions:** no silent no-op and no closest-looking fallback.

## UI proposal

No second toolbar is restored. The existing Green Terminal chart-style, drawing, and indicator controls remain the only standard controls. The only new UI is a compact read-only link strip inside the G-Flow header, e.g.:

`● LINKED   HOLLOW CANDLES · 1h   DRAWINGS 4/4   RSI 14 · SMA 20`

When capabilities differ:

`● PARTIAL   GANN FAN IS GT-ONLY   RSI 14 LINKED`

See `design/mockups/gflow-linked-controls-proposal.png`.

## Risks and mitigations

- **Transform parity:** Renko/Line Break/Kagi/Point & Figure must use pinned fixture tests against Green Terminal transforms, not visual approximation.
- **Drawing conflicts:** revision IDs plus source IDs prevent update loops; the canonical store rejects stale acknowledgements.
- **Different venue candles:** drawings use absolute time/price anchors, but indicators are computed independently from each engine's own market data. A study is therefore semantically the same without pretending two venues have identical values.
- **Non-time charts:** transformed chart modes publish their actual x-coordinate mapping; unsupported drawing interactions are explicitly disabled rather than mispositioned.
- **Performance:** commands are state changes only; no candle/tick duplication, no extra WASM instance, no extra socket, no unbounded snapshots.
- **Persistence:** external mirrored drawings are separated from EdgeDepth standalone drawings so storage merge logic cannot duplicate or overwrite them.

## Acceptance tests

1. Hollow Candles and Renko render as their real mode on both surfaces.
2. Every one of the 15 Green Terminal styles passes an exact command/ack test and a renderer fixture test.
3. Common drawings placed or edited on either surface converge to identical time/price anchors without event loops.
4. Unsupported drawing tools visibly report GT-only and never produce a substitute drawing.
5. SMA, EMA, VWAP, Volume, RSI, and MACD add/remove/edit on both surfaces with matching parameters and each engine's real candles.
6. Unsupported indicators visibly report GT-only; flow indicators visibly report G-Flow-only.
7. Symbol, venue, timeframe, Real-time, DOM, order book, heatmap, and flow modes continue to work.
8. One EdgeDepth instance and the existing socket/data architecture remain; no new polling loop or duplicate WebSocket.
9. Standalone EdgeDepth defaults and full capabilities remain unchanged.
10. Unit, native, WASM, frontend, Python, desktop, startup, persistence, and live data-flow regression checks pass before completion.
