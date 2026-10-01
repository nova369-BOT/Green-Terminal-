# Green Terminal — Agent Memory & Rules

Read this first, every session. The user is a beginner; clarity beats cleverness.

## 1. Product truth (HARD STOPs)

- **Green Terminal (GT) is the ONE product.** EdgeDepth is an INTERNAL component
  (engine + managed gateway process). Never present, instruct, or imply a
  standalone EdgeDepth app, second UI, or second launch step.
- A phase is complete ONLY when the thing renders/works **inside GT** with
  **REAL data**. Never say "done/complete/working" unless verified working.
  Never let the UI claim LIVE for a dead socket. No DEMO fallback, no fake data.

## 2. How to work

- **Plan → user approval → build.** Present the plan, wait for an explicit go
  ("go ..."). Report after each step, briefly.
- **Workspace batch rule (user, 2026-10-01):** once a plan is approved, work
  AUTONOMOUSLY in multi-file vertical batches (≥3 connected files/features),
  no approval-stops between steps, no one-file micro-commits, report briefly
  after each complete validated batch. Never mistake foundations for finished
  features — a feature is done when it is visible, wired, persisted, validated.
- **Beginner user:** short messages, plain words, one thing at a time,
  copy-paste commands. No jargon. No big dumps.
- **One bash / one edit / one pytest per turn.** No parallel pytest.
  One edit per file per turn.
- Explain fully in chat; never point at local guide files as a substitute.
- Commit + push verified work to the session branch; never leave work unpushed.

## 3. Git (strict)

- Session branch ONLY: `arena/01a0f82b-green-terminal`
  (origin: `nova369-BOT/Green-Terminal-`).
- **NEVER push `main`.** Never switch/create/push any other branch.
- `remote.origin.fetch` historically tracks only `main`; if the remote-tracking
  ref for the session branch is missing, fetch it explicitly:
  `git fetch origin 'refs/heads/arena/01a0f82b-green-terminal:refs/remotes/origin/arena/01a0f82b-green-terminal'`
- If the local branch pointer ever looks wrong (e.g. sitting on `0baa171`
  with the whole tree "untracked"), do NOT `reset --hard` (destroys uncommitted
  edits). Fetch the remote tip, then `git reset <remote-tip>` (mixed) so the
  working tree is preserved and the real diff reappears. Commit ONLY intended
  files (never blanket `git add -A`: the tree carries unrelated leftovers).

## 4. Architecture facts (do not re-derive)

- One image: `lset` + `bin/edgedepth-gateway` + WASM (`Dockerfile`,
  `docker-compose.yml`, `.dockerignore`). Compose publishes **7787** (UI) and
  **18791** (gateway WS). `platform: linux/amd64`. Gateway env:
  `EDGEDEPTH_ADDR=:port`, `EDGEDEPTH_HOST`, `EDGEDEPTH_PORT`, `HL_REST`, `HL_WS`.
- Order Flow = GT shell (`lse_terminal/ui/static/app.js` → `#of-frame` iframe
  → `/edgedepth/index.html?exchange=hl&symbol=BTC`) + managed gateway + WASM.
- Gateway venues: **HL-only for now** (`hl` = Hyperliquid perps). The Binance
  adapter stays in the tree UNREGISTERED (`internal/binance`) — re-adding it is
  one line in `cmd/edgedepth-gateway/main.go`. HL symbols are UPPERCASE end to
  end ("BTC"). Known honest gap: Hyperliquid publishes no public liquidation
  feed → liquidation timeline stays empty on hl.
- Whole-app cross-origin isolation is REQUIRED (COOP `same-origin` + COEP
  `credentialless` on every response in `server.py`): the WASM engine needs
  SharedArrayBuffer inside its iframe, which only works when the parent tree is
  isolated too. Never scope these headers back to `/edgedepth` only.
- Gateway child process inherits container stdout/stderr (visible in
  `docker compose logs`) — never DEVNULL them again.
- `#of-frame` stays mounted when leaving ORDER FLOW (warm WS/book, instant
  return). Never clear its `src` on navigation.
- `no-store` cache headers ride every response (kills "old UI after update").
- CI (`.github/workflows/`): `build-edgedepth-gateway.yml` (gofmt/vet/test +
  linux/amd64 binary, commits back `bin/edgedepth-gateway`) and
  `build-edgedepth-wasm.yml` (~7 min Emscripten → commits back
  `lse_terminal/ui/static/edgedepth/*`, path-scoped to terminal sources).
  Both use rebase-and-retry pushes so their commit-backs never clobber.
  `gh` CLI works for runs (`gh run list|view`); sandbox `bash` has NO network
  and NO Go toolchain — GitHub Actions is the compiler.

## 5. Current state (update as it changes)

- 2026-10-01: **Direction locked: XFlow-style NATIVE WIDGET WORKSPACE** on the
  Chart page — no separate Chart/G-Flow tabs, no iframe. Widgets: Chart, DOM,
  Trades, Market Stats, Footprint, Heatmap, Volume Profile, CVD (orderbook /
  paperTrading / watchlist / replay typed but honest-unavailable). Spec:
  `design/GREEN_TERMINAL_ORDERFLOW_SPEC.md`. Backend: Binance L2 provider
  registered (`binance-depth`, BTCUSDT/ETHUSDT/BNBUSDT/SOLUSDT), sequence-safe
  depth transport (SNAPSHOT/UPDATE/DEPTH_RESET) through the market-data bus.
  **Rule 1 (real grid renderer) SHIPPED**: `NativeWidgetWorkspace` is the
  12×24 persisted grid wrapping ProChart; `WorkspacePanelFrame` chrome on
  every widget (drag, resize, S/T link toggles, minimize/maximize/close =
  persisted); ghost-commit gestures; collision-safe layout; 1/2/4/16 presets;
  single source of truth store in `lib/workspaceWidgets.ts`; live panels in
  `chart/workspaceWidgetPanels.tsx`. Legacy overlay
  (WidgetWorkspaceControls/registry/NativeWidgetPanel) deleted. Multi-chart
  grid stays full-bleed for now (merge = later item).
- Remaining list (user-approved order): link-group UI → provider/source
  selection → DOM polish → heatmap visual renderer → footprint period
  grouping → CVD sessions → volume profile sessions → Trading widget → Replay
  → advanced widgets → chart/multi-grid integration → historical backfill →
  capability/diagnostics → tests → final polish. The G-Flow `#orderflow` page
  stays until the native workspace fully replaces it (HL-only; iframe).
- 2026-09-25: Order Flow LIVE on Hyperliquid BTC inside GT (user confirmed).
  User's network blocks Binance (ISP + geo); Hyperliquid reachable.
- Rebrand approved: **Palette A — Emerald + Gold** (`#0f9d58` / `#d4af37` on
  near-black). Awaiting explicit `go colors` to build Phase A (engine tokens +
  header + GT bar). Phase B (clean default layout, de-scatter labels) follows.
  The workspace panels use the same emerald accents already.
- GT logo reference: black + graphite + lime "GT" (user-supplied); final
  direction is emerald/gold, NOT lime.
- Mockups (workspace root, NOT in git): `gt-green-mockup*.png`,
  `gt-palette-*.png`.
