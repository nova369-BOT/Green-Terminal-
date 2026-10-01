import type { CapabilitiesPayload, Capability } from '@/market-data/types';
import type { WorkspaceWidgetType } from './workspaceWidgets';

export type WidgetAvailability = 'available' | 'partial' | 'unavailable' | 'unknown';

export interface WidgetCapability {
  availability: WidgetAvailability;
  required: Capability[];
  reason: string;
}

/** Maps UI widgets to formal provider capabilities. Missing capability data
 * stays unknown; it is never treated as permission to fabricate a renderer. */
export function resolveWidgetCapability(
  type: WorkspaceWidgetType,
  caps: CapabilitiesPayload | null,
  provider?: string,
): WidgetCapability {
  const required: Capability[] = type === 'trades' ? ['TRADES']
    : type === 'chart' ? ['OHLCV']
    : type === 'dom' || type === 'orderbook' ? ['L2']
    : type === 'footprint' || type === 'cvdDelta' ? ['TRADES']
    : type === 'heatmap' ? ['L2']
    : type === 'volumeProfile' ? ['HISTORICAL_BARS']
    : type === 'replay' ? ['REPLAY']
    : [];

  if (!required.length) return { availability: 'unknown', required, reason: 'Capability is determined by the widget service.' };
  if (!caps) return { availability: 'unknown', required, reason: 'Provider capabilities have not been loaded.' };
  const row = provider ? caps.providers.find(item => item.provider === provider) : caps.providers.find(item => item.configured);
  if (!row) return { availability: 'unavailable', required, reason: provider ? `Provider ${provider} is not in the capability catalog.` : 'No configured provider advertises this capability.' };
  const advertised = new Set(row.formal.map(value => String(value).toUpperCase()));
  const matched = required.filter(value => advertised.has(value));
  if (matched.length === required.length) return { availability: 'available', required, reason: `${row.provider} advertises ${required.join(', ')}.` };
  if (matched.length) return { availability: 'partial', required, reason: `${row.provider} advertises ${matched.join(', ')} but not ${required.filter(value => !matched.includes(value)).join(', ')}.` };
  return { availability: 'unavailable', required, reason: `${row.provider} does not advertise ${required.join(' or ')}.` };
}
