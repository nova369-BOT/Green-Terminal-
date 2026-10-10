# Green Terminal + G-Flow — one-chart flow-panel architecture

**Status:** selected on 2026-10-05, implemented on the Arena session branch, and tightened on 2026-10-10 so PRICE & CHART exclusively owns standard chart tools.

## Product rule

Green Terminal is the product and `MARKET → PRICE & CHART` is the only owner of standard chart tools. Its 15 chart styles, 87 drawing tools, standard indicator registry, layouts, and persistence apply once to one canonical chart—there is no adjacent price-tool suite to drift out of sync. This ownership rule also applies while G-Flow's advanced surface is hosted inside Green Terminal.

G-Flow is the real EdgeDepth functionality integrated beside that chart. Its default embedded surface constructs no `ChartWidget` and subscribes only to the real flow data needed by:

- DOM ladder (resting depth + traded buys/sells/delta by price),
- cumulative Depth panel,
- trade tape,
- bounded live CVD strip calculated from real aggressor-classified trades.

No market value or missing history is generated. Live CVD explicitly starts at panel open and shows an honest waiting state until real trades arrive.

## One engine, two mutually exclusive surfaces

The existing single iframe and single WASM runtime are retained. Green Terminal chooses one URL mode at a time:

- `surface=flow&host=gt&watchlist=0&brand=0` — default companion; no EdgeDepth price chart, chart history request, shell ticker feeds, paper feed, or workspace restore.
- `host=gt&watchlist=0&brand=0&rt=0&tf=0&ctypes=flow&draw=0&ind=flow` — explicit **Advanced flow** takeover. Green Terminal's price canvas steps aside, while EdgeDepth exposes native Footprint, TPO, heatmap, replay, Flow & Positioning and RT without a second standard style/drawing/indicator suite.

The iframe is navigated between these modes; a second instance or socket is never created. **Advanced flow** opens from the dock header and returns through **Flow panels**. Its header carries the same host-owned RT command while the PRICE & CHART toolbar is out of view, and RT exit automatically returns to the default one-chart layout.

## Navigation rule

G-Flow is no longer a separate MARKET sub-tab. The MARKET subrail contains Chart, Options, News, and Screener. Flow panels are part of Chart, toggled by **Order flow**. Legacy internal calls to `showOrderFlowPage()` now open the in-place Advanced flow takeover rather than a separate section.

## Responsive layout

- Wide dock: live CVD spans the bottom; DOM occupies the main column; cumulative Depth and Trades stack in the right column.
- Narrow dock: live CVD remains at the bottom; DOM keeps the usable height; Depth and Trades share a tabbed detail node so fixed columns never clip.
- Max maximises flow panels without adding a price chart.
- Advanced flow always takes over the stage; it cannot be dragged into a side-by-side two-chart state.

## Data and performance

- Existing `StreamManager` reference-counting deduplicates the DOM/Depth orderbook subscription and the DOM/Trades/CVD trade subscription.
- The flow surface skips candle history and `ChartWidget` construction.
- Global ticker and paper subscriptions are skipped because the outer Green Terminal supplies product/market context and the surface has no paper/watchlist/stats panels.
- Live CVD stores at most one point per second for one hour (3,600 points).
- Venue/symbol truth still comes from EdgeDepth's current canonical route; Green Terminal retargets the same venue and never fabricates an unlisted market.

## Capability preservation

Standalone EdgeDepth is unchanged and retains every native chart mode, drawing, indicator, layout, and toolbar. Inside Green Terminal, Advanced flow retains Replay, Footprint, TPO, heatmap, Flow & Positioning, flow studies, and Real-time, but deliberately suppresses EdgeDepth's standard price styles, drawing controls/render layer, standard indicators/price-reference overlays, timeframe selector, layout/widget controls, and duplicate RT pill. Its hosted workspace storage is namespaced so these restrictions cannot rewrite a standalone EdgeDepth workspace. PRICE & CHART owns the standard controls.
