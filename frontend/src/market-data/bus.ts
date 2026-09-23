// ============================================================================
// bus.ts — client-side MarketDataBus (Phase 3 §9–§10).
//
// Fan-out of normalized events to consumers (chart, watchlist, status, future
// scanners). Ticks arriving from the connection are classified into bus
// event types. UI listeners are never called more often than UI_HZ; the
// connection already rate-limits the socket, and this is the second-stage
// throttle for React-heavy consumers. Data-layer fidelity stays on the
// server bus — this client bus only shapes what the UI paints.
// ============================================================================

import { getConnection, type MarketDataConnection } from './connection';
import type { BusEventType, ConnectionState, ServerMessage } from './types';

export type TickMsg = Extract<ServerMessage, { type: 'tick' }>;

export interface BusQuote {
  symbol: string;
  provider: string;
  price?: number;
  bid?: number;
  ask?: number;
  tsMs: number;
  recvMs: number;
  source: string;
}

export interface BusTrade extends BusQuote {
  size?: number;
}

export interface BusConnectionStatus {
  provider: string;
  state: ConnectionState | string;
}

type Handler<T> = (payload: T) => void;

const UI_HZ = 20; // ≤20 UI notifications/sec per subscriber
const UI_INTERVAL = 1000 / UI_HZ;

/** Throttle a high-frequency handler to UI_HZ while keeping the last value. */
function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = 0;
  let pending: A | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (args: A) => {
    last = Date.now();
    fn(...args);
  };
  return (...args: A) => {
    const now = Date.now();
    if (now - last >= ms) {
      run(args);
      return;
    }
    pending = args;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          const p = pending;
          pending = null;
          run(p);
        }
      }, ms - (now - last));
    }
  };
}

function toTsMs(msg: TickMsg): number {
  const raw = msg.ts_ms ?? msg.ts ?? msg.recv_ms;
  if (typeof raw !== 'number') return msg.recv_ms;
  // s / µs / ns → ms (same heuristic as server to_ms for UI display only).
  if (raw < 1e11) return Math.round(raw * 1000);
  if (raw > 1e14 && raw < 1e16) return Math.round(raw / 1e3);
  if (raw >= 1e16) return Math.round(raw / 1e6);
  return Math.round(raw);
}

/**
 * MarketDataBus singleton. Subscribers register once; the bus owns the
 * connection subscription side-effects for shared symbols.
 */
export class MarketDataBus {
  private conn: MarketDataConnection;
  private quoteH = new Set<Handler<BusQuote>>();
  private tradeH = new Set<Handler<BusTrade>>();
  private connH = new Set<Handler<BusConnectionStatus>>();
  private errorH = new Set<Handler<{ provider: string; message: string }>>();
  private statusH = new Set<Handler<{ state: string }>>();
  private offTick: (() => void) | null = null;
  private offConn: (() => void) | null = null;
  private offStatus: (() => void) | null = null;
  private offError: (() => void) | null = null;

  /** Last quote per symbol (for watchlist paint). */
  private lastQuotes = new Map<string, BusQuote>();

  constructor(conn: MarketDataConnection = getConnection()) {
    this.conn = conn;
  }

  private ensureWired(): void {
    if (this.offTick) return;
    const onTickThrottled = throttle((msg: TickMsg) => this.classifyTick(msg), UI_INTERVAL);
    this.offTick = this.conn.on('tick', onTickThrottled);
    this.offConn = this.conn.on('connection', (state) => {
      for (const fn of this.connH) fn({ provider: '*', state });
    });
    this.offStatus = this.conn.on('status', (msg) => {
      const state = String(msg.state || '');
      for (const fn of this.statusH) fn({ state });
      if (msg.providers) {
        for (const p of msg.providers) {
          for (const fn of this.connH) fn({ provider: p.provider, state: p.state });
        }
      }
    });
    this.offError = this.conn.on('error', (message) => {
      for (const fn of this.errorH) fn({ provider: '*', message });
    });
  }

  private classifyTick(msg: TickMsg): void {
    const tsMs = toTsMs(msg);
    const quote: BusQuote = {
      symbol: String(msg.symbol || ''),
      provider: String(msg.provider || ''),
      price: typeof msg.price === 'number' ? msg.price : undefined,
      bid: typeof msg.bid === 'number' ? msg.bid : undefined,
      ask: typeof msg.ask === 'number' ? msg.ask : undefined,
      tsMs,
      recvMs: typeof msg.recv_ms === 'number' ? msg.recv_ms : Date.now(),
      source: String(msg.feed || msg.provider || 'live'),
    };
    if (quote.symbol) this.lastQuotes.set(quote.symbol, quote);

    // Trade event: has size or explicit trade print semantics.
    const hasSize = typeof msg.size === 'number';
    const trade: BusTrade = { ...quote, size: hasSize ? (msg.size as number) : undefined };
    for (const fn of this.tradeH) fn(trade);
    for (const fn of this.quoteH) fn(quote);
  }

  subscribeQuote(fn: Handler<BusQuote>): () => void {
    this.ensureWired();
    this.quoteH.add(fn);
    return () => { this.quoteH.delete(fn); };
  }

  subscribeTrade(fn: Handler<BusTrade>): () => void {
    this.ensureWired();
    this.tradeH.add(fn);
    return () => { this.tradeH.delete(fn); };
  }

  subscribeConnection(fn: Handler<BusConnectionStatus>): () => void {
    this.ensureWired();
    this.connH.add(fn);
    return () => { this.connH.delete(fn); };
  }

  subscribeStatus(fn: Handler<{ state: string }>): () => void {
    this.ensureWired();
    this.statusH.add(fn);
    return () => { this.statusH.delete(fn); };
  }

  subscribeError(fn: Handler<{ provider: string; message: string }>): () => void {
    this.ensureWired();
    this.errorH.add(fn);
    return () => { this.errorH.delete(fn); };
  }

  getQuote(symbol: string): BusQuote | undefined {
    return this.lastQuotes.get(symbol);
  }

  /** Refcounted stream subscription (delegates to connection). */
  stream(symbols: string[], provider?: string): () => void {
    this.ensureWired();
    this.conn.subscribe(symbols, provider);
    return () => this.conn.unsubscribe(symbols);
  }

  connection(): MarketDataConnection {
    return this.conn;
  }

  /** Event type list for diagnostics (matches server contract). */
  static eventTypes(): BusEventType[] {
    return [
      'QUOTE', 'TRADE', 'CANDLE', 'MARKET_STATUS', 'CONNECTION_STATUS',
      'DATA_ERROR', 'DATA_QUALITY',
      'ORDER_BOOK_SNAPSHOT', 'ORDER_BOOK_UPDATE', 'MBO_EVENT', 'DEPTH_RESET',
      'AUCTION', 'LIQUIDITY_EVENT',
    ];
  }
}

let busSingleton: MarketDataBus | null = null;
export function getBus(): MarketDataBus {
  if (!busSingleton) busSingleton = new MarketDataBus();
  return busSingleton;
}
