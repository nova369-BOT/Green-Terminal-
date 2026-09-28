// ---------------------------------------------------------------------------
// Green Terminal — Tool Capability Registry (data layer)
//
// Single source of truth for what each drawing tool IS and which settings it
// owns. The settings inspector renders straight from `getToolSettings(type)`,
// so a tool shows ONLY the controls that are meaningful to it — no generic
// dump, no irrelevant buttons. This is our own architecture, deliberately not
// a clone of any other platform.
//
// This module is pure data + helpers (no JSX): the dialog maps each Setting to
// a concrete control. Every setting key below maps to a REAL field the drawing
// engine reads, so no control here is decorative.
// ---------------------------------------------------------------------------

export type ToolCategory =
  | 'lines' | 'channels' | 'fibonacci' | 'gann' | 'patterns' | 'harmonic'
  | 'elliott' | 'shapes' | 'text' | 'markers' | 'position' | 'volume'
  | 'statistics' | 'cycles' | 'utility';

export type DataNeed = 'ohlc' | 'volume' | 'l2';

// A declarative settings control. The renderer switches on `kind`.
export type Setting =
  | { kind: 'section'; label: string }
  | { kind: 'note'; text: string }
  | { kind: 'color'; key: string; label: string; opacityKey?: string; fallback?: string }
  | { kind: 'slider'; key: string; label: string; min: number; max: number; step: number; fallback: number; suffix?: string }
  | { kind: 'toggle'; key: string; label: string; fallback?: boolean }
  | { kind: 'segmented'; key: string; label: string; options: { value: string; label: string }[]; fallback: string }
  | { kind: 'lineStyle'; label: string }
  | { kind: 'fill' };

export interface ToolCapability {
  name: string;
  category: ToolCategory;
  interaction: 'point' | 'twoPoint' | 'multiPoint' | 'freehand' | 'action';
  resizable?: boolean;
  dataNeeds?: DataNeed[];
}

// --- category membership -------------------------------------------------
const MARKER_SET = new Set<string>([
  'markerArrowUp', 'markerArrowDown', 'markerCircle', 'markerSquare',
  'markerDiamond', 'markerStar', 'markerTriangleUp', 'markerTriangleDown',
]);
const TEXT_SET = new Set<string>(['text', 'note', 'callout', 'signpost', 'priceLabel']);
const FILL_SET = new Set<string>([
  'rectangle', 'square', 'circle', 'oval', 'triangle', 'freeTriangle', 'parallelogram',
  'octagon', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'arrowBlock', 'wedge',
  'heart', 'parallelChannel', 'flatChannel', 'splitChannel', 'gannBox',
  'pitchfork', 'schiff', 'modifiedSchiff', 'innerFork',
]);
// Tools the schema does NOT own yet — the dialog keeps its specialised legacy
// panel for these (position sizing UI, volume/stat engines get a dedicated
// phase). Returning [] here routes them to the legacy renderer unchanged.
const LEGACY_SET = new Set<string>([
  'long', 'short',
]);

export const isMarkerType = (t: string): boolean => MARKER_SET.has(t);
export const isTextType = (t: string): boolean => TEXT_SET.has(t);
export const hasFillType = (t: string): boolean => FILL_SET.has(t);

// --- reusable fragments --------------------------------------------------
const lineBase = (): Setting[] => [
  { kind: 'section', label: 'Line' },
  { kind: 'color', key: 'color', label: 'Color', opacityKey: 'opacity' },
  { kind: 'slider', key: 'strokeWidth', label: 'Thickness', min: 1, max: 8, step: 1, fallback: 2 },
  { kind: 'lineStyle', label: 'Style' },
];

/**
 * The settings a given tool owns. Empty array => the dialog uses its legacy
 * specialised panel for that tool (position/volume/stats/text).
 */
export function getToolSettings(type: string): Setting[] {
  if (type === 'emoji') {
    return [
      { kind: 'section', label: 'Emoji' },
      { kind: 'slider', key: 'strokeWidth', label: 'Size', min: 12, max: 200, step: 2, fallback: 28 },
      { kind: 'slider', key: 'opacity', label: 'Opacity', min: 10, max: 100, step: 1, fallback: 100, suffix: '%' },
      { kind: 'note', text: "Tip: drag the teal handle at the emoji's corner to resize it on the chart." },
    ];
  }
  if (MARKER_SET.has(type)) {
    return [
      { kind: 'section', label: 'Marker' },
      { kind: 'color', key: 'color', label: 'Color', opacityKey: 'opacity' },
      { kind: 'slider', key: 'strokeWidth', label: 'Size', min: 10, max: 120, step: 2, fallback: 16 },
      { kind: 'note', text: "Tip: drag the teal handle at the marker's corner to resize it on the chart." },
    ];
  }
  if (TEXT_SET.has(type)) {
    // Text/label family: the renderer reads color + strokeWidth (font size) +
    // textBold/textItalic. Those are the only functional controls.
    return [
      { kind: 'section', label: 'Text' },
      { kind: 'color', key: 'color', label: 'Text color', opacityKey: 'opacity' },
      { kind: 'slider', key: 'strokeWidth', label: 'Font size', min: 8, max: 72, step: 1, fallback: 14 },
      { kind: 'toggle', key: 'textBold', label: 'Bold', fallback: true },
      { kind: 'toggle', key: 'textItalic', label: 'Italic', fallback: false },
    ];
  }
  if (type === 'anchoredVwap') {
    return [
      { kind: 'section', label: 'VWAP' },
      { kind: 'color', key: 'color', label: 'Line color', opacityKey: 'opacity', fallback: '#2dd4bf' },
      { kind: 'slider', key: 'strokeWidth', label: 'Thickness', min: 1, max: 6, step: 1, fallback: 2 },
      { kind: 'segmented', key: 'vwapSource', label: 'Source', options: [{ value: 'hlc3', label: 'HLC3' }, { value: 'hl2', label: 'HL2' }, { value: 'close', label: 'Close' }, { value: 'ohlc4', label: 'OHLC4' }], fallback: 'hlc3' },
      { kind: 'toggle', key: 'showBands', label: 'Std-dev bands', fallback: true },
      { kind: 'slider', key: 'band1', label: 'Band 1 \u00d7', min: 0.5, max: 4, step: 0.5, fallback: 1 },
      { kind: 'slider', key: 'band2', label: 'Band 2 \u00d7', min: 0.5, max: 6, step: 0.5, fallback: 2 },
    ];
  }
  if (type === 'fixedVolumeProfile' || type === 'anchoredVolumeProfile') {
    return [
      { kind: 'section', label: 'Volume Profile' },
      { kind: 'slider', key: 'vpRows', label: 'Rows', min: 8, max: 80, step: 2, fallback: 24 },
      { kind: 'slider', key: 'valueAreaPct', label: 'Value area', min: 30, max: 95, step: 5, fallback: 70, suffix: '%' },
      { kind: 'color', key: 'upColor', label: 'Up color', fallback: '#2dd4bf' },
      { kind: 'color', key: 'downColor', label: 'Down color', fallback: '#6366f1' },
      { kind: 'toggle', key: 'showPOC', label: 'Show POC', fallback: true },
      { kind: 'toggle', key: 'showVA', label: 'Value area', fallback: true },
    ];
  }
  if (type === 'regressionTrend') {
    return [
      { kind: 'section', label: 'Regression' },
      { kind: 'color', key: 'color', label: 'Line color', opacityKey: 'opacity', fallback: '#2dd4bf' },
      { kind: 'slider', key: 'strokeWidth', label: 'Thickness', min: 1, max: 6, step: 1, fallback: 2 },
      { kind: 'toggle', key: 'showBands', label: 'Std-dev channel', fallback: true },
    ];
  }
  if (LEGACY_SET.has(type)) return [];

  // Geometric tools (lines, channels, fib, gann, shapes, patterns, harmonic,
  // elliott, pitchforks, cycles) — all read color/thickness/lineStyle, and the
  // fill set also reads fillColor/fillOpacity. Specialised extras (fib levels,
  // gann options, channel extend/middle line, line extend) are still appended
  // by the dialog's dedicated blocks.
  const s = lineBase();
  if (FILL_SET.has(type)) s.push({ kind: 'fill' });
  return s;
}

export function hasToolSettings(type: string): boolean {
  return getToolSettings(type).length > 0;
}
