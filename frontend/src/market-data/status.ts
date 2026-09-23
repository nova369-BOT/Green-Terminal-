// ============================================================================
// status.ts — feed status derivation (Phase 3 §15–§17).
//
// The instrument bar and chart must never lie about LIVE vs HISTORICAL.
// Status is derived only from measured facts:
//   - socket ConnectionState
//   - age of last tick
//   - whether the current data window is historical-only or replay
//   - server-side provider health (when refreshed)
// ============================================================================

import { STALE_TICK_MS, getConnection, type MarketDataConnection } from './connection';
import type { FeedStatus, ProviderHealth } from './types';

export interface StatusInput {
  /** Data mode of what the chart is currently showing. */
  mode?: 'live' | 'historical' | 'replay';
  conn?: MarketDataConnection;
  /** Optional server health row for the active provider. */
  providerHealth?: ProviderHealth | null;
}

export interface StatusView {
  status: FeedStatus;
  /** Label for #ib-live — exact strings the shell already uses where possible. */
  label: string;
  /** CSS class hint: open | warn | off | hist */
  tone: 'open' | 'warn' | 'off' | 'hist';
  /** Measured last-tick age (ms) when known. */
  lastTickAgeMs: number | null;
  detail: string;
}

/**
 * Derive the visible feed status.
 *
 * Precedence:
 *  1. REPLAY / HISTORICAL data modes always win — a historical window never
 *     renders as LIVE.
 *  2. Socket DISCONNECTED/ERROR → OFFLINE (or RECONNECTING if the client is
 *     actively retrying).
 *  3. CONNECTED + fresh tick (≤ STALE_TICK_MS) → LIVE.
 *  4. CONNECTED + stale tick → DELAYED.
 *  5. CONNECTING → RECONNECTING.
 */
export function deriveStatus(input: StatusInput = {}): StatusView {
  const conn = input.conn || getConnection();
  const mode = input.mode || 'live';
  const age = conn.lastTickAgeMs();
  const state = conn.getState();
  const health = input.providerHealth || null;

  if (mode === 'replay') {
    return {
      status: 'REPLAY', label: '● REPLAY', tone: 'hist',
      lastTickAgeMs: age, detail: 'bar replay — not a live feed',
    };
  }
  if (mode === 'historical') {
    return {
      status: 'HISTORICAL', label: '● HISTORICAL', tone: 'hist',
      lastTickAgeMs: age, detail: 'downloaded bars — not a live feed',
    };
  }

  if (state === 'ERROR') {
    return {
      status: 'OFFLINE', label: '● OFFLINE', tone: 'off',
      lastTickAgeMs: age, detail: 'connection error',
    };
  }
  if (state === 'DISCONNECTED') {
    return {
      status: 'OFFLINE', label: '● OFFLINE', tone: 'off',
      lastTickAgeMs: age, detail: 'no stream',
    };
  }
  if (state === 'RECONNECTING' || state === 'CONNECTING') {
    return {
      status: 'RECONNECTING', label: '● RECONNECTING', tone: 'warn',
      lastTickAgeMs: age, detail: `socket ${state.toLowerCase()}`,
    };
  }
  if (state === 'DEGRADED') {
    return {
      status: 'DELAYED', label: '● DELAYED', tone: 'warn',
      lastTickAgeMs: age, detail: health?.last_error || 'feed degraded',
    };
  }

  // CONNECTED
  if (age == null) {
    return {
      status: 'DELAYED', label: '● DELAYED', tone: 'warn',
      lastTickAgeMs: null, detail: 'connected, waiting for first tick',
    };
  }
  if (age > STALE_TICK_MS || health?.stale) {
    return {
      status: 'DELAYED', label: '● DELAYED', tone: 'warn',
      lastTickAgeMs: age,
      detail: `no tick for ${Math.round(age / 1000)}s`,
    };
  }
  return {
    status: 'LIVE', label: '● LIVE', tone: 'open',
    lastTickAgeMs: age, detail: `tick ${Math.round(age)}ms ago`,
  };
}

/**
 * Providers that can serve an instrument + capability for streaming.
 * Failover only across capability-compatible providers (shared capabilities).
 */
export function compatibleFailover(
  providers: Array<{ provider: string; formal: string[]; configured: boolean }>,
  required: string[] = ['WEBSOCKET', 'OHLCV']
): string[] {
  return providers
    .filter((p) => p.configured && required.every((c) => p.formal.includes(c)))
    .map((p) => p.provider);
}

/** Pick an explicit source or AUTO: first configured provider with caps. */
export function resolveSource(
  selection: string,
  providers: Array<{ provider: string; formal: string[]; configured: boolean; supports?: (sym: string) => boolean }>,
  symbol?: string
): string | null {
  const capable = providers.filter(
    (p) => p.configured && p.formal.includes('OHLCV') && (!symbol || p.supports?.(symbol) !== false)
  );
  if (selection && selection !== 'AUTO') {
    return capable.some((p) => p.provider === selection) ? selection : null;
  }
  return capable[0]?.provider ?? null;
}
