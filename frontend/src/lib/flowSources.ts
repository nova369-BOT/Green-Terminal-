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

  // Dynamic/live catalogs (registered by the engine at runtime): FX perps
  // (EURUSD), gold (XAUUSD) and HIP-3 builder markets (xyz:EURUSD) match by
  // their exact stream id — nothing is attached by similarity.
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
