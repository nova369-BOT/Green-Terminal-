/**
 * Footprint period aggregation (XFlow/ATAS-style per-candle cells).
 *
 * Verified trade prints are grouped into time buckets matching the widget
 * timeframe; inside each period, buy/sell volume is kept per exact traded
 * price with stacked imbalance information, a point of control, and the
 * period delta. Prints without a provider aggressor side are counted but
 * never assigned to a side.
 */

export interface FootprintPrint { tsMs: number; price: number; size: number; side: 'buy' | 'sell' | null; }
export interface FootprintCell { price: number; buy: number; sell: number; }
export interface FootprintPeriod {
  startMs: number;
  cells: FootprintCell[];
  poc: number | null;
  buy: number;
  sell: number;
  delta: number;
}

export const MAX_RETAINED_PRINTS = 3000;
export const FOOTPRINT_PERIODS = 10;
export const FOOTPRINT_CELL_ROWS = 14;

export function timeframeToMs(timeframe: string): number {
  const match = /^(\d+)\s*([smhdw])$/i.exec(timeframe.trim());
  if (!match) return 5 * 60 * 1000;
  const n = Number(match[1]);
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
  const unit = units[match[2].toLowerCase() as keyof typeof units];
  return Number.isFinite(n) && n > 0 ? n * unit : 5 * 60 * 1000;
}

export function bucketPrints(prints: readonly FootprintPrint[], periodMs: number, now: number, periodCount = FOOTPRINT_PERIODS): { periods: FootprintPeriod[]; ignoredNoSide: number } {
  const latestStart = Math.floor(now / periodMs) * periodMs;
  const earliest = latestStart - (periodCount - 1) * periodMs;
  const buckets = new Map<number, { cells: Map<number, FootprintCell>; buy: number; sell: number }>();
  let ignoredNoSide = 0;

  for (const print of prints) {
    if (!Number.isFinite(print.price)) continue;
    const size = Number.isFinite(print.size) ? print.size : 0;
    if (!print.side) { ignoredNoSide += 1; continue; }
    const start = Math.floor(print.tsMs / periodMs) * periodMs;
    if (start < earliest) continue;
    let bucket = buckets.get(start);
    if (!bucket) { bucket = { cells: new Map(), buy: 0, sell: 0 }; buckets.set(start, bucket); }
    const cell = bucket.cells.get(print.price) || { price: print.price, buy: 0, sell: 0 };
    if (print.side === 'buy') { cell.buy += size; bucket.buy += size; }
    else { cell.sell += size; bucket.sell += size; }
    bucket.cells.set(print.price, cell);
  }

  const periods: FootprintPeriod[] = [];
  for (let i = periodCount - 1; i >= 0; i -= 1) {
    const startMs = latestStart - i * periodMs;
    const bucket = buckets.get(startMs);
    const cells = bucket
      ? [...bucket.cells.values()]
          .sort((a, b) => (b.buy + b.sell) - (a.buy + a.sell))
          .slice(0, FOOTPRINT_CELL_ROWS)
          .sort((a, b) => b.price - a.price)
      : [];
    const buy = bucket?.buy || 0;
    const sell = bucket?.sell || 0;
    const poc = cells.length ? cells.reduce((best, cell) => (cell.buy + cell.sell) > (best.buy + best.sell) ? cell : best).price : null;
    periods.push({ startMs, cells, poc, buy, sell, delta: buy - sell });
  }
  return { periods, ignoredNoSide };
}

/** Stacked imbalance: cell buy dominates the cell BELOW by ratio (ATAS rule),
 * or sell dominates the cell ABOVE. Cells are sorted price-descending. */
export function isBuyImbalance(cells: FootprintCell[], index: number, ratio = 3): boolean {
  const below = cells[index + 1];
  if (!below || below.sell <= 0) return false;
  return cells[index].buy / below.sell >= ratio && cells[index].buy > 0;
}

export function isSellImbalance(cells: FootprintCell[], index: number, ratio = 3): boolean {
  const above = cells[index - 1];
  if (!above || above.buy <= 0) return false;
  return cells[index].sell / above.buy >= ratio && cells[index].sell > 0;
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toFixed(value >= 100 ? 0 : value >= 1 ? 2 : 4);
}
