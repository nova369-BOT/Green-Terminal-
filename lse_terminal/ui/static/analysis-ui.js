// Shell for RESEARCH > ANALYSIS. Draws the readings computed in analysis.js.
// Does not mount the old model island, and does not invent a price series.

const axState = {
  tool: "room",
  source: "chart",
  libSymbol: "",
  bars: [],
  loading: false,
  error: null,
  seq: 0,
  last: null,
  wired: false,
  released: false,
  truncated: false,
  nrows: 0,
};

function axDeskOpen() {
  const el = $("rs-models");
  const page = $("research");
  return !!(el && page && !el.classList.contains("hidden") && !page.classList.contains("hidden"));
}

function axWireChrome() {
  if (axState.wired) return;
  axState.wired = true;
  const open = $("ax-open");
  if (open) open.onclick = () => openResearch("models");
  const shot = $("shot-btn");
  if (shot) shot.onclick = (e) => { e.preventDefault(); captureView(); };
  window.addEventListener("lse-qm-open", () => { axConsumePending(); });
}

function axReleaseIsland() {
  if (axState.released) return;
  axState.released = true;
  const qm = window.LSEQuantModels;
  if (qm && typeof qm.unmount === "function") {
    try { qm.unmount(); } catch (e) { /* never mounted */ }
  }
}

function axOpen() {
  axWireChrome();
  axReleaseIsland();
  if (!axConsumePending()) {
    axState.source = "chart";
    axState.libSymbol = "";
    axState.truncated = false;
    axState.nrows = 0;
    axState.error = null;
    axEnsureChart();
  }
}

function axOnChart() {
  if (!axDeskOpen() || axState.source !== "chart") return;
  axEnsureChart();
}

function axConsumePending() {
  const pend = window.__lseQmPending;
  if (!pend || !pend.symbol) return false;
  window.__lseQmPending = null;
  axLoadLibrary(pend.symbol);
  return true;
}

function axLoadLibrary(symbol) {
  axState.source = "library";
  axState.libSymbol = symbol;
  axState.bars = [];
  axState.error = null;
  axState.loading = true;
  axState.truncated = false;
  axState.nrows = 0;
  axRender();
  const seq = ++axState.seq;
  fetch("/api/data/" + encodeURIComponent(symbol) + "/rows")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no rows"))))
    .then((doc) => {
      if (seq !== axState.seq || axState.source !== "library") return;
      const bars = axBarsFromTable(doc);
      axState.loading = false;
      if (!bars) {
        axState.bars = [];
        axState.error = "This library set has no open, high, low and close, so the readings cannot use it.";
      } else {
        axState.bars = bars;
        axState.truncated = !!doc.truncated;
        axState.nrows = doc.nrows || bars.length;
        axState.error = null;
      }
      axRender();
    })
    .catch(() => {
      if (seq !== axState.seq || axState.source !== "library") return;
      axState.loading = false;
      axState.bars = [];
      axState.error = "Could not read that library set.";
      axRender();
    });
}

function axCol(fields, names) {
  const lower = {};
  (fields || []).forEach((f) => { lower[String(f.name).toLowerCase()] = f.name; });
  for (const n of names) if (lower[n]) return lower[n];
  return null;
}

function axBarsFromTable(doc) {
  const o = axCol(doc && doc.fields, ["open", "o"]);
  const h = axCol(doc && doc.fields, ["high", "h"]);
  const l = axCol(doc && doc.fields, ["low", "l"]);
  const c = axCol(doc && doc.fields, ["close", "c"]);
  if (!o || !h || !l || !c) return null;
  const t = axCol(doc.fields, ["ts", "time", "date", "datetime", "timestamp"]);
  const v = axCol(doc.fields, ["volume", "vol", "v"]);
  const out = [];
  (doc.rows || []).forEach((r) => {
    const bar = { open: +r[o], high: +r[h], low: +r[l], close: +r[c], volume: v ? +r[v] : 0 };
    if (![bar.open, bar.high, bar.low, bar.close].every(isFinite)) return;
    if (t && r[t] != null) bar.time = r[t];
    out.push(bar);
  });
  return out.length ? out : null;
}

function axChartBars() {
  return (state.candleData || []).filter((b) => b && isFinite(+b.open) && isFinite(+b.close));
}

function axEnsureChart() {
  axState.source = "chart";
  const have = axChartBars();
  if (have.length) {
    axState.seq++;
    axState.bars = have;
    axState.loading = false;
    axState.error = null;
    axRender();
    return;
  }
  if (!state.symbol || !state.provider) {
    axState.seq++;
    axState.bars = [];
    axState.loading = false;
    axState.error = null;
    axRender();
    return;
  }
  axState.loading = true;
  axState.error = null;
  axRender();
  const seq = ++axState.seq;
  const symbol = state.symbol;
  const tf = state.timeframe;
  const url = "/api/candles?provider=" + encodeURIComponent(state.provider)
    + "&symbol=" + encodeURIComponent(state.symbol)
    + "&timeframe=" + encodeURIComponent(state.timeframe || "1h")
    + "&limit=5000";
  fetch(url)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no candles"))))
    .then((data) => {
      if (seq !== axState.seq || axState.source !== "chart") return;
      if (symbol !== state.symbol || tf !== state.timeframe) return;
      const bars = (data.candles || []).map((row) => ({
        time: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5],
      }));
      axState.loading = false;
      axState.bars = bars;
      axState.error = bars.length ? null : "No bars came back for this instrument.";
      axRender();
    })
    .catch(() => {
      if (seq !== axState.seq || axState.source !== "chart") return;
      axState.loading = false;
      axState.bars = [];
      axState.error = "Could not read bars for this instrument.";
      axRender();
    });
}

function axEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function axEnsureShell() {
  const host = $("rs-models-root");
  if (!host) return false;
  if (host.querySelector("#ax")) return true;
  const tools = (window.GTAnalysis && GTAnalysis.TOOLS) || [];
  host.innerHTML = '<div id="ax"><aside id="ax-side"><div class="ax-k">READINGS</div>'
    + tools.map((t) => '<button type="button" class="ax-tool" data-tool="' + axEsc(t.id) + '">'
      + '<span class="ax-name">' + axEsc(t.name) + '</span>'
      + '<span class="ax-line">' + axEsc(t.line) + '</span></button>').join("")
    + '<p class="ax-note">Counted from bars already loaded. Nothing on this page is simulated.</p>'
    + '</aside><div id="ax-main"><header id="ax-head"><span id="ax-title"></span>'
    + '<span id="ax-meta"></span>'
    + '<button type="button" id="ax-use" class="hidden">Use the open chart</button></header>'
    + '<div id="ax-read"></div>'
    + '<div id="ax-fig-wrap" class="hidden"><canvas id="ax-fig"></canvas></div>'
    + '<div id="ax-table" class="hidden"></div><div id="ax-method"></div></div></div>';
  host.querySelector("#ax-side").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tool]");
    if (!b) return;
    axState.tool = b.dataset.tool;
    axRender();
  });
  host.querySelector("#ax-use").onclick = () => {
    axState.source = "chart";
    axState.libSymbol = "";
    axState.truncated = false;
    axState.nrows = 0;
    axState.error = null;
    axEnsureChart();
  };
  const wrap = host.querySelector("#ax-fig-wrap");
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (axDeskOpen()) axPaint(); }).observe(wrap);
  }
  return true;
}

function axMeta() {
  const n = (axState.bars || []).length;
  if (axState.source === "library") {
    const name = axState.libSymbol || "library";
    if (axState.truncated && axState.nrows) {
      return name + " · library · " + n.toLocaleString() + " of " + axState.nrows.toLocaleString() + " bars";
    }
    return name + " · library · " + n.toLocaleString() + " bars";
  }
  if (!state.symbol && !n) return "no instrument";
  return (state.symbol || "—") + " · " + (state.timeframe || "—") + " · " + n.toLocaleString() + " bars";
}

function axRender() {
  if (!axEnsureShell()) return;
  const tools = (window.GTAnalysis && GTAnalysis.TOOLS) || [];
  if (!tools.some((t) => t.id === axState.tool) && tools[0]) axState.tool = tools[0].id;
  document.querySelectorAll("#ax-side .ax-tool").forEach((b) => {
    b.classList.toggle("on", b.dataset.tool === axState.tool);
  });
  const spec = tools.find((t) => t.id === axState.tool) || { name: "Analysis" };
  $("ax-title").textContent = spec.name;
  $("ax-meta").textContent = axMeta();
  $("ax-use").classList.toggle("hidden", axState.source !== "library");
  const read = $("ax-read");
  const method = $("ax-method");
  if (!window.GTAnalysis) {
    axState.last = null;
    read.textContent = "Analysis failed to load.";
    method.textContent = "";
    axShowFigure(null);
    return;
  }
  if (axState.loading) {
    axState.last = null;
    read.textContent = "Reading bars…";
    method.textContent = "";
    axShowFigure(null);
    return;
  }
  if (axState.error) {
    axState.last = null;
    read.textContent = axState.error;
    method.textContent = "A reading uses bars that were loaded. It does not invent a series.";
    axShowFigure(null);
    return;
  }
  if (!axState.bars.length) {
    axState.last = null;
    read.textContent = state.symbol
      ? "No bars are loaded for this instrument."
      : "No instrument is open. Open a chart, then come back. This desk reads bars that were loaded. It does not invent a series.";
    method.textContent = "";
    axShowFigure(null);
    return;
  }
  const result = GTAnalysis.compute(axState.tool, axState.bars);
  axState.last = result;
  read.textContent = result.read;
  method.textContent = result.method;
  axShowFigure(result.figure);
}

function axShowFigure(fig) {
  const wrap = $("ax-fig-wrap");
  const table = $("ax-table");
  if (!fig || fig.kind === "none") {
    wrap.classList.add("hidden");
    table.classList.add("hidden");
    table.innerHTML = "";
    return;
  }
  if (fig.kind === "table") {
    wrap.classList.add("hidden");
    table.classList.remove("hidden");
    const head = (fig.columns || []).map((c, i) =>
      '<th class="' + (i === fig.columns.length - 1 ? "num" : "") + '">' + axEsc(c) + "</th>").join("");
    const body = (fig.rows || []).map((r) => "<tr>" + r.cells.map((c) =>
      '<td class="' + axEsc(c.cls || "") + '">' + axEsc(c.text) + "</td>").join("") + "</tr>").join("");
    table.innerHTML = "<table><thead><tr>" + head + "</tr></thead><tbody>"
      + (body || "<tr><td>No breaks in this sample.</td></tr>") + "</tbody></table>";
    return;
  }
  table.classList.add("hidden");
  table.innerHTML = "";
  wrap.classList.remove("hidden");
  axPaint();
}

function axPalette() {
  const s = getComputedStyle(document.documentElement);
  const g = (name, fb) => s.getPropertyValue(name).trim() || fb;
  return {
    bg: g("--bg", "#05080a"),
    text: g("--text", "#f4f1e8"),
    dim: g("--dim", "#9aa79d"),
    edge: g("--edge", "#1d2b23"),
    up: g("--up", "#1f9d55"),
    down: g("--down", "#c04a5e"),
    brass: g("--accent-bar", "#b08d57"),
  };
}

function axInk(pal, name) {
  if (name === "up") return pal.up;
  if (name === "down") return pal.down;
  if (name === "brass") return pal.brass;
  return pal.text;
}

function axFont(px) {
  return px + "px ui-monospace, SFMono-Regular, Consolas, monospace";
}

function axSizeCanvas(canvas, wrap) {
  const r = wrap.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(r.width));
  const h = Math.max(180, Math.floor(r.height));
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx: ctx, w: w, h: h };
}

function axPaint() {
  const fig = axState.last && axState.last.figure;
  const canvas = $("ax-fig");
  const wrap = $("ax-fig-wrap");
  if (!fig || !canvas || !wrap || wrap.classList.contains("hidden")) return;
  if (fig.kind === "table" || fig.kind === "none") return;
  const box = axSizeCanvas(canvas, wrap);
  axDraw(box.ctx, box.w, box.h, fig, axPalette());
}

function axDraw(ctx, w, h, fig, pal) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);
  if (fig.kind === "hbar") axDrawHbar(ctx, w, h, fig, pal);
  else if (fig.kind === "grouped") axDrawGrouped(ctx, w, h, fig, pal);
  else if (fig.kind === "hours") axDrawHours(ctx, w, h, fig, pal);
  else if (fig.kind === "hist") axDrawHist(ctx, w, h, fig, pal);
  else if (fig.kind === "strip") axDrawStrip(ctx, w, h, fig, pal);
}

function axDrawHbar(ctx, w, h, fig, pal) {
  const rows = fig.rows || [];
  const padL = 84, padR = 116, padT = 18, padB = 16;
  const rowH = (h - padT - padB) / Math.max(1, rows.length);
  const max = fig.max || 100;
  const inner = Math.max(1, w - padL - padR);
  ctx.font = axFont(11);
  (fig.guides || []).forEach((g) => {
    const x = padL + (g / max) * inner;
    ctx.strokeStyle = pal.edge;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, h - padB);
    ctx.stroke();
  });
  rows.forEach((row, i) => {
    const mid = padT + i * rowH + rowH / 2;
    ctx.fillStyle = pal.dim;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(row.label, padL - 10, mid);
    const val = row.value;
    const bw = val == null || !isFinite(val) ? 0 : Math.max(0, Math.min(1, val / max)) * inner;
    ctx.globalAlpha = row.thin ? 0.4 : 1;
    ctx.fillStyle = row.mark ? pal.brass : pal.text;
    ctx.fillRect(padL, mid - 4, bw, 8);
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.dim;
    ctx.textAlign = "left";
    ctx.fillText(row.caption || "—", padL + bw + 8, mid);
  });
}

function axDrawGrouped(ctx, w, h, fig, pal) {
  const groups = fig.groups || [];
  const series = fig.series || [];
  const padL = 36, padR = 16, padT = 32, padB = 28;
  const max = fig.max || 100;
  const innerW = Math.max(1, w - padL - padR);
  const innerH = Math.max(1, h - padT - padB);
  const gw = innerW / Math.max(1, groups.length);
  ctx.font = axFont(11);
  (fig.guides || []).forEach((g) => {
    const y = padT + innerH - (g / max) * innerH;
    ctx.strokeStyle = pal.edge;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = pal.dim;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(String(g), padL - 6, y);
  });
  series.forEach((name, s) => {
    ctx.fillStyle = axInk(pal, (fig.colors || [])[s]);
    ctx.fillRect(padL + s * 72, 10, 8, 8);
    ctx.fillStyle = pal.dim;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(name, padL + s * 72 + 12, 14);
  });
  groups.forEach((g, i) => {
    const x = padL + i * gw;
    const bw = Math.min(16, (gw - 28) / Math.max(1, series.length));
    (g.values || []).forEach((val, s) => {
      if (val == null || !isFinite(val)) return;
      const bh = Math.max(0, Math.min(1, val / max)) * innerH;
      ctx.fillStyle = axInk(pal, (fig.colors || [])[s]);
      ctx.fillRect(x + 14 + s * (bw + 4), padT + innerH - bh, bw, bh);
    });
    ctx.fillStyle = pal.dim;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(g.label, x + gw / 2, h - padB + 8);
  });
}

function axDrawHours(ctx, w, h, fig, pal) {
  const rows = fig.rows || [];
  const padL = 28, padR = 12, padT = 16, padB = 26;
  const maxShare = rows.reduce((m, r) => Math.max(m, r.share || 0), 8);
  const innerW = Math.max(1, w - padL - padR);
  const innerH = Math.max(1, h - padT - padB);
  const cw = innerW / 24;
  if (fig.even) {
    const y = padT + innerH - (Math.min(fig.even, maxShare) / maxShare) * innerH;
    ctx.strokeStyle = pal.brass;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.brass;
    ctx.font = axFont(10);
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("even", padL + 4, Math.max(12, y - 2));
  }
  rows.forEach((r, i) => {
    const bh = ((r.share || 0) / maxShare) * innerH;
    ctx.globalAlpha = r.thin ? 0.35 : 1;
    ctx.fillStyle = r.loud ? pal.brass : pal.text;
    ctx.fillRect(padL + i * cw + 2, padT + innerH - bh, Math.max(1, cw - 4), bh);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = pal.dim;
  ctx.font = axFont(10);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  [0, 6, 12, 18].forEach((hour) => {
    ctx.fillText(String(hour), padL + hour * cw + cw / 2, h - padB + 6);
  });
}

function axDrawHist(ctx, w, h, fig, pal) {
  const bins = fig.bins || [];
  const padL = 16, padR = 12, padT = 22, padB = 22;
  const max = bins.reduce((m, n) => Math.max(m, n), 1);
  const innerW = Math.max(1, w - padL - padR);
  const innerH = Math.max(1, h - padT - padB);
  const cw = innerW / Math.max(1, bins.length);
  bins.forEach((n, i) => {
    const bh = (n / max) * innerH;
    ctx.fillStyle = pal.text;
    ctx.globalAlpha = 0.88;
    ctx.fillRect(padL + i * cw + 1, padT + innerH - bh, Math.max(1, cw - 2), bh);
    ctx.globalAlpha = 1;
  });
  if (fig.median) {
    const x = padL + (fig.median - 0.5) * cw;
    ctx.strokeStyle = pal.brass;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + innerH);
    ctx.stroke();
  }
  ctx.fillStyle = pal.dim;
  ctx.font = axFont(10);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  if (fig.label) ctx.fillText(fig.label, padL, 4);
  ctx.textAlign = "center";
  ctx.fillText("1", padL + cw / 2, h - 14);
  ctx.fillText(String(bins.length), padL + innerW - cw / 2, h - 14);
}

function axDrawStrip(ctx, w, h, fig, pal) {
  const closes = fig.closes || [];
  const tags = fig.tags || [];
  const dirs = fig.dirs || [];
  if (closes.length < 2) return;
  const padL = 12, padR = 12, padT = 28, padB = 16;
  let lo = closes[0], hi = closes[0];
  closes.forEach((c) => { if (c < lo) lo = c; if (c > hi) hi = c; });
  if (hi === lo) { lo -= 1; hi += 1; }
  const innerW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB - 16);
  ctx.beginPath();
  closes.forEach((c, i) => {
    const x = padL + (i / (closes.length - 1)) * innerW;
    const y = padT + (1 - (c - lo) / (hi - lo)) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = pal.text;
  ctx.lineWidth = 1.25;
  ctx.stroke();
  const stripY = padT + plotH + 8;
  const cw = innerW / Math.max(1, tags.length);
  tags.forEach((tag, i) => {
    ctx.fillStyle = tag === "calm" ? pal.edge : tag === "push" ? pal.brass
      : (dirs[i] < 0 ? pal.down : pal.up);
    ctx.fillRect(padL + i * cw, stripY, Math.max(1, cw), 6);
  });
  ctx.font = axFont(10);
  ctx.textBaseline = "middle";
  [["calm", pal.edge], ["push", pal.brass], ["shock", pal.up]].forEach((it, i) => {
    ctx.fillStyle = it[1];
    ctx.fillRect(padL + i * 70, 10, 8, 8);
    ctx.fillStyle = pal.dim;
    ctx.textAlign = "left";
    ctx.fillText(it[0], padL + i * 70 + 12, 14);
  });
}

function captureView() {
  axWireChrome();
  if (axDeskOpen() && axState.last) captureAnalysis();
  else captureChart();
}

function shotName(part) {
  const sym = axDeskOpen() && axState.source === "library"
    ? (axState.libSymbol || "library") : (state.symbol || "view");
  const tf = axDeskOpen() && axState.source === "library" ? "library" : (state.timeframe || "");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + "-" + p(d.getHours()) + p(d.getMinutes());
  const clean = (s) => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "");
  return ["green-terminal", clean(sym), clean(tf), clean(part), stamp].filter(Boolean).join("-") + ".png";
}

function shotFlash(ok) {
  const btn = $("shot-btn");
  if (btn) {
    btn.classList.toggle("shot-ok", !!ok);
    if (ok) setTimeout(() => btn.classList.remove("shot-ok"), 1200);
  }
  const msg = ok ? "picture saved" : "could not read a picture";
  if (typeof status === "function") {
    status(msg);
    setTimeout(() => {
      const el = $("status");
      if (el && el.textContent === msg) status("");
    }, 2200);
  }
}

function shotSave(canvas, name) {
  const finish = (url) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (String(url).indexOf("blob:") === 0) setTimeout(() => URL.revokeObjectURL(url), 1500);
    shotFlash(true);
  };
  if (canvas.toBlob) {
    canvas.toBlob((blob) => {
      if (!blob) { shotFlash(false); return; }
      finish(URL.createObjectURL(blob));
    }, "image/png");
    return;
  }
  try { finish(canvas.toDataURL("image/png")); }
  catch (e) { shotFlash(false); }
}

function axWrap(ctx, text, max) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  words.forEach((w) => {
    const next = cur ? cur + " " + w : w;
    if (ctx.measureText(next).width > max && cur) { lines.push(cur); cur = w; }
    else cur = next;
  });
  if (cur) lines.push(cur);
  return lines;
}

function captureAnalysis() {
  const result = axState.last;
  if (!result) { shotFlash(false); return; }
  const pal = axPalette();
  const W = 1100, pad = 28, dpr = 2;
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = "15px -apple-system, Inter, system-ui, sans-serif";
  const readLines = axWrap(measure, result.read, W - pad * 2);
  measure.font = "12px -apple-system, Inter, system-ui, sans-serif";
  const methodLines = axWrap(measure, result.method, W - pad * 2);
  const fig = result.figure;
  const hasFig = fig && fig.kind !== "none" && fig.kind !== "table";
  const figH = hasFig ? 340 : 0;
  const tableRows = fig && fig.kind === "table" ? (fig.rows || []).slice(0, 10) : [];
  const tableH = tableRows.length ? 28 + tableRows.length * 22 : 0;
  const H = 72 + readLines.length * 22 + 12 + figH + tableH + 16 + methodLines.length * 18 + 20;
  const out = document.createElement("canvas");
  out.width = W * dpr;
  out.height = H * dpr;
  const ctx = out.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = pal.dim;
  ctx.font = axFont(11);
  ctx.textBaseline = "top";
  const spec = ((window.GTAnalysis && GTAnalysis.TOOLS) || []).find((t) => t.id === axState.tool);
  ctx.fillText("Green Terminal  ·  " + (spec ? spec.name : "Analysis") + "  ·  " + axMeta(), pad, 16);
  ctx.strokeStyle = pal.edge;
  ctx.beginPath();
  ctx.moveTo(pad, 38);
  ctx.lineTo(W - pad, 38);
  ctx.stroke();
  ctx.fillStyle = pal.text;
  ctx.font = "15px -apple-system, Inter, system-ui, sans-serif";
  let y = 52;
  readLines.forEach((ln) => { ctx.fillText(ln, pad, y); y += 22; });
  y += 10;
  if (hasFig) {
    const tile = document.createElement("canvas");
    tile.width = (W - pad * 2) * dpr;
    tile.height = figH * dpr;
    const fctx = tile.getContext("2d");
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    axDraw(fctx, W - pad * 2, figH, fig, pal);
    ctx.drawImage(tile, pad, y, W - pad * 2, figH);
    y += figH + 8;
  }
  if (tableRows.length) {
    ctx.font = axFont(11);
    ctx.textBaseline = "top";
    fig.columns.forEach((c, i) => {
      ctx.fillStyle = pal.dim;
      ctx.textAlign = i === fig.columns.length - 1 ? "right" : "left";
      ctx.fillText(c, i === fig.columns.length - 1 ? W - pad : pad + i * 180, y);
    });
    y += 16;
    ctx.strokeStyle = pal.edge;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(W - pad, y);
    ctx.stroke();
    y += 8;
    tableRows.forEach((r) => {
      r.cells.forEach((c, i) => {
        ctx.textAlign = i === r.cells.length - 1 ? "right" : "left";
        ctx.fillStyle = c.cls === "up" ? pal.up : c.cls === "down" ? pal.down : pal.text;
        ctx.fillText(String(c.text), i === r.cells.length - 1 ? W - pad : pad + i * 180, y);
      });
      y += 22;
    });
  }
  y += 8;
  ctx.fillStyle = pal.dim;
  ctx.font = "12px -apple-system, Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  methodLines.forEach((ln) => { ctx.fillText(ln, pad, y); y += 18; });
  shotSave(out, shotName(axState.tool));
}

function captureChart() {
  const root = $("chart-stage") || $("charts") || document.body;
  let best = null, area = 0;
  root.querySelectorAll("canvas").forEach((c) => {
    const r = c.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return;
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    const a = r.width * r.height;
    if (a > area) { area = a; best = c; }
  });
  if (!best) { shotFlash(false); return; }
  try {
    const src = document.createElement("canvas");
    src.width = best.width;
    src.height = best.height;
    src.getContext("2d").drawImage(best, 0, 0);
    const sample = src.getContext("2d").getImageData(
      0, 0, Math.min(src.width, 48), Math.min(src.height, 48)).data;
    let ink = 0;
    for (let i = 3; i < sample.length; i += 16) if (sample[i] > 12) ink++;
    if (ink < 3) { shotFlash(false); return; }
    const header = 36;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height + header;
    const ctx = out.getContext("2d");
    const pal = axPalette();
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, header);
    ctx.fillStyle = pal.dim;
    ctx.font = "14px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textBaseline = "middle";
    ctx.fillText("Green Terminal  ·  " + (state.symbol || "") + "  ·  " + (state.timeframe || ""), 14, header / 2);
    shotSave(out, shotName("chart"));
  } catch (e) {
    shotFlash(false);
  }
}

axWireChrome();
