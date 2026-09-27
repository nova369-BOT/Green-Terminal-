// ── On-chart HUD data derivation (Item 8) ────────────────────────────────────
//
// Pure, framework-free logic that turns ProChart's live `indicators` config and
// its computed `indicatorData` into a flat list of HUD modules — one per active
// indicator line. Kept OUT of ProChart.tsx (a 10k-line component) so it can be
// reasoned about and unit-tested in isolation, and so a bad shape can never
// crash the chart: anything we don't understand degrades to a value of "—" with
// no gauge, never a throw.
//
// The HUD reads the LATEST bar's value for each indicator (what a trader sees at
// the hard right edge). The gauge shows where that latest value sits inside a
// sensible range: a fixed range for bounded oscillators (RSI 0–100, etc.), else
// the min/max of the recent series.
import { getLegendTitle, getIndicatorDisplay } from './indicatorRegistry';

/** One module in the on-chart HUD. Presentational component consumes this. */
export interface HudIndicatorItem {
  /** Stable key. Matches ProChart's clickedIndicatorKey scheme, incl.
   *  the per-line `movingAverages__<idx>` composite key. */
  key: string;
  /** Config key the edit/hide/delete handlers act on (e.g. 'rsi'). For MA
   *  lines this is still 'movingAverages'; `lineIndex` carries the row. */
  configKey: string;
  /** MA line index when this module is one line of movingAverages, else null. */
  lineIndex: number | null;
  /** Short label, e.g. "RSI 14", "SMA 50", "BB". */
  title: string;
  /** Formatted latest value, or "—" when unavailable. */
  valueText: string;
  /** Plot colour (dot + gauge arc). */
  color: string;
  /** 0..1 position of the latest value inside its range, or null (no gauge). */
  gaugePct: number | null;
  /** Which pane it draws in — HUD may badge subplots differently later. */
  display: 'overlay' | 'subplot';
  /** True when the plot is toggled off (dimmed) but not removed. */
  hidden?: boolean;
}

// Oscillators with a well-known fixed range → the gauge is meaningful without
// scanning the data. Values outside are clamped to [0,1].
const FIXED_RANGE: Record<string, [number, number]> = {
  rsi: [0, 100],
  stochastic: [0, 100],
  stochRsi: [0, 100],
  mfi: [0, 100],
  williamsR: [-100, 0],
  adx: [0, 100],
  aroon: [0, 100],
  choppiness: [0, 100],
  bbPercent: [0, 100],
  psychLine: [0, 100],
  connorsRsi: [0, 100],
  ultimateOsc: [0, 100],
};

/** Last finite number in an array (scans from the end). null if none. */
function lastFinite(arr: readonly number[] | null | undefined): number | null {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** min/max of the finite tail of a series (default last 240 bars). */
function finiteRange(arr: readonly number[], lookback = 240): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  const start = Math.max(0, arr.length - lookback);
  for (let i = start; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity || max === -Infinity) return null;
  return { min, max };
}

/**
 * Pull a single representative numeric series out of one indicatorData entry,
 * whatever its shape:
 *   - number[]                       → itself
 *   - number[][]                     → first sub-array (e.g. legacy ema)
 *   - { middle|basis|... : number[] }→ the "centre" line of a band
 *   - { macd|k|value|... : number[] }→ the primary oscillator line
 * Returns null for shapes we don't model (module still renders, gauge hidden).
 */
function primarySeries(entry: any): number[] | null {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    if (entry.length === 0) return null;
    if (typeof entry[0] === 'number') return entry as number[];
    if (Array.isArray(entry[0])) return entry[0] as number[]; // number[][]
    return null;
  }
  if (typeof entry === 'object') {
    // Band-style centre lines, in priority order.
    const centreKeys = ['middle', 'basis', 'base', 'mid', 'kijun', 'signal'];
    for (const k of centreKeys) if (Array.isArray(entry[k])) return entry[k];
    // Oscillator primary lines, in priority order.
    const primaryKeys = ['macd', 'value', 'k', 'adx', 'tenkan', 'plusDI',
      'upper', 'jaw', 'trix', 'tsi', 'fisher', 'rvi', 'klinger', 'ppo'];
    for (const k of primaryKeys) if (Array.isArray(entry[k])) return entry[k];
    // Last resort: first array-valued field.
    for (const k of Object.keys(entry)) if (Array.isArray(entry[k])) return entry[k];
  }
  return null;
}

/** Format a value with a precision that suits its magnitude. */
function formatValue(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return v.toPrecision(3);
}

/** Clamp helper. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function gaugeFor(id: string, series: number[] | null, value: number | null): number | null {
  if (value === null || !series) return null;
  const fixed = FIXED_RANGE[id];
  if (fixed) {
    const [lo, hi] = fixed;
    if (hi === lo) return null;
    return clamp01((value - lo) / (hi - lo));
  }
  const r = finiteRange(series);
  if (!r || r.max === r.min) return null;
  return clamp01((value - r.min) / (r.max - r.min));
}

/**
 * Build the HUD module list from ProChart's live config + computed data.
 * `defaultColor` is used when an indicator carries no colour of its own.
 */
export function deriveHudItems(
  indicators: any,
  indicatorData: any,
  defaultColor = '#b08d57',
): HudIndicatorItem[] {
  if (!indicators || !indicatorData) return [];
  const items: HudIndicatorItem[] = [];

  // ── Moving averages: one module per configured line ──────────────────────
  const maLines: any[] = indicators.movingAverages?.lines ?? [];
  const maData: any[] = Array.isArray(indicatorData.movingAverages) ? indicatorData.movingAverages : [];
  if (indicators.movingAverages?.enabled && maData.length > 0) {
    for (let i = 0; i < maData.length; i++) {
      const line = maData[i] || {};
      const cfg = maLines[i] || {};
      const series: number[] | null = Array.isArray(line.data) ? line.data : null;
      const value = lastFinite(series);
      items.push({
        key: `movingAverages__${i}`,
        configKey: 'movingAverages',
        lineIndex: i,
        title: line.name || (cfg.type && cfg.period ? `${cfg.type} ${cfg.period}` : 'MA'),
        valueText: formatValue(value),
        color: line.color || cfg.color || defaultColor,
        gaugePct: gaugeFor('movingAverages', series, value),
        display: 'overlay',
      });
    }
  }

  // ── Every other enabled indicator with computed data ─────────────────────
  for (const id of Object.keys(indicatorData)) {
    if (id === 'movingAverages' || id === 'ema') continue; // MA handled; ema is legacy/canvas-only
    const cfg = indicators[id];
    if (!cfg || cfg.enabled !== true) continue;
    const entry = indicatorData[id];
    if (entry === null || entry === undefined) continue;

    const series = primarySeries(entry);
    const value = lastFinite(series);
    const color =
      cfg.color || cfg.middleColor || cfg.upperColor || cfg.macdColor ||
      cfg.kColor || cfg.adxColor || cfg.tenkanColor || cfg.bullishColor ||
      defaultColor;

    items.push({
      key: id,
      configKey: id,
      lineIndex: null,
      title: getLegendTitle(id),
      valueText: formatValue(value),
      color,
      gaugePct: gaugeFor(id, series, value),
      display: getIndicatorDisplay(id) ?? 'overlay',
    });
  }

  return items;
}
