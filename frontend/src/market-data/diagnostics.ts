// ============================================================================
// diagnostics.ts — health / capabilities / quality fetchers (Phase 3 §19–§20).
//
// All values come from the server's measured fields. Nothing here invents
// latency or uptime. Results are cached briefly so the status badge and a
// future health panel can poll without hammering the API.
// ============================================================================

import type { CapabilitiesPayload, HealthPayload } from './types';

const CAPS_TTL_MS = 30_000;
const HEALTH_TTL_MS = 5_000;

let capsCache: { at: number; data: CapabilitiesPayload } | null = null;
let healthCache: { at: number; data: HealthPayload } | null = null;

export async function fetchCapabilities(force = false): Promise<CapabilitiesPayload> {
  if (!force && capsCache && Date.now() - capsCache.at < CAPS_TTL_MS) {
    return capsCache.data;
  }
  const res = await fetch('/api/market-data/capabilities');
  if (!res.ok) throw new Error(`capabilities HTTP ${res.status}`);
  const data = (await res.json()) as CapabilitiesPayload;
  capsCache = { at: Date.now(), data };
  return data;
}

export async function fetchHealth(force = false): Promise<HealthPayload> {
  if (!force && healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) {
    return healthCache.data;
  }
  const res = await fetch('/api/market-data/health');
  if (!res.ok) throw new Error(`health HTTP ${res.status}`);
  const data = (await res.json()) as HealthPayload;
  healthCache = { at: Date.now(), data };
  return data;
}

export async function fetchQuality(): Promise<HealthPayload & {
  checks: string[];
  recent: unknown[];
}> {
  const res = await fetch('/api/market-data/quality');
  if (!res.ok) throw new Error(`quality HTTP ${res.status}`);
  return res.json();
}

export interface ProviderRow {
  provider: string;
  formal: string[];
  configured: boolean;
  l2: boolean;
  l3: boolean;
  state: string;
  lastMsgAgeMs: number | null;
  lastError: string;
  events: number;
  reconnects: number;
  latencyEwmaMs: number | null;
  symbols: string[];
}

/**
 * Join capabilities + health into the health-dashboard row shape.
 * latency / last_msg stay null when unmeasured — never fabricated.
 */
export async function providerRows(): Promise<ProviderRow[]> {
  const [caps, health] = await Promise.all([
    fetchCapabilities(),
    fetchHealth(),
  ]);
  const byProvider = new Map(health.providers.map((p) => [p.provider, p]));
  return caps.providers.map((c) => {
    const h = byProvider.get(c.provider);
    return {
      provider: c.provider,
      formal: c.formal as string[],
      configured: c.configured,
      l2: c.l2,
      l3: c.l3,
      state: h?.state ?? 'DISCONNECTED',
      lastMsgAgeMs: h?.last_msg_age_ms ?? null,
      lastError: h?.last_error ?? '',
      events: h?.events ?? 0,
      reconnects: h?.reconnects ?? 0,
      latencyEwmaMs: h?.latency_ewma_ms ?? null,
      symbols: h?.symbols ?? [],
    };
  });
}

export function clearDiagnosticsCache(): void {
  capsCache = null;
  healthCache = null;
}
