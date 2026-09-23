// ============================================================================
// types.ts — Phase 3 market-data client contract.
//
// Mirrors the server's formal capability model, connection states, and the
// multiplexed /api/market-data/ws wire protocol. Provider-specific wire
// formats never reach this file: everything here is already normalized.
// ============================================================================

/** Formal capabilities (server Capability enum). Never invent L2/L3. */
export type Capability =
  | 'L1_QUOTES'
  | 'TRADES'
  | 'OHLCV'
  | 'HISTORICAL_BARS'
  | 'WEBSOCKET'
  | 'L2'
  | 'L3_MBO'
  | 'OPTIONS'
  | 'GEX'
  | 'REPLAY'
  | 'SEARCH'
  | 'PRICE_BOARD'
  | 'LOGOS'
  | 'SCREENER';

/** ConnectionState contract (server ConnectionState). */
export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'RECONNECTING'
  | 'ERROR';

/**
 * Feed status shown in the UI. Historical/replay must never look live.
 * LIVE only when a live-capable subscription is active and messages are fresh.
 */
export type FeedStatus =
  | 'LIVE'
  | 'DELAYED'
  | 'RECONNECTING'
  | 'OFFLINE'
  | 'HISTORICAL'
  | 'REPLAY';

/** Bus event types. Reserved L2/L3 types exist so clients can switch on them
 *  later without a protocol break — the server never emits fake ones. */
export type BusEventType =
  | 'QUOTE'
  | 'TRADE'
  | 'CANDLE'
  | 'MARKET_STATUS'
  | 'CONNECTION_STATUS'
  | 'DATA_ERROR'
  | 'DATA_QUALITY'
  // Reserved (prepare only — no fake events until a verified feed exists):
  | 'ORDER_BOOK_SNAPSHOT'
  | 'ORDER_BOOK_UPDATE'
  | 'MBO_EVENT'
  | 'DEPTH_RESET'
  | 'AUCTION'
  | 'LIQUIDITY_EVENT';

/** Client → server message on /api/market-data/ws. */
export type ClientMessage =
  | { type: 'subscribe'; provider?: string; symbols: string[] }
  | { type: 'unsubscribe'; symbols: string[] }
  | { type: 'ping' }
  | { type: 'status' };

/** Server → client message union. */
export type ServerMessage =
  | { type: 'hello'; provider?: string; capabilities: CapabilitiesPayload }
  | { type: 'subscribed'; ok: boolean; provider: string; symbols: string[]; state: ConnectionState }
  | { type: 'unsubscribed'; ok: boolean; provider?: string; symbols: string[] }
  | {
      type: 'tick';
      symbol: string;
      provider: string;
      feed: string;
      price?: number;
      bid?: number;
      ask?: number;
      size?: number;
      ts?: number;
      ts_ms?: number;
      recv_ms: number;
      [k: string]: unknown;
    }
  | { type: 'status'; state: ConnectionState | string; providers?: ProviderHealth[] }
  | { type: 'pong'; ts_ms: number }
  | { type: 'error'; message: string };

export interface ProviderCapability {
  provider: string;
  formal: Capability[] | string[];
  legacy?: string[];
  timeframes?: string[];
  configured: boolean;
  l2: boolean;
  l3: boolean;
}

export interface CapabilitiesPayload {
  providers: ProviderCapability[];
  event_types: BusEventType[] | string[];
  depth: { l2: boolean; l3: boolean; note: string };
  models?: string[];
}

export interface ProviderHealth {
  provider: string;
  state: ConnectionState | string;
  configured: boolean;
  last_msg_age_ms: number | null;
  last_error?: string;
  subscriptions?: number;
  events?: number;
  reconnects?: number;
  latency_ewma_ms?: number | null;
  stale?: boolean;
  symbols?: string[];
  capabilities?: string[];
}

export interface HealthPayload {
  overall: string;
  providers: ProviderHealth[];
  rate_limits?: Record<string, unknown>;
  history_cache?: unknown;
  bus?: Record<string, number>;
  stream?: Record<string, number>;
  quality_errors?: number;
  quality_recent?: unknown[];
  uptime_ms?: number;
  ts_ms?: number;
  checks?: string[];
  recent?: unknown[];
}

/** Normalized candle row: [time_ms, open, high, low, close, volume?]. */
export type CandleRow = [number, number, number, number, number, number?];

export interface ChartCandle {
  time: number; // epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface BarsPayload {
  provider: string;
  symbol: string;
  timeframe: string;
  candles: CandleRow[];
  indicators?: Record<string, unknown>;
  meta?: {
    cached?: boolean;
    dropped?: number;
    quality?: string[];
    count?: number;
    error?: string | null;
    feed?: string; // "historical" | "live" | "replay"
  };
}

/** Source selection: AUTO picks the first capable provider for the symbol. */
export type SourceSelection = 'AUTO' | string;

export interface InstrumentRef {
  gt_id: string;
  display_name?: string;
  category?: string;
  provider?: string;
  provider_symbols?: Record<string, string>;
  live?: boolean;
}
