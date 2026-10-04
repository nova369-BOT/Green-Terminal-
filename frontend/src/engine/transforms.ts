// ============================================================================
// engine/transforms.ts — Deterministic series transforms for chart types.
//
// Heikin Ashi and Renko are pure functions of the candle series so the same
// code can run for live, history and (later) replay without the renderer
// owning market logic.
// ============================================================================

import type { NormalizedCandle } from './types';

/** Heikin Ashi candles derived from standard OHLC (EdgeDepth ChartType=3). */
export function toHeikinAshi(candles: NormalizedCandle[]): NormalizedCandle[] {
  if (!candles.length) return [];
  const out: NormalizedCandle[] = [];
  let prevClose = (candles[0].open + candles[0].close) / 2;
  let prevOpen = prevClose;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0
      ? (c.open + c.close) / 2
      : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    out.push({
      time: c.time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      volume: c.volume,
    });
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return out;
}

/**
 * Renko bricks from the close series with a fixed brick size derived from
 * the median true range of the window (stable under zoom; not redrawn from
 * the visible range alone). Output bars keep source timestamps so time-axis
 * tools still map, but brick OHLC is the brick geometry.
 */
export function toRenko(candles: NormalizedCandle[], brickSize?: number): NormalizedCandle[] {
  if (!candles.length) return [];
  let size = brickSize;
  if (!(size > 0)) {
    // Median TR over up to 144 bars — robust to gaps, independent of zoom.
    const n = Math.min(candles.length, 144);
    const trs: number[] = [];
    for (let i = candles.length - n; i < candles.length; i++) {
      const c = candles[i];
      if (i === 0) { trs.push(c.high - c.low); continue; }
      const prev = candles[i - 1].close;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
    }
    trs.sort((a, b) => a - b);
    const med = trs[Math.floor(trs.length / 2)] || 0;
    size = med > 0 ? med : Math.abs(candles[candles.length - 1].close) * 0.005 || 1;
    if (!(size > 0)) size = 1;
  }
  const out: NormalizedCandle[] = [];
  let brickAnchor = candles[0].close;
  for (let i = 0; i < candles.length; i++) {
    const close = candles[i].close;
    let guard = 0;
    while (Math.abs(close - brickAnchor) >= size && guard++ < 64) {
      const up = close > brickAnchor;
      const open = brickAnchor;
      const end = up ? brickAnchor + size : brickAnchor - size;
      out.push({
        time: candles[i].time,
        open,
        high: Math.max(open, end),
        low: Math.min(open, end),
        close: end,
        volume: candles[i].volume,
      });
      brickAnchor = end;
    }
  }
  return out;
}

/** Apply the display transform for a ChartType (identity for OHLC types). */
export function transformSeries(
  candles: NormalizedCandle[],
  chartType: string
): NormalizedCandle[] {
  if (chartType === 'heikinAshi') return toHeikinAshi(candles);
  if (chartType === 'renko') return toRenko(candles);
  return candles;
}
