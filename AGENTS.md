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
- **Beginner user:** short messages, plain words, one thing at a time,
  copy-paste commands. No jargon. No big dumps.
- **One bash / one edit / one pytest per turn.** No parallel pytest.
  One edit per file per turn.
- Explain fully in chat; never point at local guide files as a substitute.
- Commit + push verified work to the session branch; never leave work unpushed.

## 3. Git (strict)

- Session branch ONLY: `arena/01a0caa0-green-terminal`
  (origin: `nova369-BOT/Green-Terminal-`).
- **NEVER push `main`.** Never switch/create/push any other branch.
- `remote.origin.fetch` historically tracks only `main`; if the remote-tracking
  ref for the session branch is missing, fetch it explicitly:
  `git fetch origin 'refs/heads/arena/01a0caa0-green-terminal:refs/remotes/origin/arena/01a0caa0-green-terminal'`
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

- 2026-09-25: Order Flow LIVE on Hyperliquid BTC inside GT (user confirmed).
  User's network blocks Binance (ISP + geo); Hyperliquid reachable.
- Rebrand approved: **Palette A — Emerald + Gold** (`#0f9d58` / `#d4af37` on
  near-black). Awaiting explicit `go colors` to build Phase A (engine tokens +
  header + GT bar). Phase B (clean default layout, de-scatter labels) follows.
- GT logo reference: black + graphite + lime "GT" (user-supplied); final
  direction is emerald/gold, NOT lime.
- Mockups (workspace root, NOT in git): `gt-green-mockup*.png`,
  `gt-palette-*.png`.

## 6. MANDATORY DESIGN PROPOSAL & APPROVAL RULE (user decree 2026-10-03 — overrides normal implementation workflow)

NO visual, layout, UX, navigation, or structural UI change may be implemented
without the user's explicit prior approval. Permanent workflow for every major
UI/UX change:

INSPECT → THINK → RECOMMEND → VISUALIZE → EXPLAIN → ASK FOR APPROVAL → WAIT
→ IMPLEMENT → TEST → SHOW RESULT → ASK WHAT AREA IS NEXT.

1. INSPECT first: current GT + EdgeDepth UI, layout, components, data flow,
   styling, design language. Never guess.
2. THINK and state "WHAT I THINK SHOULD BE DONE": what is wrong, why change,
   proposed solution, what stays unchanged, affected components, visual goal,
   risks/trade-offs. Be specific.
3. SHOW the proposed design BEFORE implementing: mockup / high-fidelity image /
   wireframe / before-after visual that represents the ACTUAL proposed GT
   change (not a lookalike reference). Use a real current screenshot as the
   CURRENT side when available.
4. STOP at the approval gate. Do not edit files, CSS, layout, or components
   until the user explicitly approves. Ask: "Do you approve this direction,
   or would you like me to change anything before implementation?" Then WAIT.
5. Approval = implement THAT EXACT direction, nothing extra. Significant
   deviations discovered mid-implementation must be explained first.
6. Rejection = do not implement; ask what to change or propose a revision;
   repeat the loop.
7. Multiple legitimate approaches → show the options (visuals where practical),
   explain differences, let the USER choose.
8. Approval is never a formality: no "propose, code immediately, ask later".
9. Functionality changes: state WHAT CHANGES / WHAT STAYS / WHAT MAY BE
   AFFECTED / HOW TESTED. Pure UI changes must say "UI-only, functionality
   untouched."
10. No surprise redesigns beyond approved scope; one approval ≠ license to
    touch unrelated areas.
11. Keep one coherent design direction; every proposal honors previously
    approved decisions.
12. Agent must give MY RECOMMENDATION (an opinion) but the user decides.
13. Professionalism check before presenting (density, hierarchy, readability,
    alignment, consistency, trading usability, GT identity).
14. Never present a design that cannot actually be implemented in this repo;
    flag conceptual elements explicitly.
15. After implementation: show result, compare against approved design, report
    deviations, then ASK what area is next — never auto-continue redesigning.
