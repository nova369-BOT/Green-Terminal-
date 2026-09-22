# GREEN TERMINAL

**Chart analysis, strategy automation, and execution — one terminal.**

`GREEN TERMINAL` is a single-screen trading workstation: a canvas chart engine, a
declarative automation DSL, a vectorized backtester with honest robustness stats, and a
paper broker with a hard risk overlay — all in one zero-dependency web app.

```
┌──────────┬──────────────────────────────────┬───────────┐
│ markets  │  chart: candles · overlays ·     │ ticket    │
│ + sparks │  panes · price lines ·           │ automate  │
│          │  automation overlays             │ risk      │
│          ├──────────────────────────────────┤ account   │
│          │  engine log (why it did things)  │ research  │
└──────────┴──────────────────────────────────┴───────────┘
```

> **Paper environment.** Simulated market data, simulated fills, simulated money.
> Nothing here connects to a venue. The `rest` provider seam in
> `src/modules/feed.js` is where a real gateway would attach.

---

## Quick start

```bash
npm start          # http://localhost:3000  (binds 0.0.0.0)
```

No build step. The app is authored as native ES modules served directly — what you
read in `src/` is exactly what runs.

### Keyboard

| Key | Action |
| --- | --- |
| `1…6` | timeframe 1m → 1D |
| `+ / −`, wheel | zoom the chart |
| `[ ]` / arrows | pan bars (`←/→` + modifier switches symbol) |
| `R` | reset view |
| `K` | kill switch (flatten + halt automation) |
| `Space` | pause / resume the feed |
| `/` | jump to the watchlist filter |
| Alt-click a price line | remove it; drag in the gutter creates levels |

Time compression lives in the top bar: **1×** realtime, **1m/s**, **10m/s**.

---

## What's inside

### `src/modules` — the engine (pure, testable, UI-free)

| Module | Responsibility |
| --- | --- |
| `sim.js` | Deterministic market simulator: GARCH-style vol clustering, bounded regime drift, OU anchor, fat tails. Seeded → reproducible. `SIM_EPOCH` pins history so backtests don't drift with wall-clock. |
| `feed.js` | The only timer in the app. Emits `tick` / `bar` / `clock` / `status`. Closed-bar events are keyed on the simulator's own clock, so strategies can't double-fire under time compression. The `provider:'rest'` seam is the real-feed attachment point. |
| `indicators.js` | EMA/SMA/RSI(Wilder)/MACD/ATR(Wilder)/Bollinger/VWAP(session-anchored)/Stoch/ROC/Donchian. NaN warmups, canonical series keys. |
| `rule.js` | The automation DSL: a JSON rule tree (`and/or/not`, comparisons, `cross_above/below/between`, operands: price field / indicator / number / context var / lag). No `eval` — importable strategies are validation-safe and portable to a server. |
| `sizing.js` | **One** pure sizing core (`riskBudget` / `equityPct` / `fixedQty`), shared by backtest *and* live broker — same fee, slippage, lot-grid, gross-cap rules on both sides. |
| `broker.js` | Paper broker: fills, blotter, mark-to-market, hard stops, trailing-stop lifecycle, kill switch, daily-loss halt. Risk parameters are enforced **after** every strategy decision — a buggy strategy cannot exceed them. |
| `backtest.js` | Next-open fills, stop-before-target pessimism, gap-through handling, fees on every leg. Metrics: Sharpe/Sortino/PF/expectancy(R)/exposure + **Monte Carlo**, **anchored walk-forward with a real param search**, **parameter sensitivity** — robustness next to performance, always. |
| `engine.js` | Automation runtime: evaluates each deployed strategy exactly once per closed bar (keyed on bar timestamp), `shadow` (log-only) / `armed` / `off` modes, append-only decision log incl. refusals, persistence to `localStorage`. |
| `presets.js` | Six strategy templates — each shipped with **its failure mode** written next to it. |
| `store.js`, `fmt.js` | Observable app state; number formatting (UTC everywhere, tick-accurate prices). |

### `src/ui` — the terminal

- **`chart.js`** — hand-rolled canvas (~700 lines, no charting library): candles,
  volume/RSI/MACD panes, overlay series, crosshair legend, wheel zoom, drag pan,
  draggable price levels, position/stop/target lines, fill markers, live-pulse candle.
- **`automation.js`** — the workbench: condition-group builder (ANY-of / ALL-of with
  operand editors), JSON editor for full-fidelity rules, preset library, one-click
  backtest → metrics grid → equity curve vs buy&-hold → Monte Carlo / walk-forward /
  sensitivity tables → verdict banner → deploy (shadow first; **armed deploys are
  refused when the verdict says "no edge"**).
- **`trade.js` / `positions.js` / `account.js` / `watchlist.js` / `console.js` /
  `topbar.js` / `dock.js` / `h.js`** — ticket with live sizing preview (R:R, fees,
  risk-to-stop), risk cards with R-meters, editable risk overlay, blotter, engine log
  with filters.

### Data & execution topology

```
simulator (seeded) ──► feed.js ──┬──► chart (closed bars only)
                 provider:'rest' ┘──► engine ──► sizing.js ──► broker (risk overlay) ──► blotter
                                              └── backtest.js (same sizing, same fills)
```

Strategies only ever see **closed** bars. The backtester and the live path share one
sizing/fill implementation — that is what makes backtest numbers mean something.

---

## Tests

```bash
npm test              # engine suite (46 checks) + jsdom UI smoke (34 checks)
npm run test:engine   # sim → indicators → DSL → sizing → broker → backtest
npm run test:ui       # boots the real terminal in jsdom, drives interactions
npm run check         # syntax sweep
npm run calibrate     # dev-only: re-runs the preset parameter search
```

What the engine suite actually pins down (a sample):

- same seed → same price path; OHLC invariants over 90 days of 1-minute bars
- signals evaluated on close, filled at next open (`entryBar > signalBar`, always)
- stop losses never exceed any plausible bracket; trailing stops may book gains —
  but only when the trail ratcheted past entry
- `riskBudget` sizing plans ≈ the stated % of equity **and the placed stop is the stop
  it sized against** (the silent 5×-risk bug this rule caught during development)
- equity curves have no zero-holes; Sharpe sign agrees with returns
- backtests are byte-identical across runs (pinned `SIM_EPOCH`)
- kill switch blocks new risk; daily-loss limit flattens and halts
- every preset validates, backtests, and reports finite metrics

`jsdom` is a **devDependency only** — the application itself ships with zero runtime
dependencies.

---

## Honest disclaimers

1. **Simulated data.** The market generator is designed to be *plausible* (fat tails,
   vol clustering, intraday seasonality), not to replicate any real venue.
2. **Presets are calibrated on this simulator**, in-sample, via `npm run calibrate`.
   They exist to demonstrate the toolchain end-to-end — treat them as templates, not
   signals. The walk-forward and sensitivity tables are there precisely so you can
   see how much of a backtest is real.
3. **Paper only.** No live order path exists in this codebase, by design.

---

## Roadmap

- [ ] Real market data: `feed.js` `provider:'rest'` adapter (WS bars + REST history)
- [ ] Server-side rule evaluator mirroring `rule.js` (same DSL, same fills, Rust/Go)
- [ ] Strategy sharing: import/export JSON, versioning, signed presets
- [ ] Options/futures margin model in `sizing.js` (leveraged instruments)
- [ ] Alert routing (webhook/email) alongside the on-screen console
- [ ] Portfolio-level risk: correlated exposure limits, sector buckets

---

MIT-style usage for the code; the brand is green, the risk overlay is greener.
