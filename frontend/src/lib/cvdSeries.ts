/**
 * CVD / per-period delta series from verified trade prints.
 *
 * Only provider aggressor side decides buy/sell. Prints without side are
 * counted (ignoredNoSide) and never assigned. A session reset is achieved by
 * the caller clearing the print buffer — the series is a pure function of it.
 */

export interface CvdPrint { tsMs: number; size: number; side: 'buy' | 'sell' | null; }

export interface CvdPeriod { startMs: number; buy: number; sell: number; delta: number; }

export interface CvdSeries {
  periods: CvdPeriod[];
  /** Cumulative delta at the end of each period (same index as periods). */
  cumulative: number[];
  buyTotal: number;
  sellTotal: number;
  ignoredNoSide: number;
}

export function buildCvdSeries(prints: readonly CvdPrint[], periodMs: number, now: number, periodCount = 60): CvdSeries {
  const latestStart = Math.floor(now / periodMs) * periodMs;
  const earliest = latestStart - (periodCount - 1) * periodMs;
  const buckets = new Map<number, { buy: number; sell: number }>();
  let ignoredNoSide = 0;

  for (const print of prints) {
    if (!print.side) { ignoredNoSide += 1; continue; }
    const size = Number.isFinite(print.size) ? print.size : 0;
    const start = Math.floor(print.tsMs / periodMs) * periodMs;
    const bucket = buckets.get(start) || { buy: 0, sell: 0 };
    if (print.side === 'buy') bucket.buy += size; else bucket.sell += size;
    buckets.set(start, bucket);
  }

  // Seed the window with prints older than the earliest slot so the
  // cumulative line starts from the true session delta, not zero.
  let running = 0;
  for (const print of prints) {
    if (!print.side) continue;
    const start = Math.floor(print.tsMs / periodMs) * periodMs;
    if (start < earliest) running += print.side === 'buy' ? (Number.isFinite(print.size) ? print.size : 0) : -(Number.isFinite(print.size) ? print.size : 0);
  }

  const periods: CvdPeriod[] = [];
  const cumulative: number[] = [];
  let buyTotal = 0;
  let sellTotal = 0;
  for (let i = periodCount - 1; i >= 0; i -= 1) {
    const startMs = latestStart - i * periodMs;
    const bucket = buckets.get(startMs);
    const buy = bucket?.buy || 0;
    const sell = bucket?.sell || 0;
    running += buy - sell;
    buyTotal += buy;
    sellTotal += sell;
    periods.push({ startMs, buy, sell, delta: buy - sell });
    cumulative.push(running);
  }
  return { periods, cumulative, buyTotal, sellTotal, ignoredNoSide };
}
