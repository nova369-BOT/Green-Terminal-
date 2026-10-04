// ============================================================================
// renderers/rtFlowRenderer.ts — the native Real-time order-flow view.
//
// EdgeDepth's RT view ported onto the LSE chart (unification doctrine: ONE
// chart). Draws, from data recorded live by the engine (/api/rt/flow):
//   1. Depth heatmap   — 1 Hz order-book columns (reuses the Bookmap-style
//                        renderer that already lived in heatmapRenderer.ts)
//   2. Trade-price line — polyline through real venue prints
//   3. Trade bubbles    — large prints as circles, sized by quantity,
//                        colored by the VENUE's aggressor flag (never
//                        inferred from price movement)
//   4. Depth ladder     — current bid/ask bars (reuses renderL2DepthOverlay)
//   5. Status chip      — ALWAYS honest: venue + LIVE, or the real reason
//                        there is no data. No fake states.
//
// All functions are PURE: no React state, no fetching — data comes in as
// arguments. Fetching/polling lives in ProChart.
// ============================================================================

import {
  renderOrderBookHeatmap,
  renderL2DepthOverlay,
  type HeatmapRenderContext,
  type HeatmapSnapshot,
} from './heatmapRenderer';

export interface RTTrade { t: number; p: number; q: number; side: 'buy' | 'sell' }

export interface RTColumn extends HeatmapSnapshot {
  t: number;
  mid?: number | null;
}

export interface RTViewSettings {
  heatmap: boolean;
  ladder: boolean;
  bubbles: boolean;
  tradeLine: boolean;
}

export interface RTStatusInfo {
  flow?: 'ok' | 'none' | 'error' | string;
  coin?: string | null;
  venue?: string | null;
  connected?: boolean;
  error?: string | null;
  reason?: string | null;
}

// Maps an absolute ms timestamp to an X pixel by interpolating between candle
// times (same approach as renderOrderBookHeatmap's internal mapper; duplicated
// here deliberately so the dormant legacy renderer stays byte-for-byte
// untouched while the RT view evolves).
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

// ── Trade-price line ─────────────────────────────────────────────────────────
function renderTradePriceLine(hx: HeatmapRenderContext, trades: RTTrade[]): void {
  if (trades.length < 2) return;
  const { ctx, chartWidth, mainChartHeight, mainPriceToY } = hx;
  const timeMsToX = makeTimeMsToX(hx);
  ctx.save();
  ctx.strokeStyle = 'rgba(236, 242, 238, 0.78)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  // Light decimation: at most ~2 points per pixel keeps the stroke cheap even
  // with thousands of prints buffered.
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
  ctx.restore();
}

// ── Trade bubbles ────────────────────────────────────────────────────────────
// Auto threshold: a print is a bubble when it is in the top decile of sizes in
// the recorded window (EdgeDepth's "Auto size" spirit; an explicit Settings
// threshold can override this later).
function renderTradeBubbles(hx: HeatmapRenderContext, trades: RTTrade[]): void {
  if (trades.length === 0) return;
  const { ctx, chartWidth, mainChartHeight, mainPriceToY } = hx;
  const sizes = trades.map((t) => t.q).sort((a, b) => a - b);
  const threshold = sizes[Math.floor(sizes.length * 0.9)] || 0;
  if (threshold <= 0) return;
  const timeMsToX = makeTimeMsToX(hx);
  ctx.save();
  for (const tr of trades) {
    if (tr.q < threshold) continue;
    const x = timeMsToX(tr.t);
    if (x === null || x < -20 || x > chartWidth + 20) continue;
    const y = mainPriceToY(tr.p);
    if (y < -20 || y > mainChartHeight + 20) continue;
    const r = Math.min(16, 2.5 + 5 * Math.sqrt(tr.q / threshold));
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
}

// ── Status chip — the honest line, always drawn while RT mode is on ─────────
export function renderRTStatusChip(
  hx: HeatmapRenderContext,
  status: RTStatusInfo | null,
  columnsCount: number,
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
    text = `RT · ${String(status.venue).toUpperCase()} · LIVE · ${columnsCount} cols`;
    dot = '#2dd4a0';
  }
  // Long honest errors stay honest but readable: keep the head of the
  // message (venue + root cause), elide the rest.
  if (text.length > 130) text = text.slice(0, 129) + '…';
  ctx.save();
  // Explicit alignment: the axis renderers leave textAlign at 'center'/'right'
  // and an inherited value shifts the whole chip text off the box.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  const w = Math.min(ctx.measureText(text).width + 22, hx.chartWidth - 16);
  const x = 8;
  const y = mainChartHeight - 24;
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
  // Clip overlong honest messages to the chip width.
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
  settings: RTViewSettings,
  status: RTStatusInfo | null,
): void {
  if (settings.heatmap && columns.length > 0) {
    renderOrderBookHeatmap(hx, columns);
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
  if (settings.bubbles) renderTradeBubbles(hx, trades);
  renderRTStatusChip(hx, status, columns.length);
}
