# GREEN TERMINAL — COMPLETE AGENT HANDOFF

This document passes EVERYTHING — mission, rules, history, mistakes, technical
map, environment, and open work — to the next agent. Read all of it before
touching a single line. The owner (the user) is the product designer; you are
the builder. AGENTS.md in the repo root is binding too; this file adds the
full story and the Real-time saga that AGENTS.md does not cover.

---

## 1. THE MISSION

Green Terminal (GT) is ONE product: a professional trading terminal.

- The **LSE chart** (the main chart in the shell) is the primary chart. It is
  never replaced. Its improvements are protected.
- **G-Flow** is the user-facing name of the embedded order-flow engine. It is
  the vendored EdgeDepth terminal (C++ → WASM, ImGui/WebGL) living in
  `third_party/edgedepth-terminal/`, served in an iframe dock. NEVER say
  "EdgeDepth" in the UI — internally fine, user-facing it is G-Flow.
- The destination benchmark is the XFlow video (conclusions preserved in
  `docs/VIDEO_REFERENCE_7oGfQw9rK30.md`): live depth heatmap, trade bubbles,
  DOM ladder, liquidations — a real order-flow terminal.
- **THE PORTING PROGRAM (standing decree):** port G-Flow chart features to the
  LSE chart ONE BY ONE, as-is, deduplicating anything the LSE chart already
  has. Each ported feature is previewed to the user step by step before moving
  on. (Exception learned the hard way: Real-time was NOT ported — see §4.)

## 2. THE USER (read carefully — this shapes every reply)

- Beginner. Windows. OLD PowerShell — `&&` does not work. EVERY command on its
  own line, copy-pasteable, no markdown that mangles URLs.
- Runs GT via Docker in `C:\Users\HP\gt-01`. Compose mounts the repo read-only
  into the container, so updates are exactly:
  ```
  git pull
  ```
  ```
  docker compose restart
  ```
  (No rebuild needed unless Dockerfile/Python deps change — then
  `docker compose up -d --build`.)
- Located in Nigeria. The ISP blocks Binance and Bybit (NCC order, Feb 2024,
  still active). Hyperliquid WORKS on their machine. So: their dead
  Binance/Bybit feeds are an ISP issue, not a bug; HL is the live venue for
  them. A VPN note is already shown in the UI's honest-state text.
- Communication: SHORT, PLAIN messages. Always show a REAL screenshot of what
  you built (rendered from the actual code — never a mockup unless asked).
  Never blame the user ("did you refresh?") — go to the code first; assume the
  bug is yours. They get (rightly) angry when scope creeps, when things are
  removed without permission, and when you guess instead of verifying.

## 3. ABSOLUTE RULES (violating any of these has already caused blowups)

1. **REMOVE NOTHING from EdgeDepth. SIMPLIFY NOTHING.** The vendored engine
   must keep functioning exactly like upstream ("i want it to function exactly
   as the one in that repo"). Embed-only behavior differences must be gated on
   URL flags (`?rt=0`, `?watchlist=0`) so standalone boots are untouched.
   User-approved exceptions so far: dock watchlist hidden (?watchlist=0), dock
   Real-time PILL hidden (?rt=0 — the pill ONLY; the RT code/display stays
   fully functional).
2. **No product/design decisions on the user's behalf.** Mandatory
   design-proposal rule (AGENTS.md §6): propose, show, get approval BEFORE
   building UI. The user is the product designer.
3. **No fake anything.** No fake data, placeholder charts, hardcoded values,
   demo fallbacks, or UI that claims LIVE on a dead socket. Honest states
   everywhere ("Waiting for real-time depth…", "GT SERVER CANNOT REACH …",
   em-dashes for unknown values). Never suppress errors or weaken tests.
4. **Engine is the single source of truth.** No duplicate data connections, no
   duplicate chart state. One truth for symbol/timeframe/viewport/crosshair.
   Host UI must paint state read back FROM the engine, never assumed.
5. **Do not reimplement EdgeDepth features in React/JS for convenience.** This
   was tried (the "React RT takeover") and REJECTED. Bridge to the engine
   instead (§5).
6. **Market-data integrity:** broker candles NEVER come from crypto venues;
   flow/depth comes from crypto venues only (Binance → HL fallback; Bybit also
   wired); non-crypto symbols are honestly flow-less; when the provider gives
   an aggressor side flag, USE it — never derive side from price movement;
   symbol change fully resets order-flow state; HL symbols UPPERCASE; HL has
   no public liquidation feed.
7. **Git discipline:** work ONLY on branch `arena/01a0fd01-green-terminal`
   (session-fixed). Intentional `git add` of named files only. Inspect
   status+diff before committing. No generated artifacts in commits EXCEPT the
   repo-convention ones: CI's WASM commit-backs and the built
   `lse_terminal/ui/static/chart/chart.js` bundle.
8. **Verification:** never say "done" without verifying against the REAL app —
   headless-Chromium screenshot proof committed to `docs/`. Never claim
   live-exchange verification from a sandbox that cannot reach exchanges (this
   one cannot — say so honestly; on the user's machine HL connects).
9. **No side quests.** Unrequested changes get rejected even when "correct"
   (a demo price-anchoring fix and an "RT→WASM" chip rename were both ordered
   reverted). Ask first.
10. Whole-app COOP/COEP (credentialless) — the engine's WASM threads need
    SharedArrayBuffer; `#of-frame` stays mounted at all times; never DEVNULL
    the gateway child's output.

## 4. THE REAL-TIME SAGA (the most important history — 3 rejected attempts)

The user wanted G-Flow's Real-time view reachable from the GT toolbar.

- **Attempt 1 — "mode switch" (d8f6b2b): REJECTED.** Hijacked the user's
  timeframe rail to 1s + Line style. Lesson: NEVER touch the user's
  timeframe/bar-style state.
- **Attempt 2 — "React takeover" (aeaf7a6): REJECTED.** Reimplemented the RT
  display (heatmap/bubbles via /api/rt/flow) on the LSE chart in React, and
  gated the engine's `set_rt_mode` off in embeds. Lesson: the instruction
  "delete Real-time from the dock" meant ONLY the toolbar pill. Gating
  `set_rt_mode` was a "remove nothing" violation. The React renderer code
  still exists dormant (`frontend/src/components/chart/renderers/
  rtFlowRenderer.ts`, plumbing in ProChart.tsx, `/api/rt/flow` backend) — DO
  NOT wire it back up; DO NOT delete it without asking either.
- **Attempt 3 — engine menu via caret cmd 3: REJECTED in its first form.**
  Opening the ENGINE's settings popup made the G-Flow dock "pop out" and the
  menu appeared far from the button. The user wants the dropdown ON the
  button, looking "advanced", and the dock must never jump out at them.
- **FINAL ACCEPTED DESIGN (current, shipped):**
  - Dock embeds with `?rt=0` → hides ONLY the engine's Real-time pill
    (`render_tf_control` in `src/rendering/app_shell.cpp`). RT display code
    untouched and fully functional.
  - GT toolbar `Real-time` button (`#rt-toggle` in shell) toggles the
    ENGINE's own RT via a window bridge; a `▾` caret (`#rt-caret`) appears
    ONLY while RT is on (same rule as the engine pill) and opens a GT-styled
    dropdown (`#rt-menu`) anchored under the button.
  - The dropdown is a REMOTE CONTROL for the engine's settings — full parity
    with the engine's REAL-TIME SETTINGS menu (VIEW/DEPTH/TRADES/
    LIQUIDATIONS/SESSION), switch pills, steppers, action buttons. Every
    interaction sends a command to the engine; every painted state is read
    back from the engine.

### The bridge (all in ?rt=0 embeds only; host side is same-origin iframe JS)

Engine side — `main_loop()` in `third_party/edgedepth-terminal/src/main.cpp`
(runs every frame, chart toolbar or not; command posted before the first chart
exists stays pending):
- `window.__gtRtCmd`: 1 = RT on, 2 = RT off, 3 = open engine settings popup
  (legacy, shell no longer sends 3). Applied through the same
  `set_rt_mode()` path as the pill — entitlement/upsell gate included.
- `window.__gtRtOn`: engine truth, published every frame (0/1).
- `window.__gtRtQ`: array of `[code, value]` settings commands, drained ≤8 per
  frame into `ChartWidget::apply_rt_setting(code, value)`
  (`src/ui/chart_widget_realtime.cpp`) — same fields and side effects as the
  in-engine menu. Codes: 10 pause, 11 1s-candles, 12 trade line, 13 depth
  ladder, 14 follow price, 15 auto-fit history, 16 return live, 17 whole
  session, 18 extend depth, 19 bubbles, 20 auto-size, 21 recalibrate,
  22 min value, 23 reported liqs, 24 liq min notional, 25 activity strip,
  26 clear history.
- `window.__gtRtState`: JSON settings truth published every frame from
  `ChartWidget::rt_settings_state_json()` — includes dynamic labels
  (grouping line, "min X (warming up)", "Recorded N min · M MiB", overload
  warnings, not-plotted counts, followLabel, replay flag, arch flag).
- `ChartWidget::request_rt_settings_popup()` latch +
  `consume_rt_settings_popup_request()` consumed in `render_tf_control` —
  opens the engine's own `##rt_settings` popup (cmd 3 path, currently unused
  by the shell but functional).

Shell side — `setupRtToggle()` in `lse_terminal/ui/static/app.js`:
- Button click: if engine off → open dock if closed (`ofDock.open=true;
  ofDockApply()`) and `__gtRtCmd=1`; else `__gtRtCmd=2`.
- 500ms poller paints `rt-on` class and caret visibility from `__gtRtOn`
  ONLY (and closes the menu if RT turns off).
- Caret click: opens `#rt-menu`, pinned `position:fixed` under `#rt-slot`
  (the toolbar clips absolute children — that was a real bug). NEVER touches
  the dock.
- Menu: renders from `__gtRtState` every 300ms while open; clicks push onto
  `__gtRtQ`. Closes on outside click, Escape, window blur (clicks inside the
  iframe don't bubble to document — real bug found), and window resize
  (fixed-position coords go stale — real bug found).

**C++ changes require the CI WASM rebuild** (~8 min): push → GitHub Actions
"Build EdgeDepth WASM artifacts" → commits artifacts back to the branch with
`[skip ci]` → `git pull` locally → restart server. Watch with:
`gh run list --repo nova369-BOT/Green-Terminal- --branch arena/01a0fd01-green-terminal --limit 1`
then `gh run watch <id> --exit-status`.

## 5. ARCHITECTURE MAP

- `lse_terminal/` — Python FastAPI app (`engine/server.py`, ~8600 lines) +
  static shell (`ui/static/`: `index.html`, `app.js` ~21k lines, `style.css`).
  Serves everything incl. the engine at `/terminal/...` and `/edgedepth/*`
  artifacts. Global middleware: `Cache-Control: no-store` on EVERYTHING (so
  "stale browser cache" is never a valid excuse) + COOP/COEP credentialless.
- `frontend/` — React/TS pro chart, built with vite (NO typecheck in build)
  into `lse_terminal/ui/static/chart/chart.js` (bundle IS committed, repo
  convention).
- `third_party/edgedepth-terminal/` — the engine (C++/ImGui/WASM). Key files:
  `src/main.cpp` (AppState, main_loop + GT bridge, boot), `src/rendering/
  app_shell.cpp` (topbar, TF control, RT pill + ##rt_settings popup),
  `src/ui/chart_widget*.cpp/h` (chart, RT display `chart_widget_realtime.cpp`,
  settings menu `render_realtime_settings`), `src/core/url_router.h`
  (`url_rt_disabled()`, `url_watchlist_disabled()` — read `?rt=0` etc.).
- `third_party/edgedepth-gateway/` — Go gateway (venues: Binance, Bybit,
  Hyperliquid; protobuf wire). Prebuilt linux/amd64 binary committed at
  `bin/edgedepth-gateway` (repo convention). Go/emscripten/protoc exist ONLY
  in CI, not in the sandbox.
- Dock system in `app.js`: `#of-dock` (right dock) hosts `#ofd-stage`;
  `#of-portal` floats the always-mounted `#of-frame` iframe over whichever
  stage is active (`ofActiveHost`/`ofSyncPortal`); `ofDock`
  {open,w,max,tfSync} + `ofDockApply()`. Dock iframe src:
  `/terminal/hl/BTC?watchlist=0&rt=0` (follows chart symbol for crypto).
- `/api/candles` → `{provider,symbol,timeframe,candles:[[ts,o,h,l,c,v]…],
  indicators:{}}`. `loadChart()` in app.js sequences loads (`state.loadSeq`)
  and now stamps `state.candleSeriesKey = provider|symbol|timeframe`; on a
  failed load for a DIFFERENT key, stale candles are CLEARED to the honest
  empty state (bug fix 7cca434 — user caught gold OHLC displayed next to BTC
  quotes after an offline symbol switch).
- Info rail (right panel OVERVIEW/MARKET/SESSION/TECHNICAL): renders from
  `state.candleData` + `state.quotes[state.symbol]` (`ir-*` ids, ~line 215).

## 6. COMMIT HISTORY THAT MATTERS (branch arena/01a0fd01-green-terminal)

- 5f845f8 / 01ec063 — RT port v1/v2 (superseded), dock pill hidden, parity menu.
- 179f78a and other `[skip ci]` commits — CI WASM artifact commit-backs.
- d8f6b2b — REJECTED mode switch. aeaf7a6 — REJECTED React takeover (+ ordered
  reverts of side changes).
- 0da8bc5 — the correction: RT stays inside G-Flow, pill-only removal, button
  bridge. 7663bf1 — bridge moved to main_loop (toolbar-only bridge never ran
  when no chart yet — found by verification).
- 5a5a6ed — caret + engine-popup open (cmd 3). adf624c — GT-styled dropdown
  remote control (current design). 30f89ca — fixed-position fix (menu was
  clipped invisible). 2fd1d18 — menu close on blur/resize.
- 7cca434 — stale-candles honesty fix after failed symbol switch.
- Proof images in `docs/`: rt-in-gflow-on/off.png, rt-caret-settings.png,
  rt-caret-closeup.png, rt-menu-anchored.png, rt-settings-in-dock.png,
  stale-rail-fixed.png, gflow-dock-rt-deleted.png.

## 7. OPEN ITEMS (the actual to-do)

1. **User's last screenshot had TWO arrows.** Top-right one = the mixed-symbol
   rail bug → FIXED (7cca434). The LEFT arrow target is UNCONFIRMED (asked;
   user skipped). Candidates seen in that screenshot: G-Flow panel floating
   huge over a light-theme page in a narrow window; the OFFLINE chip while
   quotes still painted. GET THE ANSWER before building anything.
2. **User has not yet confirmed** the final dropdown + fixes on their machine
   (they said "ok"). If dock RT stays empty on their machine, ask for a
   screenshot of the dock status chips (HL should connect for them).
3. **The porting program continues**: G-Flow chart features → LSE chart, one
   by one, with dedupe, preview each step. Footprint exploration started
   (`design/gflow/item1_footprint_on_gt_chart.png` uncommitted). Get the
   user's pick for the next feature.
4. **G-FLOW tab keep/remove** decision deferred until all ports are done.
5. Trade-bubbles threshold belongs in Settings (user decree from pasted
   transcript). Unified timeframe — no separate orderflow TF.

## 8. SANDBOX SURVIVAL GUIDE (this environment bites)

- **The sandbox recycles constantly, even MID-TURN.** Repo files persist but
  git HEAD silently resets to base 3b7b6fc; venv, /tmp, node_modules,
  processes, and the screenshot rig vanish. BEFORE EVERY COMMIT run
  `git log -1`; if HEAD is wrong:
  `git fetch origin arena/01a0fd01-green-terminal` then
  `git reset origin/arena/01a0fd01-green-terminal` (NOT --hard), then stage
  only your files.
- **No internet to venues** (Binance/Bybit/HL/api.edgedepth.com all blocked)
  — engine shows honest offline states; npm/PyPI/GitHub work.
- Server: `python3 -m venv /home/user/.venv-gt`,
  `/home/user/.venv-gt/bin/pip install -q -e /home/user/Green-Terminal- pytest httpx`,
  run `LSE_TERMINAL_CONFIG_DIR=/home/user/.gt-config /home/user/.venv-gt/bin/python -m uvicorn --factory lse_terminal.engine.server:create_app --host 0.0.0.0 --port 7787`.
- Screenshot rig (ONLY known-working recipe): in `/home/user/shot`,
  `npm i puppeteer-core @sparticuz/chromium`; brotli-decompress
  `node_modules/@sparticuz/chromium/bin/{al2023.tar.br→/tmp/al2023,
  chromium.br→/tmp/chromium (chmod 755), swiftshader.tar.br→extract to /tmp}`.
  Launch with `LD_LIBRARY_PATH=/tmp/al2023/lib node script.js` and Chromium
  args: `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage
  --ignore-gpu-blocklist --use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader --enable-features=SharedArrayBuffer`.
  **NEVER `--disable-gpu`** — WebGL dies and the engine's main_loop never runs
  (hours were lost to this). Don't use `--single-process` (crashes).
- Puppeteer flow quirks: `waitUntil:'domcontentloaded'` + sleeps (networkidle
  times out); fresh profile auto-opens the markets palette — dismiss with two
  clicks at (600,520); engine frame is the one whose URL contains
  `/terminal/`; engine boot ≈ wait for `__gtRtOn` defined.
- Tests: full `pytest` ≈ 220 s, expect ~369 passed / 2 skipped. FastAPI
  TestClient needs `headers={"host":"127.0.0.1"}` (loopback guard 403s
  otherwise). `vite build` does NOT typecheck.
- EM_ASM: keep JS bodies free of top-level commas (or wrap in parens);
  multi-statement with semicolons is fine.
- `edit_file` fuzzy matching can hit stale text — dump the current lines
  first (`sed -n`), then edit.
- PEP-668: system pip refuses installs → always venv.

## 9. HOW TO BEHAVE (summary of what keeps this project healthy)

1. Read AGENTS.md + this file. 2. Investigate before coding; show the user
what you found in plain words. 3. Propose UI changes and wait for approval.
4. Build the smallest honest version; bridge to the engine rather than
reimplement. 5. Verify in the running app with a committed PNG; state clearly
when the sandbox's offline state limits what the proof can show. 6. Push to
the session branch; give the user the two update commands, one per line.
7. If the user is angry, they are usually right — find the real bug in YOUR
code before explaining anything else.
