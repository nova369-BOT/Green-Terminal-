// ============================================================================
// engine/timeframes.ts — Extensible timeframe catalog.
//
// The ladder is ordered fine → coarse. A timeframe is ENABLED only when the
// active provider advertises it (shell renderTimeframes) or the dataset
// native resolution allows it. Unsupported labels never silently fetch.
// ============================================================================

export interface TimeframeDef {
  /** Provider/API label (matches /api/candles?timeframe=). */
  id: string;
  /** Human button label. */
  label: string;
  /** Bar length in seconds; 0 for tick (event-based). */
  seconds: number;
}

/** Full Phase-2 ladder. Providers opt in via their `timeframes` list. */
export const TIMEFRAMES: TimeframeDef[] = [
  { id: 'tick', label: 'tick', seconds: 0 },
  { id: '1s', label: '1s', seconds: 1 },
  { id: '5s', label: '5s', seconds: 5 },
  { id: '15s', label: '15s', seconds: 15 },
  { id: '30s', label: '30s', seconds: 30 },
  { id: '1m', label: '1m', seconds: 60 },
  { id: '3m', label: '3m', seconds: 180 },
  { id: '5m', label: '5m', seconds: 300 },
  { id: '15m', label: '15m', seconds: 900 },
  { id: '30m', label: '30m', seconds: 1800 },
  { id: '1h', label: '1h', seconds: 3600 },
  { id: '4h', label: '4h', seconds: 14400 },
  { id: '1d', label: '1d', seconds: 86400 },
  { id: '1w', label: '1w', seconds: 604800 },
];

const BY_ID = new Map(TIMEFRAMES.map((t) => [t.id, t]));

export function timeframeSeconds(tf: string): number {
  if (tf === 'tick') return 0;
  const known = BY_ID.get(tf);
  if (known) return known.seconds;
  const m = /^(\d+)([smhdw])$/i.exec(String(tf || '').trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult =
    unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 :
    unit === 'd' ? 86400 : 604800;
  return n * mult;
}

/** Minutes per bar for comparison; 0 = tick/unknown. */
export function timeframeMinutes(tf: string): number {
  const s = timeframeSeconds(tf);
  return s > 0 ? s / 60 : 0;
}

/** True when `finer` can be served from data native to `native`. */
export function canServeTimeframe(finer: string, native: string): boolean {
  const f = timeframeMinutes(finer);
  const n = timeframeMinutes(native);
  if (f <= 0 || n <= 0) return true; // tick or unknown: no divisibility rule
  return f >= n && n > 0 && f % n === 0;
}

/** Provider list ∩ catalog order (unknown provider ids still pass through). */
export function orderProviderTimeframes(providerList: string[]): string[] {
  const rank = new Map(TIMEFRAMES.map((t, i) => [t.id, i]));
  return [...providerList].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a)! : 999;
    const rb = rank.has(b) ? rank.get(b)! : 999;
    return ra - rb;
  });
}

/** Bucket start in epoch seconds for a timestamp on this timeframe. */
export function bucketStart(tsSec: number, tf: string): number {
  const step = timeframeSeconds(tf);
  if (step <= 0) return Math.floor(tsSec);
  return Math.floor(tsSec / step) * step;
}
