// ============================================================================
// engine/types.ts — Normalized market-data model (Phase 2 primary engine).
//
// DATA SOURCE → NORMALIZED MODEL → CHART ADAPTER → PRIMARY CHART ENGINE → UI
//
// Every source (LSE REST, demo, userdata files, live /api/ws ticks, future
// replay) must produce this shape before it reaches ProChart. The engine
// never depends on a provider's raw row format.
// ============================================================================

/** One OHLCV bar after normalization. Time is always epoch milliseconds. */
export interface NormalizedCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** L1 quote from the data layer (never fabricated beyond provider flags). */
export interface NormalizedQuote {
  bid: number | null;
  ask: number | null;
  /** Provider marked bid/ask as inferred locally from trade prints. */
  synthetic?: boolean;
  ts?: number;
}

/** Live trade/print used to form the active candle. */
export interface NormalizedTick {
  symbol: string;
  price: number;
  /** Epoch ms after normalization. */
  ts: number;
  bid?: number | null;
  ask?: number | null;
  volume?: number | null;
}

/** Session / feed status shown in the instrument header. */
export type SessionStatus = 'open' | 'closed' | 'unknown' | 'loading';

/** Charted instrument snapshot fed to the top instrument bar. */
export interface InstrumentHeaderData {
  symbol: string;
  name?: string;
  provider?: string;
  timeframe?: string;
  chartType?: string;
  price?: number | null;
  prevClose?: number | null;
  change?: number | null;
  changePct?: number | null;
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  volume?: number | null;
  session?: SessionStatus;
  live?: boolean;
}

/**
 * The chart engine's input bundle: normalized series + context.
 * Replay later supplies the same bundle from a different transport.
 */
export interface ChartDataBundle {
  symbol: string;
  provider: string;
  timeframe: string;
  candles: NormalizedCandle[];
  quote?: NormalizedQuote | null;
  /** Epoch ms of the last received tick, if any. */
  lastTickAt?: number | null;
}
