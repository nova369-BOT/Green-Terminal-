// ============================================================================
// renderers/rtFlowRenderer.ts — the native Real-time order-flow view.
//
// EdgeDepth's RT view ported onto the LSE chart (unification doctrine: ONE
// chart), at feature parity with the original's settings panel:
//
//   VIEW    Pause display · Trade-price line · Depth ladder · Follow price ·
//           Auto-fit visible history  (follow/auto-fit live in ProChart)
//   DEPTH   Continuous depth bands — each 1 Hz book sample is EXTENDED to the
//           next sample ("sampled book held between updates", exactly the
//           original's wording) · automatic price grouping to readable rows
//   TRADES  Trade bubbles with a sticky auto-calibrated minimum ("Auto size
//           min N"), a Recalibrate hook and an honest "not plotted" count
//   LIQUID. Reported liquidations (real venue reports only) with a minimum-
//           notional filter · bottom activity strip (buy/sell per second +
//           liquidation ticks)
//   SESSION Recorded span/bytes/drops are server truths shown elsewhere.
//
// All functions are PURE: no React state, no fetching — data comes in as
// arguments. Fetching/polling lives in ProChart; toggles live in the shell.
// The status chip is ALWAYS drawn while the mode is on: venue + LIVE, or the
// real reason there is no data. No fake states, ever.
// ============================================================================

import {
  renderL2DepthOverlay,
  type HeatmapRenderContext,
  type HeatmapSnapshot,
} from './heatmapRenderer';

export interface RTTrade { t: number; p: number; q: number; side: 'buy' | 'sell' }
export interface RTLiq { t: number; p: number; q: number; side: 'buy' | 'sell'; notional: number }

export interface RTColumn extends HeatmapSnapshot {
  t: number;
  mid?: number | null;
}

export interface RTViewSettings {
  heatmap: boolean;
  extendDepth: boolean;      // hold each sample until the next one (bands)
  ladder: boolean;
  bubbles: boolean;
  tradeLine: boolean;
  liqs: boolean;
  liqMinNotional: number;    // USD filter for liquidation markers
  activityStrip: boolean;
  bubbleMin: number | null;  // sticky auto-calibrated size floor (null = calibrate now)
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
}

// Live numbers the settings menu displays (grouping, auto min, not-plotted).
export interface RTRenderInfo {
  groupingLabel: string;
  autoMin: number;
  notPlotted: number;
}

// ── time → x mapper (interpolates between candle times; same approach as the
// legacy snapshot renderer, duplicated so that file stays untouched) ────────
function makeTimeMsToX(hx: HeatmapRenderContext): (timeMs: number) => number | null {
  const { candles, visible } = hx;
  return (timeMs: number): number | null => {
    if (candles.length === 0) return null;
    if (timeMs >= candles[candles.length - 1].time) {
      const dt = candles.length > 1 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 60000;
      const diffMs = timeMs - candles[candles.length - 1].time;
      return hx.indexToX((candles.length - 1) + diffMs / Math.max(1000, dt), visible.startIndex);
    }
    if (timeMs <= candles[0].time) {
      const dt = candles.length > 1 ? candles[1].time - candles[0].time : 60000;
      const diffMs = candles[0].time - timeMs;
      return hx.indexToX(0 - diffMs / Math.max(1000, dt), visible.startIndex);
    }
    let low = 0; let high = candles.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (candles[mid].time === timeMs) return hx.indexToX(mid, visible.startIndex);
      else if (candles[mid].time < timeMs) low = mid + 1;
      else high = mid - 1;
    }
    if (high < 0) return hx.indexToX(0, visible.startIndex);
    if (low >= candles.length) return hx.indexToX(candles.length - 1, visible.startIndex);
    const t1 = candles[high].time;
    const t2 = candles[low].time;
    const ratio = (timeMs - t1) / (t2 - t1);
    return hx.indexToX(high + ratio, visible.startIndex);
  };
}

// ── Depth color: EdgeDepth RT's blue liquidity bands. Intensity 0..1 → from
// deep translucent blue to bright cyan-white at the walls. ──────────────────
function depthColor(intensity: number): string {
  const t = Math.min(1, Math.max(0, intensity));
  if (t < 0.25) { const s = t / 0.25; return `rgba(${14 + 10 * s | 0}, ${40 + 40 * s | 0}, ${90 + 70 * s | 0}, ${0.35 + 0.3 * s})`; }
  if (t < 0.55) { const s = (t - 0.25) / 0.3; return `rgba(${24 + 20 * s | 0}, ${80 + 70 * s | 0}, ${160 + 60 * s | 0}, ${0.65 + 0.2 * s})`; }
  if (t < 0.85) { const s = (t - 0.55) / 0.3; return `rgba(${44 + 80 * s | 0}, ${150 + 70 * s | 0}, ${220 + 25 * s | 0}, ${0.85 + 0.1 * s})`; }
  const s = (t - 0.85) / 0.15; return `rgba(${124 + 110 * s | 0}, ${220 + 30 * s | 0}, 245, 0.95)`;
}

// ── Continuous depth bands (the RT heatmap) ─────────────────────────────────
// Each 1 Hz sample paints from its own x to the NEXT sample's x (or, with
// extendDepth, the last one holds to the live edge) — "sampled book held
// between updates". Price levels are grouped into rows sized for legibility;
// the actual grouping is returned for the settings menu to display.
function renderDepthBands(
  hx: HeatmapRenderContext,
  columns: RTColumn[],
  extendDepth: boolean,
): string {
  const { ctx, chartWidth, mainChartHeight, mainPriceToY } = hx;
  if (columns.length === 0) return '—';
  const timeMsToX = makeTimeMsToX(hx);

  // Row grouping: aim for rows ≥ 3 px. Estimate price-per-pixel from two
  // probe points of the y-converter, derive a round bin size from it.
  const pTop = yToPriceApprox(mainPriceToY, 0, mainChartHeight);
  const pBot = yToPriceApprox(mainPriceToY, mainChartHeight, mainChartHeight);
  const span = Math.abs(pTop - pBot);
  if (!(span > 0)) return '—';
  const rawBin = (span / mainChartHeight) * 3;           // ≥3 px per row
  const bin = roundBin(rawBin);
  const binLabel = bin >= 1 ? String(bin) : bin.toPrecision(2);

  // Global max binned size for normalisation (walls stay walls over time).
  let globalMax = 0;
  const binned: { x0: number; x1: number; rows: Map<number, number> }[] = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const x0 = timeMsToX(col.t);
    if (x0 === null) continue;
    let x1: number | null;
    if (i + 1 < columns.length) x1 = timeMsToX(columns[i + 1].t);
    else x1 = extendDepth ? chartWidth : x0 + Math.max(2, (binned.length > 1 ? x0 - binned[binned.length - 1].x0 : 4));
    if (x1 === null) continue;
    if (x1 < -4 || x0 > chartWidth + 4) continue;
    const rows = new Map<number, number>();
    const addSide = (prices?: number[] | any[], sizes?: number[] | any[]) => {
      if (!prices || !sizes) return;
      for (let k = 0; k < prices.length; k++) {
        const key = Math.round(Number(prices[k]) / bin);
        const v = (rows.get(key) || 0) + Number(sizes[k]);
        rows.set(key, v);
        if (v > globalMax) globalMax = v;
      }
    };
    addSide(col.bids_prices, col.bids_sizes);
    addSide(col.asks_prices, col.asks_sizes);
    binned.push({ x0, x1, rows });
  }
  if (globalMax <= 0) return binLabel;

  for (const seg of binned) {
    const w = Math.max(1, seg.x1 - seg.x0);
    for (const [key, size] of seg.rows) {
      const price = key * bin;
      const yTop = mainPriceToY(price + bin / 2);
      const yBot = mainPriceToY(price - bin / 2);
      const y = Math.min(yTop, yBot);
      const h = Math.max(1, Math.abs(yBot - yTop));
      if (y > mainChartHeight || y + h < 0) continue;
      const intensity = Math.pow(size / globalMax, 0.55);
      if (intensity < 0.04) continue;
      ctx.fillStyle = depthColor(intensity);
      ctx.fillRect(seg.x0, y, w + 0.5, h);
    }
  }
  return binLabel;
}

// Approximates the inverse of priceToY by bisection probes (the context only
// hands us the forward converter). Two calls per frame — negligible.
function yToPriceApprox(priceToY: (p: number) => number, targetY: number, height: number): number {
  // Probe a wide bracket around whatever maps on-screen.
  let lo = 1e-9, hi = 1e9;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const y = priceToY(mid);
    if (!Number.isFinite(y)) break;
    // priceToY decreases as price rises.
    if (y > targetY) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function roundBin(raw: number): number {
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

// ── Trade-price line ─────────────────────────────────────────────────────────
function renderTradePriceLine(hx: HeatmapRenderContext, trades: RTTrade[]): void {
  if (trades.length < 2) return;
  const { ctx, chartWidth, mainChartHeight, mainPriceToY } = hx;
  const timeMsToX = makeTimeMsToX(hx);
  ctx.save();
  ctx.strokeStyle = 'rgba(236, 242, 238, 0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  const step = Math.max(1, Math.floor(trades.length / (chartWidth * 2)));
  for (let i = 0; i < trades.length; i += step) {
    const tr = trades[i];
    const x = timeMsToX(tr.t);
    if (x === null || x < -4 || x > chartWidth + 4) continue;
    const y = mainPriceToY(tr.p);
    if (y < -4 || y > mainChartHeight + 4) continue;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // Live-edge dot on the newest print.
  const last = trades[trades.length - 1];
  const lx = timeMsToX(last.t); const ly = mainPriceToY(last.p);
  if (lx !== null && lx >= 0 && lx <= chartWidth) {
    ctx.fillStyle = last.side === 'buy' ? 'rgba(16,185,129,0.95)' : 'rgba(239,68,68,0.95)';
    ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ── Trade bubbles ───────────────────────────────────────────────────────────
// Threshold is NOTIONAL value (price × quantity, quote units) exactly like the
// original's "Auto size"/"Minimum value". Auto = 75th percentile of received
// trade values; sticky until Recalibrate (held by the caller).
export function calibrateBubbleMin(trades: RTTrade[]): number {
  if (trades.length === 0) return 0;
  const values = trades.map((t) => t.p * t.q).sort((a, b) => a - b);
  return values[Math.floor(values.length * 0.75)] || 0;
}

function renderTradeBubbles(
  hx: HeatmapRenderContext,
  trades: RTTrade[],
  minValue: number,
): number {
  if (trades.length === 0 || minValue <= 0) return trades.length;
  const { ctx, chartWidth, mainChartHeight, mainPriceToY } = hx;
  const timeMsToX = makeTimeMsToX(hx);
  let notPlotted = 0;
  ctx.save();
  for (const tr of trades) {
    const value = tr.p * tr.q;
    if (value < minValue) { notPlotted++; continue; }
    const x = timeMsToX(tr.t);
    if (x === null || x < -20 || x > chartWidth + 20) continue;
    const y = mainPriceToY(tr.p);
    if (y < -20 || y > mainChartHeight + 20) continue;
    // Radius 3..12px, sizes above 16x the minimum share the cap (original).
    const r = Math.min(12, 3 + 9 * Math.sqrt(Math.min(16, value / minValue) / 16));
    const buy = tr.side === 'buy';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = buy ? 'rgba(16, 185, 129, 0.30)' : 'rgba(239, 68, 68, 0.30)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = buy ? 'rgba(16, 185, 129, 0.85)' : 'rgba(239, 68, 68, 0.85)';
    ctx.stroke();
  }
  ctx.restore();
  return notPlotted;
}

// ── Reported liquidations: diamonds, venue reports only (original: "Diamonds
// at reported liquidations... missing liquidations are not estimated"). ─────
function renderLiquidations(
  hx: HeatmapRenderContext,
  liqs: RTLiq[],
  minNotional: number,
): void {
  if (liqs.length === 0) return;
  const { ctx, chartWidth, mainChartHeight, mainPriceToY } = hx;
  const timeMsToX = makeTimeMsToX(hx);
  ctx.save();
  for (const lq of liqs) {
    if (lq.notional < minNotional) continue;
    const x = timeMsToX(lq.t);
    if (x === null || x < -20 || x > chartWidth + 20) continue;
    const y = mainPriceToY(lq.p);
    if (y < -20 || y > mainChartHeight + 20) continue;
    const r = Math.min(11, 3.5 + 2.5 * Math.log10(1 + lq.notional / 10000));
    // A long liquidated (side 'sell') prints red-tinted; short (buy) green.
    const fill = lq.side === 'sell' ? 'rgba(239, 68, 68, 0.35)' : 'rgba(16, 185, 129, 0.35)';
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(176, 141, 87, 0.95)';   // brass edge — liquidation mark
    ctx.stroke();
  }
  ctx.restore();
}

// ── Activity strip: per-second buy/sell traded quantity + liq ticks ─────────
const STRIP_H = 46;
function renderActivityStrip(
  hx: HeatmapRenderContext,
  trades: RTTrade[],
  liqs: RTLiq[],
): void {
  const { ctx, chartWidth, mainChartHeight } = hx;
  const timeMsToX = makeTimeMsToX(hx);
  const top = mainChartHeight - STRIP_H;
  ctx.save();
  ctx.fillStyle = 'rgba(5, 10, 8, 0.72)';
  ctx.fillRect(0, top, chartWidth, STRIP_H);
  ctx.strokeStyle = 'rgba(61, 77, 68, 0.8)';
  ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(chartWidth, top + 0.5); ctx.stroke();
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(154, 167, 157, 0.9)';
  ctx.fillText('Traded quantity / second', 6, top + 11);
  ctx.fillStyle = 'rgba(16,185,129,0.9)'; ctx.fillText('Buy', 150, top + 11);
  ctx.fillStyle = 'rgba(239,68,68,0.9)'; ctx.fillText('Sell', 175, top + 11);

  if (trades.length === 0) { ctx.restore(); return; }
  // Bucket per second.
  const buckets = new Map<number, { buy: number; sell: number }>();
  let maxVol = 0;
  for (const tr of trades) {
    const sec = Math.floor(tr.t / 1000);
    let b = buckets.get(sec);
    if (!b) { b = { buy: 0, sell: 0 }; buckets.set(sec, b); }
    if (tr.side === 'buy') b.buy += tr.q; else b.sell += tr.q;
    const m = Math.max(b.buy, b.sell);
    if (m > maxVol) maxVol = m;
  }
  if (maxVol <= 0) { ctx.restore(); return; }
  const mid = top + 14 + (STRIP_H - 18) / 2;
  const half = (STRIP_H - 20) / 2;
  for (const [sec, b] of buckets) {
    const x = timeMsToX(sec * 1000 + 500);
    if (x === null || x < -3 || x > chartWidth + 3) continue;
    const up = (b.buy / maxVol) * half;
    const dn = (b.sell / maxVol) * half;
    ctx.fillStyle = 'rgba(16, 185, 129, 0.75)';
    if (up > 0.4) ctx.fillRect(x - 1, mid - up, 2, up);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.75)';
    if (dn > 0.4) ctx.fillRect(x - 1, mid, 2, dn);
  }
  // Liquidation ticks along the strip base.
  ctx.fillStyle = 'rgba(176, 141, 87, 0.95)';
  for (const lq of liqs) {
    const x = timeMsToX(lq.t);
    if (x === null || x < -3 || x > chartWidth + 3) continue;
    ctx.fillRect(x - 1.5, top + STRIP_H - 5, 3, 4);
  }
  ctx.restore();
}

// ── Status chip — the honest line, always drawn while RT mode is on ─────────
export function renderRTStatusChip(
  hx: HeatmapRenderContext,
  status: RTStatusInfo | null,
  columnsCount: number,
  stripOn: boolean,
): void {
  const { ctx, mainChartHeight } = hx;
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
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const w = Math.min(ctx.measureText(text).width + 22, hx.chartWidth - 16);
  const x = 8;
  const y = mainChartHeight - 24 - (stripOn ? STRIP_H : 0);
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
  ctx.beginPath();
  ctx.rect(x, y, w - 4, 17);
  ctx.clip();
  ctx.fillText(text, x + 17, y + 12);
  ctx.restore();
  ctx.restore();
}

// ── The composed RT view ─────────────────────────────────────────────────────
export function renderRTView(
  hx: HeatmapRenderContext,
  columns: RTColumn[],
  trades: RTTrade[],
  liqs: RTLiq[],
  settings: RTViewSettings,
  status: RTStatusInfo | null,
): RTRenderInfo {
  let groupingLabel = '—';
  if (settings.heatmap && columns.length > 0) {
    groupingLabel = renderDepthBands(hx, columns, settings.extendDepth);
  }
  if (settings.ladder && columns.length > 0) {
    const last = columns[columns.length - 1];
    const bids = (last.bids_prices || []).slice(0, 20).map((p, i) => ({
      price: Number(p), size: Number((last.bids_sizes || [])[i] || 0),
    }));
    const asks = (last.asks_prices || []).slice(0, 20).map((p, i) => ({
      price: Number(p), size: Number((last.asks_sizes || [])[i] || 0),
    }));
    if (bids.length || asks.length) renderL2DepthOverlay(hx, { bids, asks });
  }
  if (settings.tradeLine) renderTradePriceLine(hx, trades);
  const autoMin = settings.bubbleMin ?? calibrateBubbleMin(trades);
  let notPlotted = 0;
  if (settings.bubbles) notPlotted = renderTradeBubbles(hx, trades, autoMin);
  if (settings.liqs) renderLiquidations(hx, liqs, settings.liqMinNotional);
  if (settings.activityStrip) renderActivityStrip(hx, trades, liqs);
  renderRTStatusChip(hx, status, columns.length, settings.activityStrip);
  return { groupingLabel, autoMin, notPlotted };
}
