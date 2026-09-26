// ============================================================================
// engine/barTypes.ts — model for the cTrader-style timeframe "⋮ more" menu
// (see TimeframeMegaSelector.tsx).
//
// The old five-column mega-selector (Standard · Tick · Renko · Range · Heikin
// Ashi) is gone: Tick and Range were always disabled (GT has no tick/range
// aggregation), so they were removed at the user's request. What remains is a
// single popover that opens off a ⋮ button next to the timeframe rail:
//
//   • Bar type   — Standard / Heikin Ashi / Renko (primary) plus Line / Area /
//                  OHLC (secondary). Every one is a real engine render mode.
//   • Timeframe  — grouped Minutes / Hours / Days·Weeks·Months, now extended
//                  past 1w to calendar months (1M · 3M · 6M).
//   • Custom     — build your own (e.g. 45m, 2h, 8M); the engine serves it by
//                  resampling a finer native base (engine/tf_aggregate.py), so
//                  a custom button never draws a fabricated bar.
// ============================================================================

import type { ChartType } from '@/components/chart/core/types';

export interface BarSelection {
  timeframe: string;
  chartType: ChartType;
}

export interface BarType {
  label: string;
  chartType: ChartType;
}

// Primary bar types (the segmented toggle at the top of the menu).
export const BAR_TYPES: BarType[] = [
  { label: 'Standard', chartType: 'candlestick' },
  { label: 'Heikin Ashi', chartType: 'heikinAshi' },
  { label: 'Renko', chartType: 'renko' },
];

// Secondary render styles, so nothing the old chart-type <select> offered is
// lost now that the ⋮ menu is the single control.
export const RENDER_STYLES: BarType[] = [
  { label: 'Line', chartType: 'line' },
  { label: 'Area', chartType: 'area' },
  { label: 'OHLC', chartType: 'bars' },
];

export interface TfGroup {
  label: string;
  tfs: string[];
}

// The proven-serviceable ladder. Native rungs are served directly; the rest
// (45m, 2h, 8h, 1M, 3M, 6M) are aggregated server-side from a finer native, so
// every rung returns real candles.
export const TF_GROUPS: TfGroup[] = [
  { label: 'Minutes', tfs: ['1m', '5m', '15m', '30m', '45m'] },
  { label: 'Hours', tfs: ['1h', '2h', '4h', '8h'] },
  { label: 'Days · Weeks · Months', tfs: ['1d', '1w', '1M', '3M', '6M'] },
];

export interface CustomUnit {
  id: 'm' | 'h' | 'd' | 'w' | 'M';
  label: string;
}

// Units for the custom-timeframe adder. Lower-case m = minutes, capital M =
// calendar months (matching engine/tf_aggregate.py's parser).
export const CUSTOM_UNITS: CustomUnit[] = [
  { id: 'm', label: 'minutes' },
  { id: 'h', label: 'hours' },
  { id: 'd', label: 'days' },
  { id: 'w', label: 'weeks' },
  { id: 'M', label: 'months' },
];

/** Compose a timeframe id from the custom adder, or '' if the input is invalid. */
export function makeCustomTf(amount: number | string, unit: CustomUnit['id']): string {
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${n}${unit}`;
}

const CUSTOM_KEY = 'lset-custom-timeframes';

/** User-added custom timeframes, most-recent first. */
export function loadCustomTfs(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function addCustomTf(tf: string): string[] {
  const next = [tf, ...loadCustomTfs().filter((s) => s !== tf)].slice(0, 12);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch {
    /* session-only if storage is blocked */
  }
  return next;
}

export function removeCustomTf(tf: string): string[] {
  const next = loadCustomTfs().filter((s) => s !== tf);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch {
    /* best effort */
  }
  return next;
}

// Every timeframe the menu shows on a fixed rung (used to tell a custom entry
// apart from a built-in one).
export const BUILTIN_TFS: string[] = TF_GROUPS.flatMap((g) => g.tfs);

const SHORT: Record<string, string> = {
  '1m': 'M1', '5m': 'M5', '15m': 'M15', '30m': 'M30', '45m': 'M45',
  '1h': 'H1', '2h': 'H2', '4h': 'H4', '8h': 'H8',
  '1d': 'D1', '1w': 'W1',
};

/** Compact trigger form of any timeframe id ('1h' → 'H1', '3M' → '3M'). */
export function tfShort(tf: string): string {
  const known = SHORT[tf];
  if (known) return known;
  // Calendar months keep their 'M'; sub-monthly flips to unit-first (45m→M45).
  const mo = /^(\d+)\s*M$/.exec(String(tf || '').trim());
  if (mo) return `${mo[1]}M`;
  const m = /^(\d+)\s*([smhdwy])$/i.exec(String(tf || '').trim());
  if (!m) return String(tf || '').toUpperCase();
  return m[2].toUpperCase() + m[1];
}

function chartPrefix(ct: ChartType): string {
  switch (ct) {
    case 'heikinAshi': return 'HA ';
    case 'renko': return 'RK ';
    case 'line': return 'LN ';
    case 'area': return 'AR ';
    case 'bars': return 'OHLC ';
    default: return '';
  }
}

/** Label for the trigger button, e.g. 'H1', 'HA 15M', 'RK 1M'. */
export function barTriggerLabel(sel: BarSelection): string {
  return chartPrefix(sel.chartType) + tfShort(sel.timeframe);
}
