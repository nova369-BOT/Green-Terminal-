// ============================================================================
// engine/barTypes.ts — Single source of truth for the cTrader-style timeframe /
// bar-type mega-selector (see TimeframeMegaSelector.tsx).
//
// GT charts are built from OHLC candles, so the natural adaptation of
// cTrader's five columns is: COLUMN = bar type, ROW = timeframe.
//
//   Standard    → candlestick   (live)
//   Tick        → —             (needs a tick data feed; rendered but disabled)
//   Renko       → renko         (live)
//   Range       → —             (needs finer-than-candle data; disabled)
//   Heikin Ashi → heikinAshi    (live)
//
// Disabled columns are shown so the control matches cTrader's layout exactly,
// but they never fire a selection: GT has no tick/range aggregation, and a
// button that silently does nothing (or errors) is worse than an honest,
// clearly-disabled one. Wire them up when the engine grows the data path.
// ============================================================================

import type { ChartType } from '@/components/chart/core/types';

export type BarKind = 'standard' | 'tick' | 'renko' | 'range' | 'heikin';

export interface BarRow {
  /** Timeframe id for enabled columns (e.g. '1h'); undefined for disabled. */
  tf?: string;
  /** Human row label ('1 hour'). */
  label: string;
  /** Compact label used on the trigger button ('H1'). */
  short?: string;
}

export interface BarColumn {
  kind: BarKind;
  title: string;
  /** ChartType this column selects (enabled columns only). */
  chartType?: ChartType;
  enabled: boolean;
  /** Tooltip shown on a disabled column explaining why. */
  disabledReason?: string;
  rows: BarRow[];
}

export interface BarSelection {
  timeframe: string;
  chartType: ChartType;
}

// The proven-serviceable timeframe ladder. These are the resolutions the local
// engine and every live provider reliably answer (they are exactly the set the
// grid staggers across), so no row here is ever a click that errors.
const TF_ROWS: BarRow[] = [
  { tf: '1m', label: '1 minute', short: 'M1' },
  { tf: '5m', label: '5 minutes', short: 'M5' },
  { tf: '15m', label: '15 minutes', short: 'M15' },
  { tf: '30m', label: '30 minutes', short: 'M30' },
  { tf: '1h', label: '1 hour', short: 'H1' },
  { tf: '4h', label: '4 hours', short: 'H4' },
  { tf: '1d', label: '1 day', short: 'D1' },
  { tf: '1w', label: '1 week', short: 'W1' },
];

export const BAR_COLUMNS: BarColumn[] = [
  {
    kind: 'standard',
    title: 'Standard',
    chartType: 'candlestick',
    enabled: true,
    rows: TF_ROWS,
  },
  {
    kind: 'tick',
    title: 'Tick',
    enabled: false,
    disabledReason:
      'Tick bars need a live tick-by-tick feed, which GT does not have for local datasets yet.',
    rows: [
      { label: '1 tick' },
      { label: '10 ticks' },
      { label: '100 ticks' },
      { label: '500 ticks' },
    ],
  },
  {
    kind: 'renko',
    title: 'Renko',
    chartType: 'renko',
    enabled: true,
    rows: TF_ROWS,
  },
  {
    kind: 'range',
    title: 'Range',
    enabled: false,
    disabledReason:
      'Range bars need finer-than-candle price data to be accurate (a later phase).',
    rows: [
      { label: '5 pips' },
      { label: '10 pips' },
      { label: '20 pips' },
      { label: '100 pips' },
    ],
  },
  {
    kind: 'heikin',
    title: 'Heikin Ashi',
    chartType: 'heikinAshi',
    enabled: true,
    rows: TF_ROWS,
  },
];

/** Compact prefix for the trigger button per bar type. */
function chartPrefix(ct: ChartType): string {
  switch (ct) {
    case 'heikinAshi':
      return 'HA ';
    case 'renko':
      return 'RK ';
    case 'line':
      return 'LN ';
    case 'area':
      return 'AR ';
    case 'bars':
      return 'OHLC ';
    default:
      return '';
  }
}

/** Compact form of any timeframe id ('1h' → 'H1', '15m' → 'M15'). */
export function tfShort(tf: string): string {
  const known = TF_ROWS.find((r) => r.tf === tf);
  if (known?.short) return known.short;
  const m = /^(\d+)\s*([smhdwy])$/i.exec(String(tf || '').trim());
  if (!m) return String(tf || '').toUpperCase();
  return m[2].toUpperCase() + m[1];
}

/** Label for the trigger button, e.g. 'H1', 'HA 15M', 'RK D1'. */
export function barTriggerLabel(sel: BarSelection): string {
  return chartPrefix(sel.chartType) + tfShort(sel.timeframe);
}

/** True when a given column row is the current selection. */
export function isActiveRow(col: BarColumn, row: BarRow, sel: BarSelection): boolean {
  if (!col.enabled || !col.chartType || !row.tf) return false;
  return col.chartType === sel.chartType && row.tf === sel.timeframe;
}
