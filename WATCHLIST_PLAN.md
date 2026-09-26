# Watchlist panel — COMPLETE inventory & what to implement (Trade view)

Every interactive piece of the cTrader watchlist ("Market Watch"), grouped. For each:
what cTrader does · what Green Terminal has today · what we'd build · effort · feasibility.

Sources: cTrader Help "Market Watch" (Web / Windows / Mac). **Real data only** — everything
marked 🟢/🟡 works off the live instruments/quotes and the chart+sim engine we already have.
🔴 = not honest/possible for a web app with no broker. Nothing built yet.

Legend — effort: S small · M medium · L large.

---

## A. Panel‑level controls (top & bottom of the whole panel)

| # | Element | cTrader | GT today | To build | Effort |
|---|---------|---------|----------|----------|--------|
| A1 | **Watchlists** tab | Shows your custom lists. | One combined list (favourites + category folders). | Split panel into a **Watchlists** view. | M |
| A2 | **All symbols** tab | Browse the full catalog by asset class. | We already show collapsible **category folders**. | Move it under an **All symbols** tab. | S–M |
| A3 | **Search / finder box** (Ctrl+F) | Type to filter; click to see all asset classes. | No type‑to‑filter box. | Add a **filter‑as‑you‑type** box. | S |
| A4 | **List / Tile view toggle** | Switch rows ↔ bigger tiles. | List only. | Add a **tile view** + remember choice. | M |
| A5 | **Pop‑out / detach** icon | Opens the watchlist in its own OS window. | n/a | 🔴 Skip (web app). Closest = our existing fold/expand. | — |
| A6 | **Create new watchlist** (bottom) | Name it → OK; make many. | None (single list). | The button + naming. | M |

## B. Per‑watchlist controls (each named list)

| # | Element | cTrader | GT today | To build | Effort |
|---|---------|---------|----------|----------|--------|
| B1 | **Expand / collapse** (▸/▾) | Fold a list. | Groups already fold. | Reuse. ✅ | — |
| B2 | **"+" add symbols to this list** | Opens picker/search to add. | Only the row **star**. | Header **"+"** → search‑to‑add. | S |
| B3 | **Rename** list | Rename your lists (not Popular markets). | None. | Inline rename. | S |
| B4 | **Duplicate** list | Copy a whole list (even Popular markets). | None. | Duplicate action. | S |
| B5 | **Delete** list | Remove a list. | None. | Delete action. | S |
| B6 | **Reorder whole lists** (drag) | Drag lists up/down. | None. | Drag list headers. | M |
| B7 | **Watchlist settings** | Toggle **daily change** display; toggle **single‑click expand**. | None. | Small settings menu. | M |
| B8 | **Asset units** | Choose unit display for assets. | None. | 🟡 Low priority. | M |
| B9 | **Popular markets** = default, non‑editable | Can't edit; can duplicate. | Our category folders are similar. | Make one **default** list. | S |

## C. Per‑symbol row controls

| # | Element | cTrader | GT today | To build | Effort |
|---|---------|---------|----------|----------|--------|
| C1 | **Click row → select** | Becomes active symbol / charts it. | **Click already charts it.** ✅ | Reuse. | — |
| C2 | **Star** (add/remove) | Add to a watchlist. | **We have the star.** ✅ | Extend to named lists. | S |
| C3 | **New order** icon | Opens order ticket. | We have a **sim** ticket + account dock. | Row **New order (sim)** button. | M |
| C4 | **Chart** icon | Open / new chart. | Click charts it. | Explicit **chart** button + "new pane". | S–M |
| C5 | **Remove from this list** | Take it off the list. | Star toggles off. | Reuse via star / menu. | S |
| C6 | **Asset‑class colour bar** | Thin colour strip = asset class. | We show logos/monograms. | Optional cosmetic strip. | S |
| C7 | **Bid / Ask columns** | Live bid & ask; click to quick‑trade. | We show **price + spread + %** (bid/ask in data, not shown). | Add **Bid/Ask columns**. | S |
| C8 | **Change: points + %** | Shows both (+20.7 / +0.18%). | We show **% only**. | Add **points** next to %. | S |
| C9 | **Open‑positions count** badge | Shows # open positions per symbol. | Sim positions exist. | 🟡 Small badge from sim data. | S–M |

## D. Symbol tile (the expanded view when you click a symbol)

| # | Element | cTrader | GT today | To build | Effort |
|---|---------|---------|----------|----------|--------|
| D1 | **Expand to a detailed tile** | Click a symbol to open/close a bigger tile (big bid/ask, spread, hi/lo, etc.). Expand as many as you want. | None (rows are one height). | Expandable tile with live detail. | M |
| D2 | **Buttons inside the tile** | New order, New chart, etc. | None. | Wire to chart + sim ticket. | M |
| D3 | **Single‑ vs double‑click to expand** (setting) | Configurable. | n/a | Tied to B7 setting. | S |

## E. Drag‑and‑drop behaviors ⭐

| # | Element | cTrader | GT today | To build | Effort |
|---|---------|---------|----------|----------|--------|
| E1 | **Drag symbol → drop on chart** | Charts that symbol instantly. | None. | Draggable rows + chart drop zone. | S–M |
| E2 | **Drop onto a specific pane** (our bonus) | (cTrader = new chart) | We have multi‑grid + a layout store. | Drop on a pane → only that pane switches. | M |
| E3 | **Drag to reorder within a list** | Reorder symbols. | None. | Reorder + persist order. | M |
| E4 | **Drag symbol between lists** | Move/copy across lists. | None. | Cross‑list drop. | M |
| E5 | **Drag whole lists to reorder** | Reorder lists. | None. | (Same as B6.) | M |

## F. Columns / display

| # | Element | cTrader | GT today | To build | Effort |
|---|---------|---------|----------|----------|--------|
| F1 | Columns: **Symbol · change(pts,%) · Bid · Ask** | Standard row layout. | Symbol · price · spread · %. | Re‑lay columns (see C7/C8). | S |
| F2 | **Daily change** on/off | Toggle. | Always %. | Toggle (B7). | S |
| F3 | **List vs tiles** | Two layouts. | List only. | (Same as A4.) | M |

## G. Settings (apply to all lists)

| # | Element | cTrader | GT today | To build | Effort |
|---|---------|---------|----------|----------|--------|
| G1 | Daily change on/off | ✔ | — | Small toggle. | S |
| G2 | Single‑click expand on/off | ✔ | — | Small toggle. | S |
| G3 | Double‑click / drag‑out action config | ✔ | — | 🟡 Optional. | M |
| G4 | Asset units | ✔ | — | 🟡 Low priority. | M |

---

## The full picture in one line each

- **Reuse (already have):** click‑to‑chart (C1), star add (C2), fold/collapse (B1), category browse (A2).
- **Small, real‑data wins:** Bid/Ask + points (C7/C8/F1), search box (A3), header "+" (B2), default list (B9).
- **The headline feature you spotted:** drag a symbol onto the chart / onto a pane (E1/E2).
- **The "many lists" system:** create/rename/duplicate/delete + switch (A6/B3/B4/B5), then add‑to‑list (B2) and drag between lists (E3/E4/E5).
- **Richer rows:** expandable symbol tile (D1/D2), New‑order‑(sim)/chart buttons (C3/C4), positions badge (C9), colour bar (C6).
- **Settings & view:** tile view (A4/F3), daily‑change & single‑click toggles (B7/G1/G2).
- **Skipping:** OS pop‑out window (A5) and anything needing a real broker.

## Recommended build order

1. **Drag a symbol → drop on the chart** (and onto a specific pane in split view) — E1/E2. ⭐ ✅ DONE (`12-dragchart`)
2. **Search/filter box** — A3 (needed to make "+" useful). ✅ DONE (`13-wlfilter`)
3. **Bid/Ask columns + points change** — C7/C8/F1 (fast, very "pro"). ✅ DONE (`14-bidask`)
4. **Multiple named watchlists**: create/rename/duplicate/delete + switch + header "+" — A6/B2/B3/B4/B5/B9. ✅ DONE (`15-watchlists`) — legacy `state.watchlists` array auto-migrates into a named list on first access (no favourite lost).
5. **Drag to reorder / move between lists** — E3/E4/E5. ✅ DONE (`15-watchlists`) — insertion indicator + drop onto list headers/rows; `text/gt-fromlist` distinguishes move vs copy.
6. **Expandable symbol tile** with chart button — D1/D2/C3/C4. ✅ DONE (`15-watchlists`) — per-row disclosure → Last/Bid/Ask/Spread/Change/Change% from real state + "Open chart" (order buttons need a real broker → skipped).
7. **Tile view** + **settings toggles** — A4/F3/B7/G1/G2. ✅ DONE (`15-watchlists`) — ⚙ popup: Tile view + Show daily change; prefs saved in localStorage.
8. Later/optional: positions badge (C9), colour bar (C6), asset units (B8/G4).

We build **one at a time** and I show each on your live Docker build before the next.
