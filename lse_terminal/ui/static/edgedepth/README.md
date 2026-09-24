# EdgeDepth runtime artifacts (Phase 4 → one-app integration)

This directory hosts the REAL EdgeDepth Terminal build outputs served
**inside Green Terminal** (`MARKET → ORDER FLOW`). There is no second
product/window.

Required runtime files:

- index.html — built shell (iframe loads `/edgedepth/index.html` when ready)
- index.js / index.wasm / index.data — official Emscripten artifacts
- coi-serviceworker.js (present)
- edgedepth-config.js — **served dynamically** by the engine
  (`GET /edgedepth/edgedepth-config.js`) so the browser WS URL always
  points at the **GT-managed** gateway, never a hand-started app.
- shell.html — source template only (`{{{ SCRIPT }}}` is the Emscripten
  placeholder); not the iframe target.

Build (outside this sandbox if emsdk/protoc unavailable):

```bash
cd third_party/edgedepth-terminal
# needs emsdk 4.0.15+ and protoc 21.x — see Dockerfile
emcmake cmake -DCMAKE_BUILD_TYPE=Release -B build
emmake make -C build c_based_trader_client
# Match Dockerfile: inject config script before the Emscripten glue.
sed -i 's|<head>|<head>\n<script src="edgedepth-config.js"></script>|' build/index.html
cp build/index.{html,js,wasm,data} \
   ../../lse_terminal/ui/static/edgedepth/
```

Gateway: Green Terminal starts/stops `third_party/edgedepth-gateway`
automatically on `lset` (see `lse_terminal/engine/edgedepth_gateway.py`).
Do not ask users to run a standalone EdgeDepth Terminal.

Source of truth: `third_party/edgedepth-terminal` (AGPL-3.0).
Do NOT reimplement DOM/heatmap/tape here — load the real build.
