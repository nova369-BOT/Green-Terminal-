# ═══════════════════════════════════════════════════════════════════════
#  GREEN TERMINAL — ORDERFLOW MASTER PLAN & BUILD RULES
#  (single source of truth — every other planning doc was deleted on purpose)
# ═══════════════════════════════════════════════════════════════════════
#  Read this top to bottom BEFORE writing any code. It contains:
#    §1 What this project is and where it is right now
#    §2 The rules (they are not negotiable)
#    §3 The G-Flow contract (what we must reach, described exactly)
#    §4 What already exists in the tree (verified inventory)
#    §5 The step-by-step build, with per-step verification
#    §6 Environment facts (sandbox vs user preview)
#    §7 Ledger
#
#  Existing .md files intentionally kept: README.md (required by
#  pyproject.toml), ui/static/guide.md (served inside the app),
#  THIRD-PARTY-NOTICES.md (legal), ui/static/edgedepth/README.md (vendored
#  G-Flow attribution). Everything else .md was removed 2026-10-02.
# ═══════════════════════════════════════════════════════════════════════


# ═════════════════════════════ §1 PROJECT STATE ═════════════════════════

  Branch (SESSION, only branch ever touched):  arena/01a0f82b-green-terminal
  Baseline:                                    3b7b6fc "version persisted
                                               workspace documents"
  Step 1 done:                                 a86fc57 + f63195a
  Everything else ever built (all sessions):   tag backup/pre-reset-0a89978
  Archive tag purpose: read-only reference. Never merge it; never revert
  to it. The dd07 restore is the sole working line.

  ┌─────────────────────────────────────────────────────────────────────┐
  │ HISTORY (why the tree looks like it does)                           │
  │   1. Old line built multi-venue fallbacks, DOM, panels, etc.        │
  │   2. Crisis: trades live, DOM "Syncing" forever (Wait-for bug).     │
  │   3. User ordered total reset → branch was force-reset to initial   │
  │      README commit → then "only all the implementations, reclone    │
  │      from dd07" → restored to 3b7b6fc (dd07 tip).                   │
  │   4. User: build orderflow STEP BY STEP, everything verified.       │
  │   5. Step 1 landed (below). We are here ▶ STEP 2.                   │
  └─────────────────────────────────────────────────────────────────────┘

  Product goal (user, verbatim, condensed): a native React order-flow that
  behaves like the G-Flow desktop terminal, inside Green Terminal — Chart,
  DOM, Trades, Orderbook, Market stats, Footprint layers, Heatmap layers,
  Watchlist — with honest states and live speed. We rebuild it step by
  step, each step verified, never all at once.


# ═════════════════════════════ §2 THE RULES ═════════════════════════════

  These come from AGENTS.md (now merged here) and the user's standing
  instructions across sessions. Treat them as compile errors.

  ┌── R1. ACCURACY LAW (absolute ─ never break) ─────────────────────────┐
  │  • Verified provider frames only. NEVER fabricate, infer, or        │
  │    estimate: depth, trades, CVD, footprint, heatmap, liquidations,  │
  │    any value.                                                       │
  │  • Aggressor side = the provider's flag. Never from price movement. │
  │  • Where data is absent: show an HONEST state — "Waiting",          │
  │    "Syncing", "Offline <reason>", "DEPTH_RESET: <reason>". A state  │
  │    message must carry its reason whenever there is one.             │
  │  • Labels must be accurate: which venue, which product/reach            │
  │    (e.g. "Binance L2", "HL Perp", "demo", "replay").                │
  │  • Never render stale/synthetic/interpolated levels as if live.     │
  └────────────────────────────────────────────────────────────────────┘

  ┌── R2. WORKFLOW / BATCH RULE ─────────────────────────────────────────┐
  │  • One step at a time. Inside a step: ≥3 connected implementations   │
  │    done vertically (lib + renderer + wiring + tests), then ONE      │
  │    build+typecheck+tests pass, ONE commit, ONE push, ONE report.    │
  │  • No micro-commits. No "foundation" counting: a helper only counts │
  │    once it is visibly wired into the UI and seen working.           │
  │  • Report format per step: brief, but ALWAYS include concrete       │
  │    detail of what was implemented (files + behavior), and what the  │
  │    user should see in the preview.                                  │
  │  • Finish the current step fully before starting the next.          │
  └────────────────────────────────────────────────────────────────────┘

  ┌── R3. GIT ───────────────────────────────────────────────────────────┐
  │  • Work ONLY on arena/01a0f82b-green-terminal. Never main. Never    │
  │    create/switch/push another branch (force-push only our branch).  │
  │  • Commit trailer: Co-authored-by: arena-agent                       │
  │    <297053741+arena-agent@users.noreply.github.com>                 │
  │  • NO blanket `git add -A` / `git add .`. Add files by name.        │
  │  • Pointer wrong (local behind remote unexpectedly) →               │
  │    `git reset --mixed <remote-tip>`. NEVER --hard.                  │
  │  • Generated artifacts and big datasets stay out of Git (follow     │
  │    repo .gitignore; third_party assets already excluded).           │
  └────────────────────────────────────────────────────────────────────┘

  ┌── R4. PRODUCT / QUALITY ─────────────────────────────────────────────┐
  │  • ONE product: Green Terminal. G-Flow is a CONTRACT (behavior/UI   │
  │    reference) — do NOT build a second UI/trailer alongside.         │
  │  • Professional, advanced quality. Every function written to avoid  │
  │    bugs, not to look done.                                          │
  │  • Keep ALL existing chart features working (candles, Heikin Ashi,  │
  │    Line, Renko, drawings, indicators, settings, timeframes,         │
  │    crosshair). Nothing existing may regress.                        │
  │  • Default pair = BTC/USD. Default workspace = Chart + DOM +        │
  │    Trades. DOM and Trades stay SEPARATE widgets.                    │
  │  • Sandbox has: no exchange network, no docker, no Go. Live data    │
  │    verification happens on the user's Docker preview, not here.     │
  └────────────────────────────────────────────────────────────────────┘

  ┌── R5. PACING (user-set) ─────────────────────────────────────────────┐
  │  • User wanted: step by step, verify as we move (not autonomous     │
  │    sprint with no checks). Build the full step, verify gates,       │
  │    report, and keep moving within the step plan — but a step is a   │
  │    unit: don't start Step N+1's scope inside Step N's commit.       │
  └────────────────────────────────────────────────────────────────────┘


# ═════════════════════ §3 THE G-FLOW CONTRACT (behavior to reach) ═══════

  Source of truth (read-only, in repo): third_party/edgedepth-terminal
  (official C++/WASM terminal). Vendored docs: docs/REALTIME_DEPTH.md etc.
  Screenshots the user circulated (described below) define the target UX.

  3.A WIDGET CATALOG (add-widget menu must offer, at completion)
  ┌─────────────────────────┬───────────────────────────────────────────┐
  │ Widget                  │ Definition of done                        │
  ├─────────────────────────┼───────────────────────────────────────────┤
  │ Chart                   │ exists in Green Terminal; gains layers    │
  │                         │ below. NEVER regress existing tools.      │
  │ Orderbook               │ L2 rows + running totals + Mid·Spread.    │
  │ Depth of Market (DOM)   │ centered ladder (below spec).             │
  │ Trades                  │ time & sales w/ provider-flag side +stats.│
  │ Market statistics       │ mark/bid/ask/last + 24h change + volume.  │
  │ Footprint / CVD         │ real-print buys×sells per price & delta.  │
  │ Heatmap (layer)         │ resting-depth history layer on chart.     │
  │ Volume Profile (VPVR)   │ volume-by-price side profile + POC.       │
  │ Watchlist               │ symbols + 24h change (verified tickers).  │
  │ Paper Trading (optional)│ honest fills at real top-of-book only.    │
  │ Replay (optional)       │ record live → scrub/pause/speed locally.  │
  │ Debug                   │ channel health, reset counters.           │
  └─────────────────────────┴───────────────────────────────────────────┘

  3.B DOM LADDER SPEC (from src/ui/realtime_dom_ladder + dom_widget)
  ┌──────────────────────────────────────────────────────────┐
  │  SETTINGS pane (coin grouping: Coin / 5-min volume)      │
  │  Columns: BUYS(traded) | BIDS | PRICE | ASKS | SELLS     │
  │           (traded) | DELTA                               │
  │  • Centered on mid; mid scrolls through ladder.          │
  │  • Traded size per row = trade-at-price accumulator from │
  │    real prints (provider side only).                     │
  │  • Delta highlight at top-of-book; visible fps counter.  │
  │  • Grouping selector rebuckets levels live.              │
  └──────────────────────────────────────────────────────────┘

  3.C REAL-TIME SETTINGS PANEL (the G-Flow "Real-time" menu)
      pause display · 1s observed candles · trade-price line ·
      auto-fit · follow price · recent window (e.g. 30s) ·
      trade bubbles toggle · observed liquidation diamonds ·
      liquidation activity strip · liquidation notional filter ·
      depth brightness · recalibrate bubble sizes · min trade value ·
      session history retention · live frame counters.

  3.D CHART LAYERS TOGGLE LIST (target, in fidelity order)
      liquidation heatmap · Hyperliquid liq levels · liquidation profile ·
      observed liquidations · order-book depth heatmap · trade bubbles ·
      VPVR volume profile · leverage-tier filters (25x/50x/75x/100x).
      Each layer is honesty-gated: only exists where a verified source
      exists; otherwise the layer entry states availability plainly.

  3.E RIGHT SIDEBAR (G-Flow Overview/Market/Session/Technical)
      Open/High/Low/Prev Close · Volume · Bid/Ask/Spread/Last ·
      Status · Session High/Low · Timeframe · SMA 20 · EMA 20 ·
      VWAP · RSI 14 — all from verified values only.


# ═══════════════ §4 TREE INVENTORY (verified 2026-10-02) ═══════════════

  Backend  (lse_terminal/)
  ├─ engine/server.py ............ FastAPI shell; /api/market-data/ws;
  │                               /api/edgedepth/{status,artifacts};
  │                               hosts /edgedepth G-Flow WASM runtime page.
  ├─ market_data/connection.py ... StreamHub: channels attach/subscribe,
  │                               provider links, connection states,
  │                               CONNECTED only on real data.
  ├─ engine/feeds/binance.py ..... Binance trades provider (live WS).
  ├─ engine/feeds/binance_depth_stream.py
  │                         ...... diff-depth generator with bounded
  │                               awaits (STEP 1a fix, see below) →
  │                               ORDER_BOOK_SNAPSHOT/ORDER_BOOK_UPDATE/
  │                               DEPTH_RESET.
  ├─ engine/feeds/binance_depth.py sequence-validated LocalOrderBook:
  │                               bridge rule U ≤ lastUpdateId+1 ≤ u,
  │                               then pu == prev u; DepthSequenceError
  │                               forces reset.
  └─ market_data/{bus,service}.py REST + WS surface; health endpoints.

  Frontend (frontend/src)
  ├─ mount.tsx .................. window.LSEChart bridge; React workspace.
  ├─ market-data/bus.ts ......... MarketDataBus client: stream(), subscribe
  │                               Trade/Depth; BusTrade{price,size,side?},
  │                               BusDepth events.
  ├─ lib/workspaceWidgets.ts .... 12-TYPE catalog: chart, orderbook, dom,
  │                               trades, marketStats, footprint, heatmap,
  │                               volumeProfile, cvdDelta, paperTrading,
  │                               watchlist, replay (+ preset/layout/link
  │                               ops, persistence v1).
  ├─ components/chart/WidgetWorkspaceControls.tsx
  │                         ...... THE order-flow surface: + Widget picker,
  │                               pill bar, presets 1/2/4/16, per-widget
  │                               symbol/timeframe linking. Live-mounted
  │                               panels: DOM, ORDERBOOK (Step 1), TRADES
  │                               (tape, Step 1), MARKET STATS, CVD/DELTA,
  │                               FOOTPRINT, VOLUME PROFILE, HEATMAP
  │                               (basic). Catalog-only: PAPER TRADING,
  │                               WATCHLIST, REPLAY.
  ├─ components/chart/NativeWidgetWorkspace.tsx
  │                         ...... grid frame+renderer registry (note:
  │                               nothing currently imports it — the
  │                               live path is WidgetWorkspaceControls).
  └─ lib/tape.ts (Step 1) ....... TradeTape: bounded ring of verified
                                  prints; session stats (count/VWAP/
                                  buy/sell split/OHLC anchor).

  Providers / honesty: Binance + Hyperliquid providers exist in repo;
  the management EdgeDepth gateway ships as a prebuilt binary (HL-only;
  Binance route unregistered until reachable). Please never fake-verify.

  Known inherited oddity in inventory: nothing imports
  NativeWidgetWorkspace (dead path, documented — leave alone unless a
  step concerns it).


# ═══════════════════════ §5 THE 12 STEPS (in order) ═════════════════════

  Verify per step:  (a) gates green  (b) commit+push  (c) report w/ detail
  (d) user can see it in the docker preview (Step 1 instruction: pull +
  docker compose up).

  ┌────┬─────────────────────────────────────────────────────────────────┐
  │ #  │ STEP = unit of work (files; behavior; verification notes)       │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 1 ✅│ DATA-PLANE RELIABILITY + TAPE + ORDERBOOK RENDERER (a86fc57,   │
  │    │ f63195a, ledger §7)                                             │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 2 │ G-FLOW DOM LADDER v1 — centered ladder around mid; grouping     │
  │   │ selector (Coin / 5-min volume); row cells laid out per §3.B:    │
  │   │ traded buys/bits|price|asks/sells|delta on real prints; settings│
  │   │ pane; fps counter. Contract points encoded in node tests vs     │
  │   │ third_party/edgedepth-terminal sources (traceable).             │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 3 │ DOM ACCUMULATOR + RESET PRESETS + INSTRUMENT FLUSH — full       │
  │   │ trade-at-price ring accumulation, preset reset buttons,        │
  │   │ symbol changes clear accumulators AND session tapes.            │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 4 │ REAL-TIME SETTINGS PANEL (§3.C) — as collapsible panel; each    │
  │   │ toggle live-wired to tape/DOM/heatmap/chart layers; persisted.  │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 5 │ CHART LAYER: ORDER-BOOK DEPTH HEATMAP — canvas layer behind     │
  │   │ candles from accumulated REAL book states only (bounded buffer; │
  │   │ brightness wired from §3.C).                                    │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 6 │ CHART LAYER: TRADE BUBBLES — sized from real executions via     │
  │   │ G-Flow math: r = min(24, 3 + 2·log2(1 + 8·v/ref)); recalibrate. │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 7 │ FOOTPRINT per-period columns + VPVR — bucketed buy/sell cells,  │
  │   │ imbalance shading (3:1), POC band; same real prints as tape.    │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 8 │ CVD/DELTA canvas series — cumulative line + per-period hist.    │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │ 9 │ WATCHLIST + MARKET STATS upgrade — verified 24h tickers; stats  │
  │   │ panel gains 24h change/volume; sidebar §3.E fields wired where │
  │   │ sources exist.                                                  │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │10│ REPLAY — record live JSONL; Replay Library panel: list/play/     │
  │   │ pause/speed; labels honest (recorded session, not a live feed). │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │11│ PAPER TRADING — fills at real top-of-book; honest P&L; no market │
  │   │ fabrication anywhere.                                           │
  ├────┼─────────────────────────────────────────────────────────────────┤
  │12│ LIQUIDATION LAYERS (availability-first) + DEBUG PANEL + perf     │
  │   │ pass; final ledger update.                                      │
  └────┴─────────────────────────────────────────────────────────────────┘

  CONVENTIONS new code must follow (all observed in Step 1):
  • BusTrade side stays 'buy' | 'sell' | undefined end-to-end; tape
    normalizes to null; UI shows '—' (never colored guess).
  • Widget data reset on symbol change AND on DEPTH_RESET with reason.
  • Depth events drive setDepth({ready:false}) with reset reason visible.
  • Small pure libs (lib/*.ts) carry node --experimental-strip-types
    suites (frontend/tests/*.test.mjs); pytest contracts pin python-side
    invariants. Keep both suite patterns.
  • CSS: existing style constants at file bottom, muted #71808a labels,
    green #58d797 / red #e28b91 / amber #e1a650 semantics.


# ═══════════════════════ §6 ENVIRONMENT FACTS ═══════════════════════════

  SANDBOX (this agent):
  • Python: /tmp/gt venv per session—`python3 -m venv /tmp/gt`,
    `/tmp/gt/bin/pip install -e .` (+ pytest). pip alone can't go to
    system (PEP 668). venv DOES NOT persist; rebuild each session.
  • Frontend: `cd frontend && npm ci` then `node_modules/.bin/tsc
    --noEmit`, `npm run build` (emits ../lse_terminal/ui/static/chart).
    node sticker: v22.x. test: node --experimental-strip-types
    tests/*.test.mjs.
  • Preview server (agent-side check): `/tmp/gt/bin/lset --host 0.0.0.0
    --port 7787 --no-browser` (same entry Docker uses). Check
    /api/health=ok, "/"=200, chart/chart.js=200.
  • NO docker daemon here. NO exchange network (TLS EOF on api.binance /
    api.hyperliquid): any "waiting for data" in the sandbox preview is
    expected and honest.
  • User preview = their Docker machine: `git fetch && git reset --hard
    origin/arena/01a0f82b-green-terminal` then `docker compose up
    --build` (branch was force-rewritten once; plain pull may fail).
    Their preview URL: <port>-<sandbox>.e2b.app is MY sandbox; theirs is
    localhost:7787.

  Ports (sandbox local): 7787 = app, 8080 = managed edgedepth-gateway
  ws (:18791 in container compose, published).
  COOP/COEP headers required for /edgedepth (WASM SharedArrayBuffer) —
  already configured in server.py; do not revert.


# ═══════════════════════════ §7 LEDGER ═══════════════════════════════════

  2026-10-02  Reset+restore complete; branch = 3b7b6fc (+ nothing else).
  2026-10-02  STEP 1 ✅  a86fc57 — tape backbone (lib/tape.ts + 7 node
              tests) · Trades panel: time/price/size/SIDE rows with
              side tint + sticky session footer (prints·VWAP·B/S) ·
              ORDERBOOK renderer (bid/ask rows + running totals + Mid·
              Spread footer; validated depth state only) · DOM ask-side
              fix (asks were read worst-first — reshaped best-ask-asc
              from validated ordering; discovered via applyDepth: both
              sides stored price-desc).
             f63195a — 1a: depth stream bounded awaits committed with
              attribution correction (NOT in 3b7b6fc; uncommitted remnant
              of the cancelled crisis batch): connect open_timeout=10 ·
              per-frame recv wait_for 25s (buffered) / 30s (steady) ·
              snapshot task hard wait_for 30s + cancel() on timeout ·
              self-named TimeoutError → DEPTH_RESET + growing backoff ·
              reset reason never blank (str(exc) or class name).
              pytest stream+book suites: 7 passed. tsc clean · vite
              4,704.02 kB (gzip 1,356.03) · preview green.
  ────────────────────────────────────────────────────────────────────
  NEXT: STEP 2 (G-Flow DOM ladder v1). Gate = tests + report; affected
  files: components/chart/WidgetWorkspaceControls.tsx, new lib/domLadder.ts
  + tests/domLadder.test.mjs, per contract in §3.B.
```

Wait — the user wants me to delete every .md file EXCEPT our plan and replace it with this. Let me now delete the files. I already checked: README.md is referenced by pyproject.toml (must keep). guide.md is served in-app (must keep). THIRD-PARTY-NOTICES.md is legal. ui/static/edgedepth/README.md is vendored attribution. The user said "cancel every .md file except our plan" — my keep-list note is inside the header comment of the plan doc itself, honest.

Files to delete:
- AGENTS.md, DRAWING_SUITE_DIFF.md, ORDERFLOW_REBUILD_PLAN.md, PHASE1*.md, PHASE2*, PHASE3*(3), PHASE4, THIRD-PARTY-NOTICES.md? — user said every .md except plan. Legal notices... I'm keeping them per my header note (legal requirement). Actually user is the owner. But THIRD-PARTY-NOTICES.md is genuinely for license compliance. I'll keep it AND tell the user why. Same for README.md (build dep) and guide.md (app content) and the vendored one (license attribution of G-Flow).
- docs/releases/*.md (4 files)
- design/*.md except ORDERFLOW_STEPBYSTEP.md (BATCH_PLAN.md, GFLOW_CHART_INTEGRATION_PLAN.md, GFLOW_UNIFIED_MASTER_PLAN.md, GREEN_TERMINAL_ORDERFLOW_SPEC.md)

Also the DESIGN_RECOVERY... was already deleted.

One consideration: AGENTS.md — it defines the agent rules (including the "AI trailer" rule, session-branch rule). The Co-authored-by trailer was in AGENTS.md. I've folded those rules into the new plan doc. Deleting AGENTS.md: the user explicitly asked "cancel every .md file except our plan for orderflow". So yes, delete it too — the rules live in the plan now.

Let me write the file, delete the others, commit, push, report. The file I just drafted has a syntax issue at the end (a stray code fence ```!). Let me rewrite cleanly without trailing fence.