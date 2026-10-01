import { useMemo, useSyncExternalStore } from 'react';

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

/** Verified Hyperliquid Perp majors (provider: lse_terminal/providers/
 * hyperliquid_depth.py). The stream id is the bare coin, e.g. 'BTC'. */
const HYPERLIQUID_PROVIDER = 'hyperliquid';
const HYPERLIQUID_CATALOG: CatalogEntry[] = [
  { base: 'BTC', stream: 'BTC', product: 'Hyperliquid Perp' },
  { base: 'ETH', stream: 'ETH', product: 'Hyperliquid Perp' },
  { base: 'SOL', stream: 'SOL', product: 'Hyperliquid Perp' },
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
      provider: venue === 'binance' ? BINANCE_DEPTH_PROVIDER : HYPERLIQUID_PROVIDER,
      venue,
      product,
      label: `SOURCE · ${venue.toUpperCase()} ${stream}`,
    },
  };
}

/** Force-resolution for one venue — used by the adaptive failover so the
 * fallback never depends on the primary venue's catalog having an entry. */
export function resolveFlowVenue(symbol: string, venue: 'binance' | 'hyperliquid'): FlowResolution {
  if (!symbol || !symbol.trim()) return { status: 'none', reason: 'No active symbol.' };
  const { base, quote } = bareBase(symbol);
  const usdFamily = !quote || quote === 'USD' || quote === 'USDT' || quote === 'USDC';
  if (!usdFamily) {
    return { status: 'none', reason: `No ${venue} order-flow source for ${symbol.trim().toUpperCase()} (quote ${quote || '?'}).` };
  }
  if (venue === 'hyperliquid') {
    const entry = HYPERLIQUID_CATALOG.find(item => item.base === base);
    if (entry) return resolved(entry.stream, 'hyperliquid', entry.product);
    if (dynamicCatalogs.hyperliquid.has(base)) return resolved(base, 'hyperliquid', 'Hyperliquid Perp');
    return { status: 'none', reason: `No Hyperliquid order-flow source for ${symbol.trim().toUpperCase()}.` };
  }
  const entry = BINANCE_DEPTH_CATALOG.find(item => item.base === base);
  if (entry) return resolved(entry.stream, 'binance', entry.product);
  for (const candidate of [`${base}USDT`, `${base}USDC`]) {
    if (dynamicCatalogs.binance.has(candidate)) return resolved(candidate, 'binance', 'Binance Spot');
  }
  return { status: 'none', reason: `No Binance order-flow source for ${symbol.trim().toUpperCase()}.` };
}

/* ------------------------------------------------------------------ */
/* Venue health + adaptive failover (user directive: "use any available  */
/* data be it binance or hyperliquid").                                  */
/*                                                                      */
/* Health is measured from REAL bus events only: every widget notes every */
/* snapshot/update/tick (`data`) and every DEPTH_RESET (`reset`) it      */
/* sees. A venue is DOWN when its resets keep arriving and no data has   */
/* landed within DATA_DOWN_MS. Panels then swap to the next venue, the   */
/* status chip swaps with them, and a banner states the reason. When    */
/* the primary venue delivers again, resolution snaps back on the next  */
/* health tick.                                                        */
/* ------------------------------------------------------------------ */

interface VenueHealth { lastDataMs: number; lastResetMs: number; lastReason: string }
const venueHealth: Record<string, VenueHealth> = {};
const healthListeners = new Set<() => void>();
let healthVersion = 0;

/** Down-window: resets with no data longer than this ⇒ try the next venue. */
const DATA_DOWN_MS = 15_000;
/** Reset older than this stops mattering (avoids sticky-down on a quiet book). */
const RESET_FRESH_MS = 45_000;

export function noteFlowVenueEvent(provider: string, kind: 'data' | 'reset', reason?: string): void {
  const h = venueHealth[provider] ?? (venueHealth[provider] = { lastDataMs: 0, lastResetMs: 0, lastReason: '' });
  const now = Date.now();
  if (kind === 'data') h.lastDataMs = now;
  else { h.lastResetMs = now; if (reason) h.lastReason = String(reason); }
  healthVersion += 1;
  healthListeners.forEach(listener => listener());
}

export function useFlowVenueHealthVersion(): number {
  return useSyncExternalStore(
    (listener) => { healthListeners.add(listener); return () => { healthListeners.delete(listener); }; },
    () => healthVersion,
  );
}

function venueIsDown(provider: string): { down: boolean; reason: string } {
  const h = venueHealth[provider];
  if (!h || !h.lastResetMs) return { down: false, reason: '' };
  const now = Date.now();
  const hasData = h.lastDataMs > 0 && now - h.lastDataMs <= DATA_DOWN_MS;
  const freshReset = now - h.lastResetMs < RESET_FRESH_MS;
  return { down: !hasData && freshReset, reason: h.lastReason };
}

export interface AdaptiveFlow {
  flow: FlowResolution;
  /** True when the primary Binance venue is down and the panel shows the
   * Hyperliquid Perp fallback — the chip already changed to match. */
  swapped: boolean;
  /** Human sentence for the banner; never shown empty when swapped. */
  swapReason: string;
}

/** The symbol's flow source with venue failover: Binance Spot primary,
 * Hyperliquid Perp when Binance is measurably unreachable. */
export function useAdaptiveFlowSource(symbol: string): AdaptiveFlow {
  const catalogVersion = useFlowCatalogVersion();
  const healthV = useFlowVenueHealthVersion();
  return useMemo(() => {
    const primary = resolveFlowVenue(symbol, 'binance');
    if (primary.status !== 'resolved') return { flow: primary, swapped: false, swapReason: '' };
    const alt = resolveFlowVenue(symbol, 'hyperliquid');
    if (alt.status !== 'resolved') return { flow: primary, swapped: false, swapReason: '' };
    const health = venueIsDown(primary.source.provider);
    if (!health.down) return { flow: primary, swapped: false, swapReason: '' };
    return {
      flow: alt,
      swapped: true,
      swapReason: `Binance unreachable (${health.reason || 'no data'}) — showing Hyperliquid Perp.`,
    };
  }, [symbol, catalogVersion, healthV]);
}
