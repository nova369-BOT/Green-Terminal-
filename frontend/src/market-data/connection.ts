// ============================================================================
// connection.ts — shared multiplexed WebSocket client (Phase 3 §7–§8).
//
// One browser socket per page talks to /api/market-data/ws. Subscriptions are
// refcounted locally so the chart, watchlist, and status badge share a single
// connection. Reconnect uses exponential backoff and re-sends every active
// subscription on open (resubscribe-on-reconnect). No per-chart reconnect
// logic lives outside this file.
// ============================================================================

import type {
  CapabilitiesPayload,
  ClientMessage,
  ConnectionState,
  ServerMessage,
} from './types';

export type ConnectionListener = (state: ConnectionState, detail?: string) => void;
export type TickListener = (msg: Extract<ServerMessage, { type: 'tick' }>) => void;
export type StatusListener = (msg: Extract<ServerMessage, { type: 'status' }>) => void;
export type ErrorListener = (message: string) => void;
export type CapsListener = (caps: CapabilitiesPayload) => void;

interface SubEntry {
  ref: number;
  provider?: string;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000];
const PING_INTERVAL_MS = 20_000;
/** No tick for this long while CONNECTED → UI may show DELAYED (measured). */
export const STALE_TICK_MS = 15_000;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/market-data/ws`;
}

/**
 * Singleton client connection. Callers subscribe by symbol; provider is an
 * optional hint (AUTO leaves it to the server / first subscribe message).
 */
export class MarketDataConnection {
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'DISCONNECTED';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private manuallyClosed = false;

  /** symbol → refcount (provider hint on first ref). */
  private subs = new Map<string, SubEntry>();
  private pendingSymbols: string[] = [];

  private onConn = new Set<ConnectionListener>();
  private onTick = new Set<TickListener>();
  private onStatus = new Set<StatusListener>();
  private onError = new Set<ErrorListener>();
  private onCaps = new Set<CapsListener>();

  capabilities: CapabilitiesPayload | null = null;
  lastTickMs = 0;
  lastServerStatus: Extract<ServerMessage, { type: 'status' }> | null = null;

  getState(): ConnectionState {
    return this.state;
  }

  /** Measured age of the last tick on this socket (null if none). */
  lastTickAgeMs(): number | null {
    return this.lastTickMs ? Date.now() - this.lastTickMs : null;
  }

  on(event: 'connection', fn: ConnectionListener): () => void;
  on(event: 'tick', fn: TickListener): () => void;
  on(event: 'status', fn: StatusListener): () => void;
  on(event: 'error', fn: ErrorListener): () => void;
  on(event: 'capabilities', fn: CapsListener): () => void;
  on(event: string, fn: (...args: any[]) => void): () => void {
    const set =
      event === 'connection' ? this.onConn
      : event === 'tick' ? this.onTick
      : event === 'status' ? this.onStatus
      : event === 'error' ? this.onError
      : event === 'capabilities' ? this.onCaps
      : null;
    if (!set) return () => {};
    set.add(fn as never);
    return () => { set.delete(fn as never); };
  }

  /**
   * Refcounted subscribe. First ref for a symbol opens the socket if needed
   * and sends {type:'subscribe'}.
   */
  subscribe(symbols: string[], provider?: string): void {
    if (!symbols.length) return;
    let first = false;
    for (const s of symbols) {
      const prev = this.subs.get(s);
      if (prev) {
        prev.ref += 1;
        if (provider && !prev.provider) prev.provider = provider;
      } else {
        this.subs.set(s, { ref: 1, provider });
        first = true;
      }
    }
    if (!first) return;
    this.ensureOpen();
    this.sendSubscribe(symbols, provider);
  }

  /** Decrement refs; send unsubscribe when a symbol's count hits 0. */
  unsubscribe(symbols: string[]): void {
    const drop: string[] = [];
    for (const s of symbols) {
      const e = this.subs.get(s);
      if (!e) continue;
      e.ref -= 1;
      if (e.ref <= 0) {
        this.subs.delete(s);
        drop.push(s);
      }
    }
    if (drop.length && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: 'unsubscribe', symbols: drop });
    }
  }

  /** Active symbols (refcount > 0). */
  activeSymbols(): string[] {
    return [...this.subs.keys()];
  }

  /** Open the socket without symbol subscriptions (status/caps watchers). */
  ensureOpen(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.manuallyClosed = false;
    this.openSocket();
  }

  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.setState('DISCONNECTED');
  }

  requestStatus(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'status' });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private openSocket(): void {
    this.setState(this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      this.setState('ERROR', String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState('CONNECTED');
      // Resubscribe everything that was active (§8 reconnect contract).
      const byProvider = new Map<string, string[]>();
      for (const [sym, entry] of this.subs) {
        const key = entry.provider || '';
        const arr = byProvider.get(key) || [];
        arr.push(sym);
        byProvider.set(key, arr);
      }
      if (!byProvider.size && this.pendingSymbols.length) {
        this.sendSubscribe(this.pendingSymbols);
      }
      for (const [provider, syms] of byProvider) {
        this.sendSubscribe(syms, provider || undefined);
      }
      this.startPing();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onerror = () => {
      // onclose always follows; state transition happens there.
    };

    ws.onclose = () => {
      this.stopPing();
      if (this.ws === ws) this.ws = null;
      if (this.manuallyClosed) {
        this.setState('DISCONNECTED');
        return;
      }
      this.setState('RECONNECTING');
      this.scheduleReconnect();
    };
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello':
        this.capabilities = msg.capabilities;
        for (const fn of this.onCaps) fn(msg.capabilities);
        break;
      case 'tick': {
        this.lastTickMs = Date.now();
        // Track subscribed symbols even if server only echoes some fields.
        if (msg.symbol && !this.subs.has(String(msg.symbol))) {
          // Ignore unsolicited ticks (do not refcount unknown symbols).
        }
        for (const fn of this.onTick) fn(msg);
        break;
      }
      case 'status':
        this.lastServerStatus = msg;
        for (const fn of this.onStatus) fn(msg);
        break;
      case 'error':
        for (const fn of this.onError) fn(msg.message);
        break;
      case 'subscribed':
      case 'unsubscribed':
      case 'pong':
        break;
      default:
        break;
    }
  }

  private sendSubscribe(symbols: string[], provider?: string): void {
    if (!symbols.length) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = provider
        ? { type: 'subscribe', provider, symbols }
        : { type: 'subscribe', symbols };
      this.send(msg);
    } else {
      // Queue until open; openSocket flushes via resubscribe of subs map.
      this.ensureOpen();
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manuallyClosed) this.openSocket();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    for (const fn of this.onConn) fn(state, detail);
  }
}

/** Page-wide singleton. */
let singleton: MarketDataConnection | null = null;
export function getConnection(): MarketDataConnection {
  if (!singleton) singleton = new MarketDataConnection();
  return singleton;
}
