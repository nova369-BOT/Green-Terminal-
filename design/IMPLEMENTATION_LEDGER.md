# Green Terminal — 16-item implementation ledger

Final state of the ordered 16-item plan, with the commit that carries each
item and the exact honesty boundary of what is and is not claimed. Verified
2026-10-01 on branch `arena/01a0f82b-green-terminal`.

## Items 1–4 (batches 1–4, shipped before this ledger)

1. **Chart preserved, widget foundations** — every pre-existing chart feature
   (candles, Heikin Ashi, Line, Renko, drawing tools, indicators, chart
   settings, timeframes, crosshair) survived the widget wrap untouched.
2. **Widget registry + persistence** — versioned workspace document
   (localStorage + engine workspace file), 12×24 collision-safe grid,
   drag/resize/maximize/minimize, link groups A·B·C.
3. **Chart + DOM + Trades for BTC** — real status strip (Live/Stale/Syncing),
   sequence-validated L2 book (snapshot→update bridge, gap→reset, replay),
   Binance Spot/Perp product chips. Default pair BTC/USD.
4. **CVD series chart, session Volume Profile, Paper Trading** (`1abd49f`) —
   cumulative delta canvas from provider aggressor side only (honest
   "side missing" counters), TPX-style profile with POC/VAH/VAL/HVN/LVN ring
   buffer rebuild, sim fills against live marks with honest "no live price"
   rejections.

## Batches shipped in this session

5. **Items 10+11 — Orderbook, Watchlist, Replay Library, expanded stats**
   (`3ebadc9`):
   - Orderbook = read-only bars on the SAME validated L2 transport as the DOM
     (shared `useResolvedDepth`/`useStaleness`/`bookStats`), Spread/Mid/
     Imbalance, never a second stream.
   - Market Statistics = 12 cells; real Last/Bid/Ask/Source/feed-age only;
     Mark/Index/Funding/OI/24h set = NOT PROVIDED (feed does not publish them).
   - Watchlist = shell's real lists via `__lseShell.getWatchlists()` (5s poll),
     filter, per-row live quote, row click → `__lseShell.setSymbol` so the real
     chart and all linked panels follow. 24h change reads "—".
   - Replay Library = `GET /api/market-data/recordings` honest empty catalog
     (no recorder yet), amber REPLAY banner, disabled ▶ on rows.
6. **Item 12 — multi-chart grid + shell rail retirement** (`b5e399b`):
   chart `single`-lock removed; first visible pane = primary (full native
   engine); extra panes = `ChartTilePanel` (engine candles + live tick-formed
   bar with zero-fabricated volume, crosshair, OHLCV legend); CHART SPLIT
   1/2/4 mosaic from the workspace menu; `#info-rail`
   (OVERVIEW/MARKET/SESSION/TECHNICAL) removed from markup, JS writers, CSS.
7. **Item 13 — live venue catalogs** (`042d7b8`):
   `GET /api/market-data/flow-catalog` serves Binance TRADING USDT/USDC spot
   streams from live exchangeInfo (300s cache; 200 + reachable=false + note
   when unreachable). Frontend registers them into the dormant
   `registerFlowCatalog` seam; resolver maps DOGE/USD → DOGEUSDT by exact set
   membership. Catalog version store re-resolves DOM/Orderbook/Heatmap when
   the list lands.
8. **Item 14 — sync polish** (`810b87e`):
   per-pane timeframe cycle (1m→…→1d) in every panel header; primary pane
   bridges to the real engine (`__lseShell.setTimeframe` = shell's own
   state.timeframe + renderTimeframes + loadChart); other panes commit
   locally (tf link goes independent) and drive their link group. Tile
   crosshair time-sync via `chartCrosshairSync` (ghost cursor, bar-exact
   binary search, ~30Hz). Primary-pane crosshair is NOT mirrored (engine
   internal) — the menu says so.
9. **Item 15 — shell/G-Flow removal** (`4b738a8`):
   the iframed WASM second UI (#orderflow) fully excised — markup, ~170-line
   host, subrail tab pair (Chart+G-Flow), page-sweep hides, flyout keys, CSS,
   `/edgedepth` mount + `/api/edgedepth/artifacts` + config route, and the
   6.1 MB `static/edgedepth/` runtime. All-Symbols coin rows now open the USD
   pair on the main chart. Gateway supervisor + `/api/edgedepth/status` stay
   (engine lifecycle, relabeled GATEWAY).
10. **Item 16 — final validation** (this commit):
    - Engine imports clean; FastAPI route audit: recordings (200 `[]`),
      flow-catalog (200 + honest offline note), capabilities, instruments
      (binance-depth BTCUSDT), gateway status (CONNECTED), artifacts → 404,
      md-health DISCONNECTED (honest, no streams). Loopback guard verified
      (403 for non-loopback Host, 200 for localhost).
    - Widget consistency: 12 union types = 12 defs = 11 panels + chart
      special-case; picker groups and icons complete.
    - Bridges verified: `setSymbol`, `setTimeframe`, `getWatchlists`,
      `prependCandles` all present in `__lseShell`.
    - Default-pair fix: fresh workspace opens BTC/USD when the active catalog
      lists it (was implicit catalog row 0).
    - `tsc --noEmit` clean; `vite build` clean (chart.js 4,749.5 kB);
      `node --check app.js` clean; `py_compile` clean.
    - Live engine boot verified on 0.0.0.0:8000 (this session's preview).

## Explicitly NOT claimed (honesty boundary)

- **Hyperliquid / HIP-3 flow**: the engine has no HL provider today, so HL
  streams are absent from the flow catalog by design (the gateway reported
  "could not load symbol list" rather than inventing one). The resolver and
  endpoint light them up automatically when a real provider ships.
- **Replay playback**: catalog + transport UI ship in the Replay Library;
  the recorder/playback engine is a later item; ▶ stays disabled until then.
- **Primary-pane crosshair mirroring**: engine-internal, not bridged.
- **24h stats / funding / OI / mark / index**: venue feeds do not publish
  them into the normalized tick — cells say NOT PROVIDED, never derived.

## Long-standing rules preserved

One product / one UI; session branch only (`arena/01a0f82b-green-terminal`);
no faked depth, trades, CVD, footprint, heatmap, MBO or liquidations;
accurate venue labels (Binance Spot/Perp; HL/HIP-3 unclaimed); every
unavailable state named (NOT PROVIDED / Syncing / Stale / unreachable).
