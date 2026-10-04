// ============================================================================
// market-data — Phase 3 client fabric (browser side).
//
// Architecture: DATA PROVIDERS → REST/WS/Replay → adapters → normalization
//               → MarketDataBus → chart / scanner / research.
//
// Exports the shared connection, bus, history service, status derivation,
// diagnostics, store, and React hooks. Provider-specific wire formats never
// enter this package.
// ============================================================================

export * from './types';
export {
  MarketDataConnection,
  getConnection,
  STALE_TICK_MS,
} from './connection';
export type {
  ConnectionListener,
  TickListener,
  StatusListener,
  ErrorListener,
  CapsListener,
} from './connection';
export { MarketDataBus, getBus } from './bus';
export type { BusQuote, BusTrade, BusConnectionStatus } from './bus';
export {
  HistoricalDataService,
  getHistory,
  dedupeSort,
  detectGaps,
  mergeLive,
  timeframeMs,
  HistoryAbortedError,
} from './history';
export type { HistoryRequest, HistoryResult } from './history';
export {
  deriveStatus,
  compatibleFailover,
  resolveSource,
} from './status';
export type { StatusView, StatusInput } from './status';
export {
  fetchCapabilities,
  fetchHealth,
  fetchQuality,
  providerRows,
  clearDiagnosticsCache,
} from './diagnostics';
export type { ProviderRow } from './diagnostics';
export { InstrumentStore, getStore } from './store';
export type { SeriesKey } from './store';
export {
  useLiveQuote,
  useFeedStatus,
  useHistoryBars,
  useInstrumentSeries,
  useCapabilities,
  useProviderRows,
} from './hooks';
