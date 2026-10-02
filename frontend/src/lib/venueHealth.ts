/**
 * Per-channel venue health for order-flow failover.
 *
 * A venue multiplexes depth frames and trade prints on one provider, and the
 * two channels fail INDEPENDENTLY: at some networks Binance trades stream
 * fine while the depth snapshot never lands (REST blackhole while the WS
 * ping/pong stays happy). A trades keepalive must never paint depth as
 * healthy — that was the "trade tab works but DOM syncs forever" bug: the
 * shared lastDataMs kept Binance up and the DOM never failed over.
 *
 * Verdicts (per provider+channel):
 *  - fresh DEPTH_RESET with no data inside DATA_DOWN_MS          → down
 *  - a subscription that has NEVER delivered by a grace window   → down
 *    (covers silent hangs that emit no reset to key on), re-armed by each
 *    new 'subscribe' note so a panel swapping back re-detects quickly
 *  - data arrival within the window                              → up
 *
 * This module is React-free on purpose: panels and hooks in flowSources.ts
 * subscribe via listeners, and the logic stays unit-testable with plain
 * node --experimental-strip-types.
 */

export type FlowChannel = 'trades' | 'depth';
export type VenueEventKind = 'data' | 'reset' | 'subscribe';

/** Down-window: resets with no data longer than this → try the next venue. */
export const DATA_DOWN_MS = 15_000;
/** Reset older than this stops mattering (avoids sticky-down on a quiet book). */
export const RESET_FRESH_MS = 45_000;
/** Grace on first subscription before a never-delivered channel counts down. */
export const NEVER_DATA_GRACE_MS = 20_000;
/** Down latch for a never-delivered channel before the panel re-probes. */
export const NEVER_DOWN_PROBE_MS = 60_000;

export interface VenueHealth {
  lastDataMs: number;
  lastResetMs: number;
  lastReason: string;
  /** Timestamp of the latest subscribe note while, so far, nothing has ever
   * been delivered (`lastDataMs === 0`). Drives the silent-hang verdict. */
  firstSeenMs: number;
}

export interface VenueDownVerdict { down: boolean; reason: string }

const venueHealth: Record<string, VenueHealth> = {};
const healthListeners = new Set<() => void>();
let healthVersion = 0;

export function recordVenueEvent(
  provider: string,
  kind: VenueEventKind,
  reason?: string,
  channel: FlowChannel = 'trades',
  now: number = Date.now(),
): void {
  const key = `${provider}:${channel}`;
  const h = venueHealth[key] ?? (venueHealth[key] = { lastDataMs: 0, lastResetMs: 0, lastReason: '', firstSeenMs: now });
  if (kind === 'data') h.lastDataMs = now;
  else if (kind === 'reset') { h.lastResetMs = now; if (reason) h.lastReason = String(reason); }
  else if (h.lastDataMs === 0) h.firstSeenMs = now;
  healthVersion += 1;
  healthListeners.forEach(listener => listener());
}

export function queryVenueDown(provider: string, channel: FlowChannel = 'trades', now: number = Date.now()): VenueDownVerdict {
  const h = venueHealth[`${provider}:${channel}`];
  if (!h) return { down: false, reason: '' };
  const hasData = h.lastDataMs > 0 && now - h.lastDataMs <= DATA_DOWN_MS;
  if (hasData) return { down: false, reason: '' };
  const freshReset = h.lastResetMs > 0 && now - h.lastResetMs < RESET_FRESH_MS;
  if (freshReset) return { down: true, reason: h.lastReason || 'resets with no data' };
  if (h.lastDataMs === 0) {
    const graceAge = now - h.firstSeenMs;
    if (graceAge > NEVER_DATA_GRACE_MS && graceAge < NEVER_DATA_GRACE_MS + NEVER_DOWN_PROBE_MS) {
      return { down: true, reason: h.lastReason || `no ${channel} data ever delivered` };
    }
  }
  return { down: false, reason: '' };
}

/** Raw snapshot for the debug panel — read-only view, no mutation path. */
export function venueHealthSnapshot(): Readonly<Record<string, Readonly<VenueHealth>>> {
  return venueHealth;
}

export function subscribeVenueHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  return () => { healthListeners.delete(listener); };
}

export function getVenueHealthVersion(): number {
  return healthVersion;
}

/** Test-only: clears all recorded health. Never called from panels. */
export function resetVenueHealthForTests(): void {
  Object.keys(venueHealth).forEach(key => { delete venueHealth[key]; });
  healthVersion = 0;
}
