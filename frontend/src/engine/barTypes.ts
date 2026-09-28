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

// Unified chart-type picker (one clean icon grid instead of the old
// segmented-toggle-plus-outlined-pills split). Order mirrors the pro terminals:
// the OHLC family first, then the derived styles.
export interface ChartTypeInfo {
  chartType: ChartType;
  label: string;
  short: string;   // trigger-button prefix vocabulary
  desc: string;    // one-line explainer for the picker's description strip
}

export interface ChartTypeGroup {
  label: string;
  types: ChartTypeInfo[];
}

// The full, grouped chart-type catalogue for the dedicated Bar-style menu.
// Every entry is a real render mode (see ProChart.drawChart + engine/priceCharts).
export const CHART_TYPE_GROUPS: ChartTypeGroup[] = [
  {
    label: 'Bar charts',
    types: [
      { chartType: 'bars', label: 'Bars', short: 'OHLC ', desc: 'OHLC bars — a vertical high–low line with left open and right close ticks.' },
      { chartType: 'candlestick', label: 'Candles', short: '', desc: 'Classic Japanese candlesticks — open, high, low and close per bar.' },
      { chartType: 'hollowCandle', label: 'Hollow candles', short: 'HC ', desc: 'Body is hollow when the close is above the open; colour reflects close vs previous close.' },
      { chartType: 'volumeCandle', label: 'Volume candles', short: 'VC ', desc: 'Candles whose body width scales with the bar’s traded volume.' },
    ],
  },
  {
    label: 'Line charts',
    types: [
      { chartType: 'line', label: 'Line', short: 'LN ', desc: 'Closing prices joined by a single clean line.' },
      { chartType: 'lineMarkers', label: 'Line with markers', short: 'LM ', desc: 'A close line with a dot marking every bar.' },
      { chartType: 'stepLine', label: 'Step line', short: 'ST ', desc: 'Closes joined by horizontal then vertical segments — a staircase.' },
    ],
  },
  {
    label: 'Area charts',
    types: [
      { chartType: 'area', label: 'Area', short: 'AR ', desc: 'A close line with the space beneath it shaded.' },
      { chartType: 'hlcArea', label: 'HLC area', short: 'HL ', desc: 'A shaded band between each bar’s high and low, with the close as a line.' },
      { chartType: 'baseline', label: 'Baseline', short: 'BL ', desc: 'Close line shaded green above / red below a reference level.' },
    ],
  },
  {
    label: 'Japanese / price action',
    types: [
      { chartType: 'heikinAshi', label: 'Heikin Ashi', short: 'HA ', desc: 'Averaged candles that smooth noise to reveal the underlying trend.' },
      { chartType: 'renko', label: 'Renko', short: 'RK ', desc: 'Fixed-size price bricks that ignore time and filter small moves.' },
      { chartType: 'lineBreak', label: 'Line break', short: 'LB ', desc: 'Three-line break: a reversal prints only when the close breaks the prior 3 lines.' },
      { chartType: 'kagi', label: 'Kagi', short: 'KG ', desc: 'A line that flips on a set reversal, switching thick (yang) / thin (yin).' },
      { chartType: 'pointFigure', label: 'Point & Figure', short: 'PF ', desc: 'Columns of X (up) and O (down) that ignore time and small moves.' },
    ],
  },
];

// Flat list + lookups derived from the groups (search, labels, prefixes, descriptions).
export const CHART_TYPES: BarType[] = CHART_TYPE_GROUPS.flatMap((g) =>
  g.types.map((t) => ({ label: t.label, chartType: t.chartType })),
);
const CHART_TYPE_INFO: Record<string, ChartTypeInfo> = Object.fromEntries(
  CHART_TYPE_GROUPS.flatMap((g) => g.types.map((t) => [t.chartType, t])),
);
export const chartTypeLabel = (ct: ChartType): string => CHART_TYPE_INFO[ct]?.label ?? 'Candles';
export const chartTypeDesc = (ct: ChartType): string => CHART_TYPE_INFO[ct]?.desc ?? '';

export interface TfGroup {
  label: string;
  tfs: string[];
}

// The proven-serviceable ladder. Native rungs are served directly; the rest
// (45m, 2h, 8h, 1M, 3M, 6M) are aggregated server-side from a finer native, so
// every rung returns real candles.
export const TF_GROUPS: TfGroup[] = [
  // Seconds are a LIVE tape: the candle API's finest history is 1-minute, so
  // these have no scrollable history — they build forward by bucketing the
  // live trade stream (see app.js onTick / tfBucketStart). Empty until trades
  // arrive; never fabricated.
  { label: 'Seconds', tfs: ['1s', '5s', '10s', '15s', '30s', '45s'] },
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
  return CHART_TYPE_INFO[ct]?.short ?? '';
}

/** Label for the trigger button, e.g. 'H1', 'HA 15M', 'RK 1M'. */
export function barTriggerLabel(sel: BarSelection): string {
  return chartPrefix(sel.chartType) + tfShort(sel.timeframe);
}
