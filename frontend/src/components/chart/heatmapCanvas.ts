import type { HeatmapFrame } from '@/lib/depthHeatmap';

/**
 * Resting-liquidity heatmap canvas renderer (Bookmap-style price × time).
 *
 * Draws ONLY validated depth frames: columns are time, rows are price levels,
 * color intensity is resting quantity relative to the visible maximum. Trade
 * prints and candle volume never enter this surface.
 */
export interface HeatmapDrawOptions {
  width: number;
  height: number;
  frames: HeatmapFrame[];
  devicePixelRatio?: number;
}

const BID_RGB = '49, 143, 105';
const ASK_RGB = '181, 94, 99';
const MID_COLOR = '#e1b65c';
const GRID_COLOR = '#1e292f';
const LABEL_COLOR = '#71808a';
const MAX_COLUMNS = 240;

export function drawHeatmap(canvas: HTMLCanvasElement, opts: HeatmapDrawOptions): void {
  const dpr = opts.devicePixelRatio || 1;
  const width = Math.max(0, Math.floor(opts.width));
  const height = Math.max(0, Math.floor(opts.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || width < 4 || height < 4) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0d141a';
  ctx.fillRect(0, 0, width, height);

  const frames = opts.frames.slice(-MAX_COLUMNS);
  if (!frames.length) return;

  // Price domain across every visible frame.
  let pMin = Infinity;
  let pMax = -Infinity;
  let qMax = 0;
  for (const frame of frames) {
    for (const level of [...frame.bids, ...frame.asks]) {
      const price = Number(level.price);
      if (!Number.isFinite(price)) continue;
      if (price < pMin) pMin = price;
      if (price > pMax) pMax = price;
      if (level.quantity > qMax) qMax = level.quantity;
    }
  }
  if (!Number.isFinite(pMin) || !Number.isFinite(pMax) || pMax <= pMin || qMax <= 0) return;

  const axisWidth = 64;
  const plotWidth = width - axisWidth;
  if (plotWidth < 8) return;
  const rowHeightPx = 3;
  const rowCount = Math.max(1, Math.floor(height / rowHeightPx));
  const rowForPrice = (price: number) => Math.max(0, Math.min(rowCount - 1, Math.floor(((pMax - price) / (pMax - pMin)) * rowCount)));
  const colWidth = plotWidth / frames.length;

  // Liquidity cells.
  frames.forEach((frame, index) => {
    const x = Math.floor(index * colWidth);
    const w = Math.max(1, Math.ceil(colWidth));
    for (const level of frame.bids) {
      const price = Number(level.price);
      if (!Number.isFinite(price)) continue;
      const alpha = 0.12 + 0.88 * Math.min(1, level.quantity / qMax);
      ctx.fillStyle = `rgba(${BID_RGB}, ${alpha.toFixed(3)})`;
      ctx.fillRect(x, rowForPrice(price) * rowHeightPx, w, rowHeightPx);
    }
    for (const level of frame.asks) {
      const price = Number(level.price);
      if (!Number.isFinite(price)) continue;
      const alpha = 0.12 + 0.88 * Math.min(1, level.quantity / qMax);
      ctx.fillStyle = `rgba(${ASK_RGB}, ${alpha.toFixed(3)})`;
      ctx.fillRect(x, rowForPrice(price) * rowHeightPx, w, rowHeightPx);
    }
  });

  // Price gridlines + right-axis labels (4 ticks).
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i += 1) {
    const price = pMax - ((pMax - pMin) * i) / 4;
    const y = rowForPrice(price) * rowHeightPx + rowHeightPx / 2;
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(plotWidth, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = LABEL_COLOR;
    ctx.fillText(price.toLocaleString(undefined, { maximumFractionDigits: 2 }), plotWidth + 6, y, axisWidth - 8);
  }

  // Current mid line from the freshest frame.
  const last = frames[frames.length - 1];
  const bestBid = last.bids.length ? Number(last.bids[0].price) : NaN;
  const bestAsk = last.asks.length ? Number(last.asks[0].price) : NaN;
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk)) {
    const mid = (bestBid + bestAsk) / 2;
    const y = rowForPrice(mid) * rowHeightPx + rowHeightPx / 2;
    ctx.strokeStyle = MID_COLOR;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(plotWidth, y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = MID_COLOR;
    ctx.fillText(mid.toLocaleString(undefined, { maximumFractionDigits: 2 }), plotWidth + 6, y, axisWidth - 8);
  }
}
