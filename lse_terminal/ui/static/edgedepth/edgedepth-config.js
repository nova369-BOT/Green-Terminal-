// Gateway feed for the real EdgeDepth client (entrypoint contract).
// Browser resolves: ?ws= → window.__EDGEDEPTH_WS_URL__ → hosted default.
window.__EDGEDEPTH_WS_URL__ = "ws://127.0.0.1:8080/ws";
window.__EDGEDEPTH_HOSTED__ = false;
