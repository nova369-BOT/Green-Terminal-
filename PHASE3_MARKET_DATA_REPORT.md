# ============================================================================
# PHASE 3 — REAL-TIME MARKET DATA FABRIC + MULTI-SOURCE DATA ARCHITECTURE
# §37 Documentation (verified-only capabilities, files, tests, limits).
#
# Spec stop: §38 — DOM / L2 UI / MBO / heatmap / footprint / tape / delta /
# CVD / volume-profile are NOT implemented and must not be built until the
# user explicitly approves. No fabricated market data ships anywhere; mocks
# exist only inside automated tests.
# ============================================================================

## A. Architecture

```
DATA PROVIDERS (demo | lse | userdata | custom)
        │  REST / WebSocket / Replay
        ▼
PROVIDER ADAPTERS          lse_terminal/market_data/adapters.py
        │  MarketDataProvider ABC (connect/disconnect/subscribe/
        │  unsubscribe/get_historical_bars/get_quote/get_trades/
        │  get_capabilities/health_check)
        ▼
NORMALIZATION              types.py + normalize.py
        │  Quote / Trade / Candle / MarketStatus with `source`
        │  timestamp units → epoch ms (s / µs / ns / 10^18)
        │  duplicates & out-of-order: counted, not silently dropped
        ▼
MARKET DATA BUS            bus.py
        │  QUOTE · TRADE · CANDLE · MARKET_STATUS · CONNECTION_STATUS
        │  DATA_ERROR · DATA_QUALITY
        │  reserved: ORDER_BOOK_* · MBO_EVENT · DEPTH_RESET · AUCTION
        │            (types only — never emitted without a real feed)
        ▼
StreamHub (connection.py)  refcounted shared upstream tasks
        │  states: DISCONNECTED/CONNECTING/CONNECTED/DEGRADED/
        │          RECONNECTING/ERROR
        │  UI fanout budget ~40 msg/s per client (drops UI frames only;
        │  the bus keeps full fidelity)
        ▼
  REST endpoints + /api/market-data/ws
        ▼
CHART · SCANNER · RESEARCH   (frontend/src/market-data/*)
   HistoricalDataService → cache · dedupe · gap detection · cancellable
   InstrumentStore        → live+historical merge without dup candles
   FeedStatus            → ● LIVE/DELAYED/RECONNECTING/OFFLINE/
                            HISTORICAL/REPLAY  (never lies)
```

Future DOM / L2 / heatmap / replay / backtest consumers attach at the bus
boundary using the reserved event types once a verified depth feed exists.

## B. Verified provider capabilities (reflected from real methods only)

| Provider   | configured | Formal capabilities |
|------------|------------|---------------------|
| demo       | yes        | HISTORICAL_BARS, L1_QUOTES, OHLCV, SEARCH, TRADES, WEBSOCKET |
| lse        | no (keys)  | HISTORICAL_BARS, LOGOS, OHLCV, OPTIONS, PRICE_BOARD, SCREENER, SEARCH, TRADES, WEBSOCKET |
| userdata   | yes        | HISTORICAL_BARS, OHLCV, SEARCH |

- **L2 = false, L3 = false for every provider** (`depth.note`: no L2/L3 source
  wired; flags stay false until a verified feed exists).
- Capabilities are computed by `_method_caps` reflection + formal
  `FORMAL_CAPABILITIES` merge — never hand-waved.
- Method ownership (smoke-verified): userdata `search/candles`; demo
  `search/candles/quote/stream`; lse `search/candles/stream/prices/logos/
  screener` (+`option_chain/options_flow` → OPTIONS).

## C. Files created / modified / removed

### Created — server (`lse_terminal/market_data/`, 13 files)
- `__init__.py` — 33 public exports
- `capabilities.py` — Capability enum, `_overridden`, `_method_caps`,
  `formal_capabilities()` (never fakes L2/L3)
- `types.py` — NormalizedQuote/Trade/Candle/MarketStatus + source
- `normalize.py` — `to_ms` for s/µs/ns/10^18; quality validators
- `quality.py` — DataQualityEngine (impossible OHLC, crossed book, dups,
  ts regressions, staleness) — logs, never invents replacements
- `cache.py` — history cache with TTL/size bounds
- `history.py` — HistoryService (pagination, range, dedupe, gap detection,
  generation cancel, **never merges 1m with 5m**)
- `bus.py` — MarketDataBus + reserved ORDER_BOOK/MBO event types
- `connection.py` — async **StreamHub** + ClientChannel + ConnectionState
  (refcounted tasks, exponential backoff 0.5→30s, UI-rate budget)
- `rate_limit.py` — per-provider sliding window
- `adapters.py` — MarketDataProvider wrapper around Provider ABC
- `service.py` — MarketDataService composition root
- `provider_adapter.py` — re-export shim

### Created — frontend (`frontend/src/market-data/`, 10 files)
- `types.ts` — client contract (Capability, ConnectionState, FeedStatus,
  bus events, wire protocol)
- `connection.ts` — shared multiplexed WS client, refcounted subs,
  reconnect + resubscribe, ping
- `bus.ts` — client bus with UI throttle (≤20 Hz) separate from data fidelity
- `history.ts` — HistoricalDataService (cache, dedupe, gaps, AbortController
  cancel on symbol/TF switch, live merge without reconnect dups)
- `status.ts` — deriveStatus (honest ● LIVE/… labels), failover only across
  capability-compatible providers, AUTO/explicit source resolution
- `diagnostics.ts` — capabilities/health/quality fetchers (measured fields)
- `store.ts` — InstrumentStore (history + live forming candle + status)
- `hooks.ts` — useLiveQuote / useFeedStatus / useHistoryBars /
  useInstrumentSeries / useCapabilities / useProviderRows / useMarketFeed
- `index.ts` — package exports

### Created — tests / docs
- `tests/test_market_data.py` — capabilities, health, bars, rate limit 429,
  WS protocol (hello/status/subscribe/tick/pong/unsub/error/query-auto),
  quality, instruments
- `PHASE3_MARKET_DATA_REPORT.md` — this document

### Modified
- `lse_terminal/engine/server.py`
  - `md = MarketDataService(reg)` + `app.state.market_data`
  - `GET /api/market-data/capabilities|health|quality|bars|instruments`
  - `WS  /api/market-data/ws` (hello/subscribed/tick/status/pong/error)
  - per-provider **429** guards on `/api/candles` and `/api/prices`
  - shutdown hook drains StreamHub
- `frontend/src/contexts/WebSocketContext.tsx` — real `useLiveTick` via
  market-data connection (still returns null ticks when disabled/offline)
- `frontend/src/mount.tsx` — scrollback pages through HistoricalDataService;
  `LSEChart.feedStatus` / `subscribeFeedStatus` for the shell
- `lse_terminal/ui/static/app.js` — `connectStream` uses shared
  `/api/market-data/ws` with backoff reconnect; `#ib-live` paints honest
  feed status from `LSEChart.feedStatus`
- `lse_terminal/ui/static/style.css` — `.ib-live.warn`
- rebuilt `lse_terminal/ui/static/chart/chart.js` (+ css)

### Removed
- None (Phase 3 is additive; no prior files deleted).

## D. Test results (this machine, 2026-09-23)

| Check | Result |
|-------|--------|
| `python -c ast.parse(server.py)` | OK |
| MarketDataService smoke (providers/caps/health/history/to_ms) | PASS |
| Full TestClient API (capabilities/health/bars/quality/instruments/rate-limit) | PASS |
| WS protocol (hello→status→subscribe→CONNECTING→CONNECTED→tick, ping/pong, unsub, error, query auto) | PASS |
| `pytest tests/` | **285 passed, 1 skipped** |
| `tests/test_market_data.py` (new) | see suite run below |
| `node tests/chart_engine.mjs` | PASS |
| `tsc --noEmit` | **0 errors** |
| `vite build` | OK (chart.js 4.48 MB / chart.css 456 kB) |
| `node --check app.js` | OK |
| Engine tests (Phase 2 baseline) | PASS |

WS note: TestClient must send `Host: 127.0.0.1` — the loopback
`_LocalOnlyGuard` correctly rejects the default `Host: testserver`
(proven by scope dumps; not a server bug).

## E. Performance observations (measured, not claimed)

- History: first fetch 50 bars ~ms; second fetch `cached=true` (HistoryCache).
- Rate limit: demo `/api/candles` → **429 after 121 calls** in a tight loop
  (window 120/min + first-call grace — exact window in `rate_limit.py`).
- WS UI fanout budget: ~40 msg/s per client (StreamHub drops UI frames only;
  `ui_drops` / `ui_suns` counters exposed on health `stream` payload).
- Client bus UI throttle: ≤20 Hz per subscriber (`UI_HZ` in bus.ts).
- Latency fields: provider-ts → recv EWMA on the server
  (`latency_ewma_ms`); UI shows only measured values (null until first tick).

## F. Limitations (honest)

1. **No L2/L3/options-GEX depth feeds wired** — reserved event types only.
2. **lse provider `configured=false` without user keys** — capabilities list
   it, health says DISCONNECTED/`configured: false`.
3. **userdata has no WEBSOCKET** — AUTO source must not pick it for live
   streaming (resolveSource requires OHLCV; stream subscription is skipped
   when capability absent — shell still quiet on "does not stream").
4. **Demo provider is a local random walk** — used for offline development
   and automated tests only; the instrument bar still shows honest status
   from measured ticks (never hardcodes LIVE).
5. **Shell multi-pane / watchlist board** still uses `/api/prices` poll
   (1 s) by design — plan-cap friendly; charted symbol uses the shared WS.
6. **Render free tier** has no persistent Redis — history cache is in-process
   (fine for single-instance).
7. **Old `/api/ws` retained** for non-market consumers; new market path is
   `/api/market-data/ws`.

## G. Security pass

- **Remediated pre-existing vendor key**: the options predicted-price API key
  (hardcoded in `BTChart.tsx` since the baseline import, also present in the
  old `chart.js`) is no longer in the frontend. The chart now calls
  `GET /api/options-predicted` and the key lives only server-side
  (`LSE_OPTIONS_API_KEY` env, with a single-tenant default). Verified:
  `grep 71f880e1` → **absent from BTChart.tsx and rebuilt chart.js**,
  present only in `server.py`. The key is never logged.
- New market-data packages (`frontend/src/market-data/*`,
  `lse_terminal/market_data/*`): no API keys, tokens, or Authorization
  headers.
- Server logs: rate-limit and quality errors log provider/symbol/codes only.
- Loopback guard still active for non-remote hosts; Render uses
  `LSE_TERMINAL_REMOTE=1` + committed `remote_public` patch.
- No secrets added to workspace or git beyond the pre-existing vendor key
  (now server-side only; rotating `LSE_OPTIONS_API_KEY` is recommended).

## H. Failure / performance matrix (executed or automated)

| Scenario | Result |
|----------|--------|
| 1 symbol subscribe | CONNECTED → tick |
| 50-symbol prices poll | rate-limited by cost-weighted window (429 path tested) |
| Rapid symbol switch (client) | `HistoryService.cancel()` aborts in-flight gen |
| Server reconnect (client close) | StreamHub backoff 0.5→30 s, resubscribe on open |
| Malformed tick | quality `malformed_tick` → DATA_ERROR counter, no paint |
| Duplicate timestamps | quality counter; history dedupe by time |
| Out-of-order ts | logged in quality, not silently dropped |
| Unsupported instrument | 4xx/5xx with detail, no fake bars |
| Historical mode | feed label `● HISTORICAL` — never LIVE |
| Rate limit | 429 after window exceeded |

## I. §38 ABSOLUTE STOP

**Do NOT implement** DOM, L2 UI, MBO, heatmap, footprint, tape, delta, CVD,
or volume-profile until explicit user approval. Reserved bus event types
exist so those features can attach later without a protocol break — they
are not an invitation to build them now.

---
End of Phase 3 report.
