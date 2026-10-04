// ============================================================================
// hooks.ts — React bindings for the market-data client fabric.
//
// All hooks are thin: they subscribe to the singletons (connection / bus /
// history / store) so React re-renders on real measured events only.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getConnection, STALE_TICK_MS } from './connection';
import type { ConnectionState } from './types';
import { getBus, type BusQuote } from './bus';
import { getHistory, type HistoryRequest, type HistoryResult } from './history';
import { deriveStatus, type StatusView } from './status';
import { fetchCapabilities, fetchHealth, providerRows, type ProviderRow } from './diagnostics';
import { getStore, type InstrumentStore, type SeriesKey } from './store';
import type { CapabilitiesPayload, FeedStatus, HealthPayload, ProviderHealth } from './types';

/** Live tick for one symbol (refcounted stream subscription). */
export function useLiveQuote(
  symbol: string | null,
  provider?: string,
  enabled = true
): { quote: BusQuote | null; connected: boolean; lastTickAgeMs: number | null } {
  const [quote, setQuote] = useState<BusQuote | null>(null);
  const [connected, setConnected] = useState(
    () => getConnection().getState() === 'CONNECTED'
  );
  const [tickMs, setTickMs] = useState<number>(0);

  useEffect(() => {
    if (!enabled || !symbol) return;
    const bus = getBus();
    const offStream = bus.stream([symbol], provider);
    const offQuote = bus.subscribeQuote((q) => {
      if (q.symbol === symbol) setQuote(q);
    });
    const offConn = getConnection().on('connection', (s) => {
      setConnected(s === 'CONNECTED');
    });
    const offTick = getConnection().on('tick', (m) => {
      if (!symbol || m.symbol === symbol) setTickMs(Date.now());
    });
    setConnected(getConnection().getState() === 'CONNECTED');
    return () => {
      offQuote();
      offConn();
      offTick();
      offStream();
    };
  }, [symbol, provider, enabled]);

  const lastTickAgeMs = tickMs ? Date.now() - tickMs : null;
  return { quote, connected, lastTickAgeMs };
}

/** Derived feed status (never lies about historical vs live). */
export function useFeedStatus(opts: {
  mode?: 'live' | 'historical' | 'replay';
  provider?: string;
  symbol?: string | null;
  enabled?: boolean;
} = {}): StatusView {
  const mode = opts.mode ?? 'live';
  const provider = opts.provider;
  const symbol = opts.symbol ?? null;
  const enabled = opts.enabled ?? true;
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [connState, setConnState] = useState<ConnectionState>(() => getConnection().getState());
  const [, force] = useState(0);

  useEffect(() => {
    const conn = getConnection();
    const off = conn.on('connection', (s) => setConnState(s));
    return off;
  }, []);

  // Tick age needs a periodic re-render so DELAYED appears without a new tick.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => force((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !provider) {
      setHealth(null);
      return;
    }
    let alive = true;
    const load = () => {
      fetchHealth(true)
        .then((h) => {
          if (!alive) return;
          setHealth(h.providers.find((p) => p.provider === provider) ?? null);
        })
        .catch(() => { if (alive) setHealth(null); });
    };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [provider, enabled]);

  return useMemo(
    () => deriveStatus({ mode, providerHealth: health }),
    // connState/force re-run when socket or age ticker changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, health, connState, symbol]
  );
}

/** Cancellable history fetch for the current series key. */
export function useHistoryBars(req: HistoryRequest | null): {
  result: HistoryResult | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [result, setResult] = useState<HistoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const key = req
    ? `${req.provider}|${req.symbol}|${req.timeframe}|${req.limit ?? 0}|${req.end ?? ''}|${req.start ?? ''}`
    : '';

  useEffect(() => {
    if (!req) return;
    let alive = true;
    setLoading(true);
    setError(null);
    getHistory()
      .fetch(req)
      .then((r) => {
        if (!alive) return;
        setResult(r);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        if ((e as Error)?.name === 'HistoryAbortedError') return;
        setError((e as Error)?.message || 'history failed');
        setLoading(false);
      });
    return () => {
      alive = false;
      // Symbol/TF switch or unmount: abort in-flight so a late response
      // cannot paint the wrong series.
      getHistory().cancel();
    };
  }, [key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { result, loading, error, reload };
}

/** Instrument store bound to a series key (history + live merge + status). */
export function useInstrumentSeries(key: SeriesKey | null, auto = true): {
  candles: ReturnType<InstrumentStore['getMerged']>;
  loading: boolean;
  loadError: string | null;
  status: StatusView;
  gaps: HistoryResult['gaps'];
  source: string;
  setSource: (s: string) => void;
  setMode: (m: 'live' | 'historical' | 'replay') => void;
  prepend: (older: ReturnType<InstrumentStore['getMerged']>) => number;
  store: InstrumentStore;
} {
  const store = getStore();
  const version = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState()
  );
  const s = version; // snapshot object identity changes on emit

  useEffect(() => {
    if (!key || !auto) return;
    void store.setSeries(key);
    return () => { /* keep series; setSeries cancels prior on next key */ };
  }, [key?.provider, key?.symbol, key?.timeframe, auto]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    candles: s.candles,
    loading: s.loading,
    loadError: s.loadError,
    status: store.status(),
    gaps: s.gaps,
    source: s.source,
    setSource: (sel: string) => store.setSource(sel),
    setMode: (m) => store.setMode(m),
    prepend: (older) => store.prepend(older),
    store,
  };
}

/** Formal capability matrix (cached client-side). */
export function useCapabilities(): { caps: CapabilitiesPayload | null; error: string | null; reload: () => void } {
  const [caps, setCaps] = useState<CapabilitiesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchCapabilities(nonce > 0)
      .then((c) => { if (alive) { setCaps(c); setError(null); } })
      .catch((e) => { if (alive) setError(String(e?.message || e)); });
    return () => { alive = false; };
  }, [nonce]);

  return { caps, error, reload: () => setNonce((n) => n + 1) };
}

/** Health dashboard rows (real measured values only). */
export function useProviderRows(pollMs = 0): { rows: ProviderRow[]; error: string | null } {
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      providerRows()
        .then((r) => { if (alive) { setRows(r); setError(null); } })
        .catch((e) => { if (alive) setError(String(e?.message || e)); });
    };
    load();
    if (pollMs > 0) {
      const id = setInterval(load, pollMs);
      return () => { alive = false; clearInterval(id); };
    }
    return () => { alive = false; };
  }, [pollMs, nonce]);

  return { rows, error };
}

export type { HealthPayload, FeedStatus };

/**
 * Alias used by WebSocketContext: raw tick + connection flag for useLiveTick.
 * Does not invent prices — price stays undefined when the frame has none.
 */
export function useMarketFeed(
  symbol: string | null,
  provider?: string,
  enabled = true
): {
  tick: {
    symbol: string;
    price?: number;
    bid?: number;
    ask?: number;
    size?: number;
    ts_ms?: number;
    ts?: number;
    recv_ms: number;
    provider?: string;
    feed?: string;
  } | null;
  isConnected: boolean;
  quote: BusQuote | null;
} {
  const { quote, connected } = useLiveQuote(symbol, provider, enabled);
  const [tick, setTick] = useState<ReturnType<typeof useMarketFeed>['tick']>(null);

  useEffect(() => {
    if (!enabled || !symbol) {
      setTick(null);
      return;
    }
    const conn = getConnection();
    const off = conn.on('tick', (m) => {
      if (m.symbol && m.symbol !== symbol) return;
      setTick({
        symbol: String(m.symbol || symbol),
        price: typeof m.price === 'number' ? m.price : undefined,
        bid: typeof m.bid === 'number' ? m.bid : undefined,
        ask: typeof m.ask === 'number' ? m.ask : undefined,
        size: typeof m.size === 'number' ? m.size : undefined,
        ts_ms: typeof m.ts_ms === 'number' ? m.ts_ms : undefined,
        ts: typeof m.ts === 'number' ? m.ts : undefined,
        recv_ms: m.recv_ms,
        provider: String(m.provider || '') || undefined,
        feed: String(m.feed || '') || undefined,
      });
    });
    return () => off();
  }, [symbol, enabled]);

  return { tick, isConnected: connected && !!symbol, quote };
}
