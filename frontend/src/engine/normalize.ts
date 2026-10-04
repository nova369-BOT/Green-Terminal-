// ============================================================================
// engine/normalize.ts — Chart data adapter: raw source rows → Normalized*.
//
// Covers the terminal's real sources:
//   • GET /api/candles rows: [ts, o, h, l, c, v] with ts in epoch seconds
//   • /api/ws tick JSON
//   • shell candle objects that may already be in seconds or ms
// ============================================================================

import type { NormalizedCandle, NormalizedQuote, NormalizedTick } from './types';

/** Below this, a timestamp cannot be ms (would be 1970); treat as seconds. */
export const MS_THRESHOLD = 1e12;

export function toMs(ts: number): number {
  if (!Number.isFinite(ts)) return ts;
  return ts < MS_THRESHOLD ? ts * 1000 : ts;
}

export function toSec(ts: number): number {
  if (!Number.isFinite(ts)) return ts;
  return ts >= MS_THRESHOLD ? Math.floor(ts / 1000) : Math.floor(ts);
}

/** Normalize one API candle row or object. Returns null when unusable. */
export function normalizeCandle(raw: any): NormalizedCandle | null {
  if (!raw) return null;
  let time: number;
  let open: number, high: number, low: number, close: number;
  let volume: number | undefined;
  if (Array.isArray(raw)) {
    if (raw.length < 5) return null;
    [time, open, high, low, close] = raw;
    volume = raw[5] != null ? Number(raw[5]) : undefined;
  } else {
    time = raw.time ?? raw.ts ?? raw.timestamp;
    open = raw.open;
    high = raw.high;
    low = raw.low;
    close = raw.close;
    volume = raw.volume != null ? Number(raw.volume) : undefined;
  }
  if (time == null || ![open, high, low, close].every((n) => Number.isFinite(Number(n)))) {
    return null;
  }
  const t = toMs(Number(time));
  const o = Number(open), h = Number(high), l = Number(low), c = Number(close);
  // Repair inverted high/low only when both sides are finite (corrupt feeds).
  const hi = Math.max(h, o, c, l);
  const lo = Math.min(l, o, c, h);
  return {
    time: t,
    open: o,
    high: hi,
    low: lo,
    close: c,
    volume: volume != null && Number.isFinite(volume) ? volume : undefined,
  };
}

export function normalizeCandles(rows: any[]): NormalizedCandle[] {
  if (!Array.isArray(rows)) return [];
  const out: NormalizedCandle[] = [];
  for (const r of rows) {
    const c = normalizeCandle(r);
    if (c) out.push(c);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export function normalizeQuote(raw: any): NormalizedQuote | null {
  if (!raw) return null;
  const bid = raw.bid != null && Number.isFinite(Number(raw.bid)) ? Number(raw.bid) : null;
  const ask = raw.ask != null && Number.isFinite(Number(raw.ask)) ? Number(raw.ask) : null;
  if (bid == null && ask == null) return null;
  return {
    bid,
    ask,
    synthetic: !!raw.synthetic,
    ts: raw.ts != null ? toMs(Number(raw.ts)) : undefined,
  };
}

export function normalizeTick(raw: any): NormalizedTick | null {
  if (!raw || raw.price == null || !Number.isFinite(Number(raw.price))) return null;
  return {
    symbol: String(raw.symbol || ''),
    price: Number(raw.price),
    ts: raw.ts != null ? toMs(Number(raw.ts)) : Date.now(),
    bid: raw.bid != null ? Number(raw.bid) : null,
    ask: raw.ask != null ? Number(raw.ask) : null,
    volume: raw.volume != null ? Number(raw.volume) : null,
  };
}

/**
 * Merge a live tick into the candle series (mutates a copy of the last bar
 * or appends a new bucket). Volume accumulates when the tick carries size.
 * Returns a NEW array identity when anything changed (React props compare).
 */
export function mergeTickIntoCandles(
  candles: NormalizedCandle[],
  tick: NormalizedTick,
  timeframeId: string,
  opts: { maxBars?: number; stepSeconds: number }
): NormalizedCandle[] {
  if (!opts.stepSeconds) {
    // tick chart: one bar per print
    const bar: NormalizedCandle = {
      time: toMs(toSec(tick.ts)),
      open: tick.price, high: tick.price, low: tick.price, close: tick.price,
      volume: tick.volume ?? 0,
    };
    const next = candles.concat(bar);
    const max = opts.maxBars ?? 20000;
    return next.length > max ? next.slice(-max) : next;
  }
  if (!candles.length) {
    const b = Math.floor(toSec(tick.ts) / opts.stepSeconds) * opts.stepSeconds;
    return [{
      time: toMs(b),
      open: tick.price, high: tick.price, low: tick.price, close: tick.price,
      volume: tick.volume ?? 0,
    }];
  }
  const out = candles.slice();
  const last = { ...out[out.length - 1] };
  const bucket = Math.floor(toSec(tick.ts) / opts.stepSeconds) * opts.stepSeconds;
  const lastSec = toSec(last.time);
  if (bucket > lastSec) {
    out.push({
      time: toMs(bucket),
      open: tick.price, high: tick.price, low: tick.price, close: tick.price,
      volume: tick.volume ?? 0,
    });
  } else {
    last.close = tick.price;
    last.high = Math.max(last.high, tick.price);
    last.low = Math.min(last.low, tick.price);
    if (tick.volume != null && Number.isFinite(tick.volume)) {
      last.volume = (last.volume ?? 0) + tick.volume;
    }
    out[out.length - 1] = last;
  }
  return out;
}

/** Change vs a reference close (session open / previous candle). */
export function priceChange(
  price: number | null | undefined,
  ref: number | null | undefined
): { change: number | null; changePct: number | null } {
  if (price == null || ref == null || !Number.isFinite(price) || !Number.isFinite(ref) || ref === 0) {
    return { change: null, changePct: null };
  }
  const change = price - ref;
  return { change, changePct: (change / ref) * 100 };
}
