// ============================================================================
// renderers/rtFlowRenderer.ts — the Real-time view, EdgeDepth-style TAKEOVER.
//
// Clicking Real-time gives this view the WHOLE chart surface, exactly like
// the G-Flow terminal's RT mode: its own rolling live time scale (last 30
// seconds, or the whole recorded session), its own auto-fitted price scale,
// depth heatmap bands, the trade-price line (or 1s candles built from the
// observed trades), trade bubbles, DOM ladder, reported liquidations and the
// activity strip. The user's candle chart underneath is NOT touched — no
// timeframe switch, no bar-style switch; toggling off reveals it exactly as
// it was.
//
// Everything here is PURE canvas drawing: no React state, no fetching — data
// comes in as arguments (ProChart polls /api/rt/flow at 1 Hz). The status
// chip is ALWAYS drawn while the mode is on: venue + LIVE, or the real
// reason there is no data. No fake states, ever.
// ============================================================================

export interface RTTrade { t: number; p: number; q: number; side: 'buy' | 'sell' }
export interface RTLiq { t: number; p: number; q: number; side: 'buy' | 'sell'; notional: number }

export interface RTColumn {
  t: number;
  mid?: number | null;
  bids_prices?: number[]; bids_sizes?: number[];
  asks_prices?: number[]; asks_sizes?: number[];
}

export interface RTViewSettings {
  heatmap: boolean;
  followPrice: boolean;      // auto-fit price each frame; off = freeze the window
  extendDepth: boolean;      // project the last sampled book into the right margin
  ladder: boolean;
  bubbles: boolean;
  tradeLine: boolean;
  candles1s: boolean;        // 1s candles from observed trades, instead of the line
  liqs: boolean;
  liqMinNotional: number;
  activityStrip: boolean;
  bubbleMin: number | null;  // sticky auto-calibrated notional floor (null = calibrate)
  spanMode: 'live' | 'session';  // Return live (30s) vs Whole session
  pause: boolean;
}

export interface RTStatusInfo {
  flow?: 'ok' | 'none' | 'error' | string;
  coin?: string | null;
  venue?: string | null;
  connected?: boolean;
  error?: string | null;
  reason?: string | null;
  liq_source?: string | null;
  recorded_ms?: number;
  approx_bytes?: number;
  cols_dropped?: number;
  trades_dropped?: number;
  now?: number;
}

export interface RTRenderInfo {
  groupingLabel: string;
  autoMin: number;
  notPlotted: number;
  pMin: number;   // the price window this frame actually used —
  pMax: number;   // held by the caller so "Follow price" OFF can freeze it
}

export interface RTSurface {
  width: number;    // full canvas width (CSS px)
  height: number;   // full canvas height (CSS px)
  axisWidth: number;  // right price-axis gutter reserved by the chart
  background: string; // chart background color
}

const LIVE_SPAN_MS = 30_000;   // EdgeDepth's "most recent 30 seconds"
const TIME_AXIS_H = 22;
const STRIP_H = 46;

// ── palette (terminal tokens, mirrored from the shell css) ──────────────────
const GRID = 'rgba(61, 77, 68, 0.35)';
const AXIS_TX = 'rgba(154, 167, 157, 0.95)';
const LINE_TX = 'rgba(236, 242, 238, 0.85)';
const BUY = 'rgba(16, 185, 129,';
const SELL = 'rgba(239, 68, 68,';
const BRASS = 'rgba(176, 141, 87, 0.95)';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function depthColor(intensity: number): string {
  const t = Math.min(1, Math.max(0, intensity));
  if (t < 0.25) { const s = t / 0.25; return `rgba(${14 + 10 * s | 0}, ${40 + 40 * s | 0}, ${90 + 70 * s | 0}, ${0.35 + 0.3 * s})`; }
  if (t < 0.55) { const s = (t - 0.25) / 0.3; return `rgba(${24 + 20 * s | 0}, ${80 + 70 * s | 0}, ${160 + 60 * s | 0}, ${0.65 + 0.2 * s})`; }
  if (t < 0.85) { const s = (t - 0.55) / 0.3; return `rgba(${44 + 80 * s | 0}, ${150 + 70 * s | 0}, ${220 + 25 * s | 0}, ${0.85 + 0.1 * s})`; }
  const s = (t - 0.85) / 0.15; return `rgba(${124 + 110 * s | 0}, ${220 + 30 * s | 0}, 245, 0.95)`;
}

function roundBin(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function fmtPrice(v: number): string {
  if (!isFinite(v)) return '—';
  if (v >= 10000) return v.toFixed(0);
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(4);
}

// "Auto size": 75th percentile of received trade NOTIONAL values, exactly
// like the original. Sticky — the caller holds it until Recalibrate.
export function calibrateBubbleMin(trades: RTTrade[]): number {
  if (trades.length === 0) return 0;
  const values = trades.map((t) => t.p * t.q).sort((a, b) => a - b);
  return values[Math.floor(values.length * 0.75)] || 0;
}

// ── the status chip: the honest line, always drawn while the mode is on ────
function drawStatusChip(
  ctx: CanvasRenderingContext2D,
  plotW: number, yBase: number,
  status: RTStatusInfo | null,
  columnsCount: number,
): void {
  let text: string;
  let dot: string;
  if (!status) {
    text = 'RT · connecting to the engine…';
    dot = '#b8a24a';
  } else if (status.flow === 'none') {
    text = `RT · ${status.reason || 'no crypto venue for this symbol'}`;
    dot = '#b8a24a';
  } else if (status.flow === 'error' || !status.venue) {
    text = `RT · ${status.error || 'venue unreachable'}`;
    dot = '#c25e5e';
  } else if (!status.connected) {
    text = `RT · ${String(status.venue).toUpperCase()} · waiting for live book…`;
    dot = '#b8a24a';
  } else {
    const mins = ((status.recorded_ms || 0) / 60000).toFixed(1);
    text = `RT · ${String(status.venue).toUpperCase()} · LIVE · ${columnsCount} samples · ${mins} min`;
    dot = '#2dd4a0';
  }
  if (text.length > 130) text = text.slice(0, 129) + '…';
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `10px ${MONO}`;
  const w = Math.min(ctx.measureText(text).width + 22, plotW - 16);
  const x = 8;
  const y = yBase - 24;
  ctx.fillStyle = 'rgba(5, 10, 8, 0.82)';
  ctx.strokeStyle = 'rgba(61, 77, 68, 0.9)';
  ctx.beginPath();
  (ctx as any).roundRect ? (ctx as any).roundRect(x, y, w, 17, 4) : ctx.rect(x, y, w, 17);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(x + 9, y + 8.5, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(214, 226, 219, 0.92)';
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w - 4, 17); ctx.clip();
  ctx.fillText(text, x + 17, y + 12);
  ctx.restore();
  ctx.restore();
}

// ── THE TAKEOVER ────────────────────────────────────────────────────────────
export function renderRTTakeover(
  ctx: CanvasRenderingContext2D,
  surface: RTSurface,
  columns: RTColumn[],
  trades: RTTrade[],
  liqs: RTLiq[],
  s: RTViewSettings,
  status: RTStatusInfo | null,
  frozenWindow: { pMin: number; pMax: number } | null = null,
): RTRenderInfo {
  const { width, height, axisWidth } = surface;
  const plotW = Math.max(10, width - axisWidth);
  const stripH = s.activityStrip ? STRIP_H : 0;
  const plotH = Math.max(10, height - TIME_AXIS_H - stripH);
  const info: RTRenderInfo = { groupingLabel: '—', autoMin: 0, notPlotted: 0, pMin: 0, pMax: 0 };

  // The RT view owns the whole surface (G-Flow behaviour): cover whatever
  // the candle pipeline drew. The candle chart itself is untouched state —
  // toggling RT off reveals it exactly as it was.
  ctx.save();
  ctx.fillStyle = surface.background || '#0a0f0c';
  ctx.fillRect(0, 0, width, height);

  // ── live time domain ──────────────────────────────────────────────────
  const lastColT = columns.length ? columns[columns.length - 1].t : 0;
  const lastTrdT = trades.length ? trades[trades.length - 1].t : 0;
  const dataEnd = Math.max(lastColT, lastTrdT);
  if (!dataEnd) {
    // Nothing recorded yet (or venue dead): honest empty state, no fakes.
    ctx.fillStyle = AXIS_TX;
    ctx.font = `11px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Real-time view — waiting for live venue data…', plotW / 2, plotH / 2);
    drawStatusChip(ctx, plotW, height - TIME_AXIS_H - stripH, status, 0);
    ctx.restore();
    return info;
  }
  const firstColT = columns.length ? columns[0].t : dataEnd;
  const firstTrdT = trades.length ? trades[0].t : dataEnd;
  const tEnd = dataEnd + 400;  // small lead so the newest print isn't on the edge
  const span = s.spanMode === 'session'
    ? Math.max(LIVE_SPAN_MS, tEnd - Math.min(firstColT, firstTrdT))
    : LIVE_SPAN_MS;
  const t0 = tEnd - span;
  // extendDepth projects the last book into a right margin (a HELD current
  // book, not future orders — same meaning as the original).
  const liveW = s.extendDepth ? plotW * 0.9 : plotW;
  const xOf = (t: number) => ((t - t0) / span) * liveW;

  // ── price domain: auto-fit everything observed in the window ─────────
  let pMin = Infinity, pMax = -Infinity;
  for (const tr of trades) {
    if (tr.t < t0) continue;
    if (tr.p < pMin) pMin = tr.p;
    if (tr.p > pMax) pMax = tr.p;
  }
  for (const c of columns) {
    if (c.t < t0) continue;
    const bp = c.bids_prices || [], ap = c.asks_prices || [];
    // Book edge rows frame the ladder; cap how far they stretch the scale.
    if (bp.length) { const v = bp[Math.min(9, bp.length - 1)]; if (v < pMin) pMin = v; }
    if (ap.length) { const v = ap[Math.min(9, ap.length - 1)]; if (v > pMax) pMax = v; }
  }
  if (!isFinite(pMin) || !isFinite(pMax)) {
    const mid = columns.length ? Number(columns[columns.length - 1].mid) : 0;
    pMin = mid * 0.999; pMax = mid * 1.001;
  }
  if (pMax <= pMin) { const m = pMax || 1; pMin = m * 0.999; pMax = m * 1.001; }
  const pad = (pMax - pMin) * 0.08;
  pMin -= pad; pMax += pad;
  // "Follow price" OFF: hold the window the user froze instead of refitting.
  if (!s.followPrice && frozenWindow && frozenWindow.pMax > frozenWindow.pMin) {
    pMin = frozenWindow.pMin; pMax = frozenWindow.pMax;
  }
  info.pMin = pMin; info.pMax = pMax;
  const yOf = (p: number) => ((pMax - p) / (pMax - pMin)) * plotH;

  // ── grid + axes ───────────────────────────────────────────────────────
  ctx.strokeStyle = GRID;
  ctx.fillStyle = AXIS_TX;
  ctx.font = `10px ${MONO}`;
  ctx.lineWidth = 1;
  // horizontal price rows
  const priceStep = roundBin((pMax - pMin) / 6);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let p = Math.ceil(pMin / priceStep) * priceStep; p < pMax; p += priceStep) {
    const y = Math.round(yOf(p)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillText(fmtPrice(p), plotW + 6, y);
  }
  // vertical time ticks (nice seconds steps)
  const tStepRaw = span / 6;
  const tSteps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000];
  const tStep = tSteps.find((v) => v >= tStepRaw) || 3600000;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= tEnd; t += tStep) {
    const x = Math.round(xOf(t)) + 0.5;
    if (x < 0 || x > plotW) continue;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH + stripH); ctx.stroke();
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    ctx.fillText(`${hh}:${mm}:${ss}`, x, plotH + stripH + 6);
  }

  // ── depth heatmap bands (each 1 Hz sample held to the next) ───────────
  if (s.heatmap && columns.length) {
    const bin = roundBin(((pMax - pMin) / plotH) * 3);  // rows ≥ ~3px
    info.groupingLabel = bin >= 1 ? String(bin) : bin.toPrecision(2);
    let globalMax = 0;
    const binned: { x0: number; x1: number; rows: Map<number, number> }[] = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      if (col.t < t0 - 2000) continue;
      const x0 = xOf(col.t);
      const x1 = i + 1 < columns.length ? xOf(columns[i + 1].t)
        : (s.extendDepth ? plotW : xOf(col.t + 1000));
      if (x1 < 0 || x0 > plotW) continue;
      const rows = new Map<number, number>();
      const add = (ps?: number[], qs?: number[]) => {
        if (!ps || !qs) return;
        for (let k = 0; k < ps.length; k++) {
          const key = Math.round(Number(ps[k]) / bin);
          const v = (rows.get(key) || 0) + Number(qs[k]);
          rows.set(key, v);
          if (v > globalMax) globalMax = v;
        }
      };
      add(col.bids_prices, col.bids_sizes);
      add(col.asks_prices, col.asks_sizes);
      binned.push({ x0, x1, rows });
    }
    if (globalMax > 0) {
      for (const seg of binned) {
        const w = Math.max(1, seg.x1 - seg.x0);
        for (const [key, size] of seg.rows) {
          const price = key * bin;
          const y = yOf(price + bin / 2);
          const h = Math.max(1, Math.abs(yOf(price - bin / 2) - y));
          if (y > plotH || y + h < 0) continue;
          const it = Math.pow(size / globalMax, 0.55);
          if (it < 0.04) continue;
          ctx.fillStyle = depthColor(it);
          ctx.fillRect(seg.x0, y, w + 0.5, h);
        }
      }
    }
  }

  // ── DOM ladder: last live book as horizontal bars off the right edge ──
  if (s.ladder && columns.length) {
    const last = columns[columns.length - 1];
    const bp = last.bids_prices || [], bq = last.bids_sizes || [];
    const ap = last.asks_prices || [], aq = last.asks_sizes || [];
    let maxQ = 0;
    for (let i = 0; i < Math.min(15, bq.length); i++) maxQ = Math.max(maxQ, Number(bq[i]));
    for (let i = 0; i < Math.min(15, aq.length); i++) maxQ = Math.max(maxQ, Number(aq[i]));
    if (maxQ > 0) {
      const maxBar = plotW * 0.18;
      const row = (price: number, size: number, buy: boolean) => {
        const y = yOf(price);
        if (y < 0 || y > plotH) return;
        const w = Math.max(1, (size / maxQ) * maxBar);
        ctx.fillStyle = buy ? `${BUY}0.28)` : `${SELL}0.28)`;
        ctx.fillRect(plotW - w, y - 1.5, w, 3);
      };
      for (let i = 0; i < Math.min(15, bp.length); i++) row(Number(bp[i]), Number(bq[i]), true);
      for (let i = 0; i < Math.min(15, ap.length); i++) row(Number(ap[i]), Number(aq[i]), false);
    }
  }

  // ── trade price: the line, or 1s candles built from observed trades ───
  const winTrades = trades.filter((tr) => tr.t >= t0 - 1000);
  if (s.candles1s && winTrades.length) {
    const buckets = new Map<number, { o: number; h: number; l: number; c: number }>();
    for (const tr of winTrades) {
      const sec = Math.floor(tr.t / 1000);
      const b = buckets.get(sec);
      if (!b) buckets.set(sec, { o: tr.p, h: tr.p, l: tr.p, c: tr.p });
      else { b.c = tr.p; if (tr.p > b.h) b.h = tr.p; if (tr.p < b.l) b.l = tr.p; }
    }
    const cw = Math.max(1, (1000 / span) * liveW * 0.7);
    for (const [sec, b] of buckets) {
      const x = xOf(sec * 1000 + 500);
      if (x < -cw || x > plotW + cw) continue;
      const up = b.c >= b.o;
      ctx.strokeStyle = up ? `${BUY}0.95)` : `${SELL}0.95)`;
      ctx.fillStyle = up ? `${BUY}0.85)` : `${SELL}0.85)`;
      ctx.beginPath(); ctx.moveTo(x, yOf(b.h)); ctx.lineTo(x, yOf(b.l)); ctx.stroke();
      const yO = yOf(b.o), yC = yOf(b.c);
      ctx.fillRect(x - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
    }
  } else if (s.tradeLine && winTrades.length > 1) {
    ctx.strokeStyle = LINE_TX;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    const step = Math.max(1, Math.floor(winTrades.length / (plotW * 2)));
    for (let i = 0; i < winTrades.length; i += step) {
      const tr = winTrades[i];
      const x = xOf(tr.t);
      if (x < -4 || x > plotW + 4) continue;
      const y = yOf(tr.p);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // live-edge dot + last-price tag on the axis
  if (winTrades.length) {
    const lastTr = winTrades[winTrades.length - 1];
    const lx = xOf(lastTr.t), ly = yOf(lastTr.p);
    ctx.fillStyle = lastTr.side === 'buy' ? `${BUY}0.95)` : `${SELL}0.95)`;
    ctx.beginPath(); ctx.arc(Math.min(lx, plotW - 2), ly, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(5, 10, 8, 0.9)';
    ctx.fillRect(plotW, ly - 8, axisWidth, 16);
    ctx.fillStyle = LINE_TX;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(lastTr.p), plotW + 6, ly);
  }

  // ── trade bubbles (notional threshold; radius 3..12, 16x shares the cap) ─
  const autoMin = s.bubbleMin ?? calibrateBubbleMin(trades);
  info.autoMin = autoMin;
  if (s.bubbles && autoMin > 0) {
    for (const tr of winTrades) {
      const value = tr.p * tr.q;
      if (value < autoMin) { info.notPlotted++; continue; }
      const x = xOf(tr.t);
      if (x < -20 || x > plotW + 20) continue;
      const y = yOf(tr.p);
      const r = Math.min(12, 3 + 9 * Math.sqrt(Math.min(16, value / autoMin) / 16));
      const buy = tr.side === 'buy';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = buy ? `${BUY}0.30)` : `${SELL}0.30)`;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = buy ? `${BUY}0.85)` : `${SELL}0.85)`;
      ctx.stroke();
    }
  } else if (s.bubbles) {
    info.notPlotted = winTrades.length;
  }

  // ── reported liquidations: diamonds, venue reports only ───────────────
  if (s.liqs) {
    for (const lq of liqs) {
      if (lq.t < t0 || lq.notional < s.liqMinNotional) continue;
      const x = xOf(lq.t);
      if (x < -20 || x > plotW + 20) continue;
      const y = yOf(lq.p);
      const r = Math.min(11, 3.5 + 2.5 * Math.log10(1 + lq.notional / 10000));
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = lq.side === 'sell' ? `${SELL}0.35)` : `${BUY}0.35)`;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = BRASS;
      ctx.stroke();
    }
  }

  // ── activity strip: per-second buy/sell traded quantity + liq ticks ───
  if (s.activityStrip) {
    const top = plotH;
    ctx.fillStyle = 'rgba(5, 10, 8, 0.72)';
    ctx.fillRect(0, top, plotW, STRIP_H);
    ctx.strokeStyle = 'rgba(61, 77, 68, 0.8)';
    ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(plotW, top + 0.5); ctx.stroke();
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(154, 167, 157, 0.9)';
    ctx.fillText('Traded quantity / second', 6, top + 11);
    ctx.fillStyle = `${BUY}0.9)`; ctx.fillText('Buy', 150, top + 11);
    ctx.fillStyle = `${SELL}0.9)`; ctx.fillText('Sell', 175, top + 11);
    if (winTrades.length) {
      const buckets = new Map<number, { buy: number; sell: number }>();
      let maxVol = 0;
      for (const tr of winTrades) {
        const sec = Math.floor(tr.t / 1000);
        let b = buckets.get(sec);
        if (!b) { b = { buy: 0, sell: 0 }; buckets.set(sec, b); }
        if (tr.side === 'buy') b.buy += tr.q; else b.sell += tr.q;
        const m = Math.max(b.buy, b.sell);
        if (m > maxVol) maxVol = m;
      }
      if (maxVol > 0) {
        const mid = top + 14 + (STRIP_H - 18) / 2;
        const half = (STRIP_H - 20) / 2;
        const bw = Math.max(1.5, (1000 / span) * liveW * 0.6);
        for (const [sec, b] of buckets) {
          const x = xOf(sec * 1000 + 500);
          if (x < -3 || x > plotW + 3) continue;
          const up = (b.buy / maxVol) * half;
          const dn = (b.sell / maxVol) * half;
          ctx.fillStyle = `${BUY}0.75)`;
          if (up > 0.4) ctx.fillRect(x - bw / 2, mid - up, bw, up);
          ctx.fillStyle = `${SELL}0.75)`;
          if (dn > 0.4) ctx.fillRect(x - bw / 2, mid, bw, dn);
        }
      }
      ctx.fillStyle = BRASS;
      for (const lq of liqs) {
        if (lq.t < t0) continue;
        const x = xOf(lq.t);
        if (x < -3 || x > plotW + 3) continue;
        ctx.fillRect(x - 1.5, top + STRIP_H - 5, 3, 4);
      }
    }
  }

  // PAUSED banner (display frozen; recording continues server-side).
  if (s.pause) {
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillStyle = BRASS;
    ctx.fillText('PAUSED — display frozen, recording continues', plotW - 8, 8);
  }

  drawStatusChip(ctx, plotW, plotH + (s.activityStrip ? 0 : 0), status, columns.length);
  ctx.restore();
  return info;
}
