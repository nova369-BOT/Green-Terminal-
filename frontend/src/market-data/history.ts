// ============================================================================
// history.ts — HistoricalDataService client (Phase 3 §11–§13).
//
// - Pagination / range requests against /api/market-data/bars (with /api/candles fallback)
// - Client cache keyed by provider|symbol|timeframe|range
// - Dedupe by candle time; gap detection for scrollback
// - Cancellable on symbol/timeframe switch (AbortController + generation)
// - NEVER merges bars from different timeframes (key includes timeframe)
// - Live+historical merge without duplicate candles on reconnect
// ============================================================================

import type { BarsPayload, CandleRow, ChartCandle } from './types';

export interface HistoryRequest {
  provider: string;
  symbol: string;
  timeframe: string;
  limit?: number;
  /** ISO string or epoch ms — exclusive end (older-than paging). */
  end?: string | number | null;
  start?: string | number | null;
}

export interface HistoryResult {
  candles: ChartCandle[];
  meta: {
    cached: boolean;
    dropped: number;
    quality: string[];
    count: number;
    error: string | null;
    feed: string;
    source: string;
  };
  /** Gaps detected vs expected bar spacing (empty when contiguous). */
  gaps: Array<{ fromMs: number; toMs: number; missingBars: number }>;
}

export class HistoryAbortedError extends Error {
  constructor() {
    super('history request aborted');
    this.name = 'HistoryAbortedError';
  }
}

const TF_MS: Record<string, number> = {
  '1s': 1000, '5s': 5000, '10s': 10000, '30s': 30000,
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000,
  '1M': 2592000000,
};

/** Max cached range-results per key set (LRU-ish). */
const CACHE_MAX = 64;

export function timeframeMs(tf: string): number {
  return TF_MS[tf] ?? 3600000;
}

function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

function rowToCandle(row: CandleRow): ChartCandle {
  const [t, o, h, l, c, v] = row;
  return {
    time: toMs(t),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  };
}

/** Sort + drop duplicate timestamps (keep last write for a timestamp). */
export function dedupeSort(candles: ChartCandle[]): ChartCandle[] {
  if (!candles.length) return candles;
  const byTime = new Map<number, ChartCandle>();
  for (const c of candles) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Detect missing bars larger than one spacing unit. */
export function detectGaps(
  candles: ChartCandle[],
  tf: string
): Array<{ fromMs: number; toMs: number; missingBars: number }> {
  const spacing = timeframeMs(tf);
  const gaps: Array<{ fromMs: number; toMs: number; missingBars: number }> = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta > spacing * 1.5) {
      const missing = Math.max(1, Math.round(delta / spacing) - 1);
      gaps.push({ fromMs: candles[i - 1].time, toMs: candles[i].time, missingBars: missing });
    }
  }
  return gaps;
}

/**
 * Merge live candle into history without duplicates:
 * - same bucket → replace OHLC with live (live close/high/low win, open kept)
 * - newer bucket → append
 * - older or equal already-finalized bar → ignore (no reconnect dups)
 */
export function mergeLive(
  history: ChartCandle[],
  live: ChartCandle | null | undefined
): ChartCandle[] {
  if (!live) return history;
  if (!history.length) return [live];
  const last = history[history.length - 1];
  if (live.time === last.time) {
    const merged: ChartCandle = {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, live.high),
      low: Math.min(last.low, live.low),
      close: live.close,
      volume: (last.volume ?? 0) + (live.volume && live.time !== last.time ? live.volume : 0),
    };
    const out = history.slice();
    out[out.length - 1] = merged;
    return out;
  }
  if (live.time > last.time) return [...history, live];
  // live.time < last.time → historical already covers this bar; drop live.
  return history;
}

interface CacheEntry {
  at: number;
  candles: ChartCandle[];
}

/**
 * Client-side history service. One instance per app is enough; generation
 * tokens cancel in-flight work when the user flips symbol/timeframe.
 */
export class HistoricalDataService {
  private cache = new Map<string, CacheEntry>();
  private gen = 0;
  private inflight: AbortController | null = null;

  /** Bump generation and abort the in-flight request (symbol/TF switch). */
  cancel(): void {
    this.gen += 1;
    if (this.inflight) {
      this.inflight.abort();
      this.inflight = null;
    }
  }

  private cacheKey(req: HistoryRequest): string {
    const end = req.end == null ? '' : String(req.end);
    const start = req.start == null ? '' : String(req.start);
    return `${req.provider}|${req.symbol}|${req.timeframe}|${req.limit ?? 0}|${start}|${end}`;
  }

  /**
   * Fetch bars. Throws HistoryAbortedError if cancel() ran mid-flight.
   * Uses /api/market-data/bars first (Phase 3 fabric), falls back to
   * /api/candles for older servers.
   */
  async fetch(req: HistoryRequest): Promise<HistoryResult> {
    const key = this.cacheKey(req);
    const hit = this.cache.get(key);
    if (hit) {
      return {
        candles: hit.candles,
        meta: {
          cached: true, dropped: 0, quality: [], count: hit.candles.length,
          error: null, feed: 'historical', source: req.provider,
        },
        gaps: detectGaps(hit.candles, req.timeframe),
      };
    }

    this.cancel(); // only one outstanding history request at a time
    const myGen = this.gen;
    const ac = new AbortController();
    this.inflight = ac;

    const params = new URLSearchParams({
      provider: req.provider,
      symbol: req.symbol,
      timeframe: req.timeframe,
      limit: String(req.limit ?? 1000),
    });
    if (req.end != null && req.end !== '') {
      params.set('end', typeof req.end === 'number'
        ? new Date(req.end).toISOString()
        : String(req.end));
    }
    if (req.start != null && req.start !== '') {
      params.set('start', typeof req.start === 'number'
        ? new Date(req.start).toISOString()
        : String(req.start));
    }

    let usedFallback = false;
    let res = await fetch(`/api/market-data/bars?${params.toString()}`, {
      signal: ac.signal,
    });
    if (res.status === 404 || res.status === 405) {
      usedFallback = true;
      res = await fetch(`/api/candles?${params.toString()}`, { signal: ac.signal });
    }

    if (myGen !== this.gen) throw new HistoryAbortedError();

    if (!res.ok) {
      let detail = `history HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.detail) detail = String(body.detail);
      } catch { /* keep status text */ }
      throw new Error(detail);
    }

    const data = (await res.json()) as BarsPayload;
    if (myGen !== this.gen) throw new HistoryAbortedError();

    const candles = dedupeSort((data.candles || []).map(rowToCandle));
    const gaps = detectGaps(candles, req.timeframe);
    const meta = data.meta || {};
    const result: HistoryResult = {
      candles,
      meta: {
        cached: !!meta.cached,
        dropped: meta.dropped ?? 0,
        quality: meta.quality || [],
        count: meta.count ?? candles.length,
        error: meta.error ?? null,
        // Historical must never claim to be live.
        feed: meta.feed && meta.feed !== 'live' ? meta.feed : 'historical',
        source: usedFallback ? data.provider || req.provider : data.provider || req.provider,
      },
      gaps,
    };

    this.cache.set(key, { at: Date.now(), candles });
    if (this.cache.size > CACHE_MAX) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.inflight = null;
    return result;
  }

  /** Drop all cached ranges (e.g. after a provider reconnect). */
  clearCache(): void {
    this.cache.clear();
  }

  cacheSize(): number {
    return this.cache.size;
  }
}

let historySingleton: HistoricalDataService | null = null;
export function getHistory(): HistoricalDataService {
  if (!historySingleton) historySingleton = new HistoricalDataService();
  return historySingleton;
}
