# Green Terminal + G-Flow — one-chart flow-panel architecture

**Status:** selected by the user on 2026-10-05 and implemented on the Arena session branch.

## Product rule

Green Terminal is the product and owns the only price chart in the normal `MARKET → PRICE & CHART` workspace. Its 15 chart styles, 87 drawing tools, indicator registry, layouts, and persistence therefore apply once to one canonical chart—there is no adjacent price engine to drift out of sync.

G-Flow is the real EdgeDepth functionality integrated beside that chart. Its default embedded surface constructs no `ChartWidget` and subscribes only to the real flow data needed by:

- DOM ladder (resting depth + traded buys/sells/delta by price),
- cumulative Depth panel,
- trade tape,
- bounded live CVD strip calculated from real aggressor-classified trades.

No market value or missing history is generated. Live CVD explicitly starts at panel open and shows an honest waiting state until real trades arrive.

## One engine, two mutually exclusive surfaces

The existing single iframe and single WASM runtime are retained. Green Terminal chooses one URL mode at a time:

- `surface=flow&host=gt&watchlist=0&brand=0` — default companion; no EdgeDepth price chart, chart history request, shell ticker feeds, paper feed, or workspace restore.
- `host=gt&watchlist=0&brand=0` — explicit native Workspace takeover; Green Terminal's price canvas and chart chrome hide before the complete EdgeDepth workspace is shown.

The iframe is navigated between these modes; a second instance or socket is never created. The native Workspace is opened from the dock header and returns through **Flow panels**. Native Real-time uses the same takeover and automatically returns to the default one-chart layout when it exits.

## Navigation rule

G-Flow is no longer a separate MARKET sub-tab. The MARKET subrail contains Chart, Options, News, and Screener. Flow panels are part of Chart, toggled by **Order flow**. Legacy internal calls to `showOrderFlowPage()` now open the in-place Workspace takeover rather than a separate section.

## Responsive layout

- Wide dock: live CVD spans the bottom; DOM occupies the main column; cumulative Depth and Trades stack in the right column.
- Narrow dock: live CVD remains at the bottom; DOM keeps the usable height; Depth and Trades share a tabbed detail node so fixed columns never clip.
- Max maximises flow panels without adding a price chart.
- Workspace always takes over the stage; it cannot be dragged into a side-by-side two-chart state.

## Data and performance

- Existing `StreamManager` reference-counting deduplicates the DOM/Depth orderbook subscription and the DOM/Trades/CVD trade subscription.
- The flow surface skips candle history and `ChartWidget` construction.
- Global ticker and paper subscriptions are skipped because the outer Green Terminal supplies product/market context and the surface has no paper/watchlist/stats panels.
- Live CVD stores at most one point per second for one hour (3,600 points).
- Venue/symbol truth still comes from EdgeDepth's current canonical route; Green Terminal retargets the same venue and never fabricates an unlisted market.

## Capability preservation

Standalone EdgeDepth is unchanged. The explicit Workspace takeover retains native chart modes, drawings, indicators, Replay, Footprint, TPO, Flow & Positioning, and Real-time. Only the normal integrated companion omits the duplicate price chart by design.
