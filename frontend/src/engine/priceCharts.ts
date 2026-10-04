// ============================================================================
// engine/priceCharts.ts — time-independent "price action" chart transforms.
//
// Line break, Kagi and Point & Figure ignore the calendar and only advance when
// price moves enough. These are pure functions of the price series, computed
// once and rendered as their own left-to-right sequence (see ProChart.drawChart).
// Rules follow the standard definitions:
//   • Three-line break — reversal only when the close breaks the high/low of the
//     prior N lines (default 3).  (TradingView / StockCharts)
//   • Kagi — the line reverses when price moves against it by the reversal
//     amount, switching thick (yang, above the prior shoulder) / thin (yin,
//     below the prior waist).
//   • Point & Figure — columns of X (up) / O (down) in fixed box steps, a new
//     column only after a `reversal`-box move the other way.
// ============================================================================

/** Median absolute change between consecutive closes — a volatility unit that
 *  adapts the brick / box / reversal sizes to any instrument. */
export function medianStep(closes: number[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = Math.abs(closes[i] - closes[i - 1]);
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) {
    const p = Math.abs(closes[closes.length - 1] || 1);
    return p * 0.005 || 1;
  }
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || 1;
}

// ── Three-line break ────────────────────────────────────────────────────────
export interface LBLine { up: boolean; top: number; bottom: number; }

export function toLineBreak(closes: number[], n = 3): LBLine[] {
  if (closes.length < 2) return [];
  const lines: LBLine[] = [];
  // Seed on the first close that differs from the first.
  let i = 1;
  while (i < closes.length && closes[i] === closes[0]) i++;
  if (i >= closes.length) return [];
  const up0 = closes[i] > closes[0];
  lines.push({
    up: up0,
    top: Math.max(closes[0], closes[i]),
    bottom: Math.min(closes[0], closes[i]),
  });
  for (let k = i + 1; k < closes.length; k++) {
    const c = closes[k];
    const last = lines[lines.length - 1];
    const look = lines.slice(Math.max(0, lines.length - n));
    const lowN = Math.min(...look.map((l) => l.bottom));
    const highN = Math.max(...look.map((l) => l.top));
    if (last.up) {
      if (c > last.top) lines.push({ up: true, bottom: last.top, top: c });
      else if (c < lowN) lines.push({ up: false, top: last.bottom, bottom: c });
    } else {
      if (c < last.bottom) lines.push({ up: false, top: last.bottom, bottom: c });
      else if (c > highN) lines.push({ up: true, bottom: last.top, top: c });
    }
  }
  return lines;
}

// ── Kagi ────────────────────────────────────────────────────────────────────
export interface KagiResult { vertices: number[]; thick: boolean[]; }

export function toKagi(closes: number[], reversalAbs?: number): KagiResult {
  if (closes.length < 2) return { vertices: [], thick: [] };
  const rev = reversalAbs && reversalAbs > 0 ? reversalAbs : medianStep(closes) * 3;
  const vertices: number[] = [closes[0]];
  let dir = 0;            // +1 up, -1 down, 0 undecided
  let cur = closes[0];    // running extreme of the current leg
  for (let k = 1; k < closes.length; k++) {
    const c = closes[k];
    if (dir === 0) {
      if (Math.abs(c - cur) >= rev) { dir = c > cur ? 1 : -1; cur = c; vertices.push(c); }
      else cur = c > cur ? c : cur; // hold until first real move (extend high) — cur tracks
      continue;
    }
    if (dir === 1) {
      if (c > cur) { cur = c; vertices[vertices.length - 1] = c; }
      else if (cur - c >= rev) { dir = -1; cur = c; vertices.push(c); }
    } else {
      if (c < cur) { cur = c; vertices[vertices.length - 1] = c; }
      else if (c - cur >= rev) { dir = 1; cur = c; vertices.push(c); }
    }
  }
  // Per-segment thickness: yang (thick) once the line rises above the prior
  // shoulder (last local peak), yin (thin) once it falls below the prior waist.
  const thick: boolean[] = [];
  let lastPeak = -Infinity;
  let lastTrough = Infinity;
  let isThick = false;
  for (let v = 1; v < vertices.length; v++) {
    const a = vertices[v - 1];
    const b = vertices[v];
    if (b > a) { // up leg
      if (b > lastPeak && lastPeak !== -Infinity) isThick = true;
      lastTrough = Math.min(lastTrough, a);
    } else {     // down leg
      if (b < lastTrough && lastTrough !== Infinity) isThick = false;
      lastPeak = Math.max(lastPeak === -Infinity ? a : lastPeak, a);
    }
    if (lastPeak === -Infinity) lastPeak = a;
    if (lastTrough === Infinity) lastTrough = a;
    thick.push(isThick);
  }
  return { vertices, thick };
}

// ── Point & Figure ──────────────────────────────────────────────────────────
export interface PFColumn { up: boolean; boxes: number[]; } // boxes = price level of each cell (ascending)

export function toPointFigure(
  candles: { high: number; low: number; close: number }[],
  box?: number,
  reversal = 3,
): { columns: PFColumn[]; box: number } {
  if (candles.length < 2) return { columns: [], box: box || 1 };
  const closes = candles.map((c) => c.close);
  const b = box && box > 0 ? box : medianStep(closes);
  const columns: PFColumn[] = [];
  const levels = (lo: number, hi: number): number[] => {
    const out: number[] = [];
    const start = Math.ceil(lo / b) * b;
    for (let p = start; p <= hi + 1e-9; p += b) out.push(Number(p.toFixed(6)));
    return out;
  };
  let dir = 0; // +1 X (up), -1 O (down)
  let colTop = candles[0].close;
  let colBottom = candles[0].close;
  for (let k = 1; k < candles.length; k++) {
    const hi = candles[k].high;
    const lo = candles[k].low;
    if (dir === 0) {
      if (hi - colBottom >= b) { dir = 1; colTop = hi; colBottom = candles[k - 1].close; columns.push({ up: true, boxes: levels(colBottom, colTop) }); }
      else if (colTop - lo >= b) { dir = -1; colBottom = lo; colTop = candles[k - 1].close; columns.push({ up: false, boxes: levels(colBottom, colTop) }); }
      continue;
    }
    const col = columns[columns.length - 1];
    if (dir === 1) {
      if (hi >= colTop + b) { colTop = Math.floor(hi / b) * b; col.boxes = levels(colBottom, colTop); }
      else if (colTop - lo >= reversal * b) { // reversal down → new O column
        dir = -1; const newTop = colTop - b; colBottom = Math.ceil(lo / b) * b; colTop = newTop;
        columns.push({ up: false, boxes: levels(colBottom, colTop) });
      }
    } else {
      if (lo <= colBottom - b) { colBottom = Math.ceil(lo / b) * b; col.boxes = levels(colBottom, colTop); }
      else if (hi - colBottom >= reversal * b) { // reversal up → new X column
        dir = 1; const newBottom = colBottom + b; colTop = Math.floor(hi / b) * b; colBottom = newBottom;
        columns.push({ up: true, boxes: levels(colBottom, colTop) });
      }
    }
  }
  return { columns, box: b };
}
