import { useSyncExternalStore } from 'react';

/**
 * Order-flow source resolution.
 *
 * House rule (user, verbatim): chart venue is independent; the order-flow
 * venue is DISCOVERED. BTC on any chart loads only BTC flow; EUR/USD looks
 * for a real EUR/USD contract on Binance or Hyperliquid (incl. HIP-3);
 * nothing found → an honest "no order-flow source" state. Never attach a
 * vaguely related instrument.
 *
 * Today the resolver is driven by the registered capability catalog: the
 * Binance L2 provider explicitly supports BTCUSDT/ETHUSDT/BNBUSDT/SOLUSDT.
 * Live venue catalogs (Binance exchangeInfo, Hyperliquid core + HIP-3 meta)
 * plug into `registerFlowCatalog` once the backend exposes them — the UI
 * contract below already treats availability as data, not assumption.
 */

export interface FlowSource {
  /** Symbol the venue stream expects, e.g. BTCUSDT. */
  stream: string;
  /** Bus provider id for the L2 depth stream. */
  provider: string;
  venue: 'binance' | 'hyperliquid';
  product: string;
  /** Display chip, e.g. `SOURCE · BINANCE BTCUSDT`. */
  label: string;
}

export type FlowResolution =
  | { status: 'resolved'; source: FlowSource }
  | { status: 'none'; reason: string };

interface CatalogEntry { base: string; stream: string; product: string; }

/** Static truth from the registered providers (lse_terminal/providers). */
const BINANCE_DEPTH_PROVIDER = 'binance-depth';
const BINANCE_DEPTH_CATALOG: CatalogEntry[] = [
  { base: 'BTC', stream: 'BTCUSDT', product: 'Binance Spot' },
  { base: 'ETH', stream: 'ETHUSDT', product: 'Binance Spot' },
  { base: 'BNB', stream: 'BNBUSDT', product: 'Binance Spot' },
  { base: 'SOL', stream: 'SOLUSDT', product: 'Binance Spot' },
];

/** Live catalogs merge in here at runtime; keyed by venue → stream entries. */
const dynamicCatalogs: { binance: Set<string>; hyperliquid: Set<string> } = {
  binance: new Set(),
  hyperliquid: new Set(),
};

export function registerFlowCatalog(venue: 'binance' | 'hyperliquid', streams: string[]): void {
  streams.forEach(stream => dynamicCatalogs[venue].add(stream.trim().toUpperCase()));
}

/* ------------------------------------------------------------------ */
/* Live venue catalogs (plan item 13).                                  */
/*                                                                      */
/* The engine's /api/market-data/flow-catalog answers the venue's OWN   */
/* tradable stream set for providers whose transport is symbol-generic   */
/* (today: Binance Spot L2). Panels resolve through this data — never   */
/* through similarity. Offline/unreachable venue ⇒ honest empty catalog  */
/* and resolution falls back to the built-in verified majors only.       */
/* ------------------------------------------------------------------ */

interface FlowCatalogPayload {
  venues?: Array<{ venue?: string; provider?: string; product?: string; streams?: unknown }>;
  reachable?: boolean;
  note?: string;
}

let catalogInit = false;
let catalogTimer: ReturnType<typeof setTimeout> | null = null;
let lastCatalogSummary = '';

/* Catalog version store: bumps on every successful live registration so
 * memoized flow resolutions (DOM, Orderbook, Heatmap) re-evaluate instead of
 * pinning a pre-catalog "no source" answer until the symbol changes. */
const catalogListeners = new Set<() => void>();
let catalogVersion = 0;
function subscribeFlowCatalog(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}
export function useFlowCatalogVersion(): number {
  return useSyncExternalStore(subscribeFlowCatalog, () => catalogVersion);
}

/** What the last catalog fetch actually delivered — surfaced in panel copy. */
export function liveFlowCatalogSummary(): string { return lastCatalogSummary; }

async function pullFlowCatalog(retry: number): Promise<void> {
  try {
    const response = await fetch('/api/market-data/flow-catalog');
    if (!response.ok) throw new Error(`catalog ${response.status}`);
    const payload = (await response.json()) as FlowCatalogPayload;
    let total = 0;
    for (const venue of payload.venues || []) {
      const streams = Array.isArray(venue.streams) ? venue.streams.filter((s): s is string => typeof s === 'string') : [];
      // Only venues the resolver knows how to claim are registered — a venue
      // key outside this map would imply a transport that does not exist.
      if (venue.venue === 'binance' || venue.venue === 'hyperliquid') {
        registerFlowCatalog(venue.venue, streams);
        total += streams.length;
      }
    }
    lastCatalogSummary = payload.reachable ? `${total} live flow streams (Binance Spot)` : (payload.note || 'Flow catalog unreachable — verified majors only');
    catalogVersion += 1;
    catalogListeners.forEach(listener => listener());
    catalogTimer = setTimeout(() => void pullFlowCatalog(0), 300_000); // refresh with the server TTL
  } catch {
    lastCatalogSummary = 'Flow catalog unreachable — verified majors only';
    const backoff = Math.min(300_000, 30_000 * (retry + 1));
    catalogTimer = setTimeout(() => void pullFlowCatalog(retry + 1), backoff);
  }
}

/** Idempotent bootstrap: fetch once, refresh on the server TTL, back off on
 * failure. Returns a disposer for unmount symmetry (timers cleared, already-
 * registered streams stay — they are venue truth, not component state). */
export function initLiveFlowCatalog(): () => void {
  if (!catalogInit) {
    catalogInit = true;
    void pullFlowCatalog(0);
  }
  return () => { if (catalogTimer) { clearTimeout(catalogTimer); catalogTimer = null; catalogInit = false; } };
}

/** Extract a bare base asset from chart symbols like BTC/USD, BTC-USD,
 * BTCUSD, BTCUSDT, btcusdt.P — without touching FX/XAU/stocks semantics. */
function bareBase(symbol: string): { base: string; quote: string } {
  const clean = symbol.trim().toUpperCase().replace(/\.P$/, '').replace(/[-_\s]/g, '/');
  if (clean.includes('/')) {
    const [base, quote = ''] = clean.split('/');
    return { base, quote };
  }
  const suffix = ['USDT', 'USDC', 'USD'].find(s => clean.length > s.length && clean.endsWith(s));
  return suffix ? { base: clean.slice(0, -suffix.length), quote: suffix } : { base: clean, quote: '' };
}

export function resolveFlowSource(symbol: string): FlowResolution {
  if (!symbol || !symbol.trim()) return { status: 'none', reason: 'No active symbol.' };
  const { base, quote } = bareBase(symbol);

  // Explicit Binance L2 catalog: crypto bases quoted in USD-family.
  const entry = BINANCE_DEPTH_CATALOG.find(item => item.base === base);
  if (entry && (!quote || quote === 'USD' || quote === 'USDT' || quote === 'USDC')) {
    return resolved(entry.stream, 'binance', entry.product);
  }

  // Dynamic/live catalogs (registered by the engine at runtime): a crypto
  // base quoted in the USD family maps to its venue stream id — DOGE/USD →
  // DOGEUSDT — only when that exact stream is in the live catalog. HIP-3
  // builder markets (xyz:EURUSD) match by their exact stream id. Nothing is
  // attached by similarity.
  if (!quote || quote === 'USD' || quote === 'USDT' || quote === 'USDC') {
    for (const candidate of [`${base}USDT`, `${base}USDC`]) {
      if (dynamicCatalogs.binance.has(candidate)) return resolved(candidate, 'binance', 'Binance Spot');
    }
  }
  const direct = symbol.trim().toUpperCase().replace(/[-_\s]/g, '').replace('.P', '');
  if (dynamicCatalogs.binance.has(direct)) return resolved(direct, 'binance', 'Binance');
  if (dynamicCatalogs.hyperliquid.has(symbol.trim().toUpperCase())) return resolved(symbol.trim().toUpperCase(), 'hyperliquid', 'Hyperliquid');

  return {
    status: 'none',
    reason: `No order-flow source for ${symbol.trim().toUpperCase()} on Binance or Hyperliquid. The price chart is unaffected.`,
  };
}

function resolved(stream: string, venue: 'binance' | 'hyperliquid', product: string): FlowResolution {
  return {
    status: 'resolved',
    source: {
      stream,
      provider: venue === 'binance' ? BINANCE_DEPTH_PROVIDER : 'hyperliquid',
      venue,
      product,
      label: `SOURCE · ${venue.toUpperCase()} ${stream}`,
    },
  };
}
