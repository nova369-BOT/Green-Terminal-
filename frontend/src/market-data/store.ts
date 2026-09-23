// ============================================================================
// store.ts — instrument-scoped store combining history + live (Phase 3 §11–§15).
//
// One store instance per chart pane:
//   - loads historical bars via HistoricalDataService (cancellable)
//   - merges live ticks into the forming candle without duplicates
//   - exposes FeedStatus so the UI never confuses historical with live
// Consumers (mount.tsx, WebSocketContext, status badge) read from here instead
// of talking to providers directly.
// ============================================================================

import { getConnection, type MarketDataConnection } from './connection';
import { getHistory, mergeLive, type HistoryResult } from './history';
import type { ChartCandle, FeedStatus, ProviderHealth, SourceSelection } from './types';
import { deriveStatus, type StatusView } from './status';
import { fetchHealth } from './diagnostics';

export interface SeriesKey {
  provider: string;
  symbol: string;
  timeframe: string;
}

type Listener = () => void;

function bucketStart(ms: number, tf: string): number {
  const table: Record<string, number> = {
    '1s': 1e3, '5s': 5e3, '10s': 1e4, '30s': 3e4,
    '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5,
    '1h': 36e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5,
  };
  const size = table[tf] ?? 36e5;
  return Math.floor(ms / size) * size;
}

export class InstrumentStore {
  private key: SeriesKey | null = null;
  private history: ChartCandle[] = [];
  private liveForming: ChartCandle | null = null;
  private listeners = new Set<Listener>();
  private offTick: (() => void) | null = null;
  private offConn: (() => void) | null = null;
  private loading = false;
  private loadError: string | null = null;
  private lastResult: HistoryResult | null = null;
  private sourceSelection: SourceSelection = 'AUTO';
  private providerHealth: ProviderHealth | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private mode: 'live' | 'historical' | 'replay' = 'live';
  private conn: MarketDataConnection;

  constructor(conn: MarketDataConnection = getConnection()) {
    this.conn = conn;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  getState() {
    return {
      key: this.key,
      candles: this.getMerged(),
      loading: this.loading,
      loadError: this.loadError,
      gaps: this.lastResult?.gaps ?? [],
      quality: this.lastResult?.meta.quality ?? [],
      feed: this.lastResult?.meta.feed ?? 'historical',
      mode: this.mode,
      source: this.sourceSelection,
      status: this.status(),
      providerHealth: this.providerHealth,
      liveForming: this.liveForming,
    };
  }

  /** Merged series for the chart: history + live forming candle. */
  getMerged(): ChartCandle[] {
    return mergeLive(this.history, this.liveForming);
  }

  status(): StatusView {
    return deriveStatus({
      mode: this.mode,
      conn: this.conn,
      providerHealth: this.providerHealth,
    });
  }

  setMode(mode: 'live' | 'historical' | 'replay'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode !== 'live') {
      // Leave live stream but keep history visible.
      this.liveForming = null;
      this.detachTick();
    } else {
      this.attachTick();
    }
    this.emit();
  }

  setSource(sel: SourceSelection): void {
    this.sourceSelection = sel;
    this.emit();
  }

  /**
   * Switch instrument/timeframe. Cancels any in-flight history fetch,
   * resets series, reloads bars, and rewires the live subscription.
   */
  async setSeries(key: SeriesKey, opts: { limit?: number } = {}): Promise<void> {
    const same = this.key
      && this.key.provider === key.provider
      && this.key.symbol === key.symbol
      && this.key.timeframe === key.timeframe;
    if (same) return;

    getHistory().cancel();
    this.key = key;
    this.history = [];
    this.liveForming = null;
    this.loadError = null;
    this.lastResult = null;
    this.loading = true;
    this.emit();

    this.detachTick();
    this.attachTick();
    if (this.mode === 'live') {
      this.conn.subscribe([key.symbol], key.provider);
      this.startHealthPoll();
    }

    try {
      const result = await getHistory().fetch({
        provider: key.provider,
        symbol: key.symbol,
        timeframe: key.timeframe,
        limit: opts.limit ?? 1000,
      });
      if (!this.key
        || this.key.provider !== key.provider
        || this.key.symbol !== key.symbol
        || this.key.timeframe !== key.timeframe) {
        return; // superseded by a newer switch
      }
      this.history = result.candles;
      this.lastResult = result;
      this.loading = false;
      // Historical-only if the feed meta says so or live is off.
      if (result.meta.feed === 'historical' && this.mode === 'live') {
        // keep mode live — status still OFFLINE until ticks arrive
      }
      this.emit();
    } catch (e) {
      if ((e as Error)?.name === 'HistoryAbortedError') return;
      this.loading = false;
      this.loadError = (e as Error)?.message || 'history failed';
      this.emit();
    }
  }

  /** Prepend older bars (infinite scroll). Dedupes against known times. */
  prepend(older: ChartCandle[]): number {
    if (!older.length) return 0;
    const known = new Set(this.history.map((c) => c.time));
    const fresh = older.filter((c) => !known.has(c.time) && (!this.history.length || c.time < this.history[0].time));
    if (!fresh.length) return 0;
    fresh.sort((a, b) => a.time - b.time);
    this.history = fresh.concat(this.history);
    this.emit();
    return fresh.length;
  }

  /** Push a completed historical candle (from shell /api/candles path). */
  setHistory(candles: ChartCandle[]): void {
    this.history = candles;
    this.emit();
  }

  private attachTick(): void {
    if (this.offTick) return;
    this.offTick = this.conn.on('tick', (msg) => {
      if (!this.key || this.mode !== 'live') return;
      if (msg.symbol && msg.symbol !== this.key.symbol) return;
      if (msg.provider && this.key.provider && msg.provider !== this.key.provider) return;
      const price = typeof msg.price === 'number' ? msg.price
        : typeof msg.bid === 'number' ? msg.bid
        : typeof msg.ask === 'number' ? msg.ask
        : null;
      if (price == null || !Number.isFinite(price)) return;
      const ts = typeof msg.recv_ms === 'number' ? msg.recv_ms : Date.now();
      const bucket = bucketStart(
        typeof msg.ts_ms === 'number' ? msg.ts_ms
        : typeof msg.ts === 'number' && (msg.ts as number) > 1e11 ? (msg.ts as number)
        : typeof msg.ts === 'number' ? (msg.ts as number) * 1000
        : ts,
        this.key.timeframe
      );
      const forming: ChartCandle = this.liveForming && this.liveForming.time === bucket
        ? {
            ...this.liveForming,
            high: Math.max(this.liveForming.high, price),
            low: Math.min(this.liveForming.low, price),
            close: price,
          }
        : {
            time: bucket,
            open: this.liveForming?.close ?? price,
            high: price,
            low: price,
            close: price,
          };
      this.liveForming = forming;
      this.emit();
    });
    this.offConn = this.conn.on('connection', () => this.emit());
  }

  private detachTick(): void {
    this.offTick?.();
    this.offTick = null;
    this.offConn?.();
    this.offConn = null;
  }

  private startHealthPoll(): void {
    if (this.healthTimer) return;
    const poll = () => {
      if (!this.key || this.mode !== 'live') return;
      fetchHealth(true)
        .then((h) => {
          this.providerHealth =
            h.providers.find((p) => p.provider === this.key!.provider) ?? null;
          this.emit();
        })
        .catch(() => { /* health is advisory */ });
    };
    poll();
    this.healthTimer = setInterval(poll, 5000);
  }

  /** Full teardown (unmount / global reset). */
  destroy(): void {
    getHistory().cancel();
    this.detachTick();
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.key) this.conn.unsubscribe([this.key.symbol]);
    this.listeners.clear();
  }
}


let storeSingleton: InstrumentStore | null = null;
export function getStore(): InstrumentStore {
  if (!storeSingleton) storeSingleton = new InstrumentStore();
  return storeSingleton;
}
