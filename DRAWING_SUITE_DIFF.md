# Green Terminal Drawing Suite — Full TradingView Diff & Advancement Plan

Source of truth: TradingView "Drawing tools available on TradingView"
(https://www.tradingview.com/support/solutions/43000703396). Every tool TradingView
lists is captured below with our status. Our rule: match the capability, then make it
**more advanced** in Green Terminal's own premium teal/emerald style (not a TV clone),
and never use fake data — volume/regression/VWAP tools compute from REAL candles only.

Legend: ✅ done · 🟢 building this pass · ⬜ planned · ➕ Green Terminal extra (beyond TV)

---

## 1. Cursors (cursor modes, not drawings)
- ✅ Cross (default select cursor)
- ⬜ Dot
- ⬜ Arrow
- ⬜ Demonstration (presenter highlight)
- ⬜ Magic
- ⬜ Eraser (click a drawing to delete)

## 2. Trend tools
Lines: ✅ Trendline · ✅ Ray · ✅ Info line · ✅ Extended line · ✅ Trend angle ·
✅ Horizontal line · ✅ Horizontal ray · ✅ Vertical line · ✅ Crossline
Channels: ✅ Parallel channel · 🟢 Regression trend · ✅ Flat top/bottom · ⬜ Disjoint channel
Pitchforks: ✅ Classic · ⬜ Inside pitchfork · ✅ Schiff · ✅ Modified Schiff

## 3. Fibonacci & Gann
Fibonacci (all ✅): Retracement · Trend-based extension · Fib channel · Fib time zone ·
Fib speed-resistance fan · Trend-based fib time · Fib circles · Fib spiral ·
Fib speed-resistance arcs · Fib wedge · Pitchfan
Gann (all ✅): Gann box · Gann square fixed · Gann square · Gann fan

## 4. Patterns
✅ XABCD · ✅ Cypher · ✅ Head & Shoulders · ✅ ABCD · ✅ Triangle · ✅ Three drives ·
✅ Elliott waves (Impulse / Correction / Triangle / Combo)
Cyclic: 🟢 Cyclic lines · ⬜ Time cycles · 🟢 Sine line

## 5. Forecasting & measurement
✅ Long & short positions · ⬜ Position forecast · ⬜ Bars pattern · ⬜ Ghost feed · ⬜ Sector
Volume: ✅ Anchored VWAP · ✅ Fixed-range volume profile · 🟢 Anchored volume profile
Measurers: ⬜ Price range · ⬜ Date range · ✅ Date & price range (Measure)

## 6. Geometric shapes
✅ Rectangle · ⬜ Rotated rectangle · ⬜ Path · ✅ Circle · ✅ Ellipse · ⬜ Polyline ·
✅ Triangle · ⬜ Arc · ⬜ Curve · ⬜ Double curve
➕ GT extras: Square · Diamond · Pentagon · Hexagon · Star · Cross · Arrow block ·
Wedge · Heart · Parallelogram · Octagon · Free triangle
Brushes/arrows: ✅ Brush · ✅ Highlighter · ✅ Arrow · ⬜ Arrow marker · ✅ Arrow marks (markers)

## 7. Annotation tools
✅ Text · ✅ Note · ⬜ Price note · ⬜ Pin · ⬜ Table · ✅ Callout · ⬜ Comment ·
✅ Price label · ✅ Signpost
Content: ⬜ Image · (X posts — skip, TV-network specific) · ~ Icons (✅ Emoji/sticker picker)

## 8. Chart management utilities
✅ Measure · ⬜ Zoom in · ⬜ Magnets (strong / weak) · ⬜ Keep drawing (multi-place) ·
✅ Lock all · ✅ Hide options · ⬜ Sync drawings across layouts · ✅ Remove

---

## Build order (remaining)
1. 🟢 **This pass:** Anchored Volume Profile, Regression Trend, Cyclic Lines, Sine Line
2. Channels/pitchfork: Disjoint channel, Inside pitchfork, Time cycles
3. Measurers: Price range, Date range (split from combined Measure)
4. Forecasting: Position forecast, Bars pattern, Ghost feed, Sector
5. Geometric: Rotated rectangle, Path, Polyline, Arc, Curve, Double curve, Arrow marker
6. Annotations: Price note, Pin, Comment, Table, Image
7. Cursors: Dot, Arrow, Eraser (+ Demonstration/Magic)
8. Utilities: Zoom in, Magnets (strong/weak), Keep drawing, Sync drawings

Every item shipped in tested batches: implement in `frontend/src/**` → `tsc` → build →
bump BUILD stamp → push → verify live on :7787.
