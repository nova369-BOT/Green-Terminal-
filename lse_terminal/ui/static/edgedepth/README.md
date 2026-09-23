# EdgeDepth runtime artifacts (Phase 4)

This directory hosts the REAL EdgeDepth Terminal build outputs:

- index.html (or use shell.html as template)
- index.js
- index.wasm
- index.data
- coi-serviceworker.js (present)
- edgedepth-config.js (generated: gateway WebSocket URL)

Build (outside this sandbox if emsdk/protoc unavailable):

```bash
cd third_party/edgedepth-terminal
# needs emsdk 4.0.15+ and protoc 21.x — see Dockerfile
emcmake cmake -DCMAKE_BUILD_TYPE=Release -B build
emmake make -C build c_based_trader_client
cp build/index.{html,js,wasm,data} \
   ../../lse_terminal/ui/static/edgedepth/
```

Source of truth: `third_party/edgedepth-terminal` (AGPL-3.0).
Do NOT reimplement DOM/heatmap/tape here — load the real build.
