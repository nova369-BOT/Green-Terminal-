import { useSyncExternalStore } from 'react';
import { normalizeWorkspace, overlaps, WORKSPACE_COLUMNS, WORKSPACE_ROWS, type WidgetRect } from './workspaceLayout';
import { decodeWorkspace, encodeWorkspace } from './workspaceDocument';

/** Native Green Terminal workspace widget model.
 *
 * Widgets are not a second application. They are typed panels in the same
 * workspace and share the chart symbol bus unless explicitly unlinked.
 *
 * This module is also the SINGLE OWNER of the persisted widget list: every
 * mutation flows through `updateWorkspaceWidgets` → normalize → persist →
 * notify, so the grid surface, the toolbar, and any future consumer always
 * render the same truth. Mutators below are pure procedures; persistence and
 * subscription notification happen centrally in `commitWorkspace`.
 */
export type WorkspaceWidgetType =
  | 'chart'
  | 'orderbook'
  | 'dom'
  | 'trades'
  | 'marketStats'
  | 'footprint'
  | 'heatmap'
  | 'volumeProfile'
  | 'cvdDelta'
  | 'paperTrading'
  | 'watchlist'
  | 'replay';

export type WidgetLinkMode = 'linked' | 'independent';

export interface WorkspaceWidget {
  id: string;
  type: WorkspaceWidgetType;
  title: string;
  symbol: string;
  timeframe: string;
  source?: string;
  productType?: string;
  symbolLink: WidgetLinkMode;
  timeframeLink: WidgetLinkMode;
  linkGroup?: string;
  visible: boolean;
  minimized: boolean;
  /** Height cached while minimized so restore returns the previous size. */
  minimizedHeight?: number;
  maximized?: boolean;
  restoreRect?: { x: number; y: number; width: number; height: number };
  // Grid coordinates are persisted; the renderer translates them into CSS
  // grid positions without changing the widget contract.
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WIDGET_DEFS: Record<WorkspaceWidgetType, { title: string; description: string; single?: boolean }> = {
  chart: { title: 'Chart', description: 'Price chart panes. The primary pane is the full native engine; extra panes are live engine-candle tiles.' },
  orderbook: { title: 'Orderbook', description: 'Read-only depth bars on the same validated L2 book as the DOM — spread, mid, imbalance.' },
  dom: { title: 'Depth of Market (DOM)', description: 'Price ladder with bid, ask, delta, and execution controls.' },
  trades: { title: 'Trades', description: 'Time and Sales for the resolved market source.' },
  marketStats: { title: 'Market Statistics', description: 'Live last/bid/ask/source plus an honest NOT PROVIDED grid for fields the venue feed never publishes.' },
  footprint: { title: 'Footprint', description: 'Executed buy/sell volume at each traded price.' },
  heatmap: { title: 'Heatmap', description: 'Historical and live resting depth when the feed supplies it.' },
  volumeProfile: { title: 'Volume Profile', description: 'Volume-by-price and delta profile.' },
  cvdDelta: { title: 'CVD / Delta', description: 'Cumulative and per-period aggressive volume delta.' },
  paperTrading: { title: 'Paper Trading', description: 'Simulation order entry and position tracking.' },
  watchlist: { title: 'Watchlist', description: 'Shell watchlists with live prices — row click switches the real workspace symbol.' },
  replay: { title: 'Replay Library', description: 'Recorded engine sessions. Catalog is live; playback ships with the recorder phase.' },
};

/** The default pro workspace: full-height chart left, DOM + trades docked right. */
export const DEFAULT_WORKSPACE_WIDGETS: WorkspaceWidget[] = [
  { id: 'chart-1', type: 'chart', title: 'Chart', symbol: '', timeframe: '5m', symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false, x: 0, y: 0, width: 8, height: WORKSPACE_ROWS },
  { id: 'dom-1', type: 'dom', title: 'DOM', symbol: '', timeframe: '5m', symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false, x: 8, y: 0, width: 4, height: 16 },
  { id: 'trades-1', type: 'trades', title: 'Trades', symbol: '', timeframe: '5m', symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false, source: 'binance-depth', productType: 'Spot', x: 8, y: 16, width: 4, height: 8 },
];

const STORAGE_KEY = 'green-terminal.workspace.widgets.v1';
function uid(type: WorkspaceWidgetType): string { return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

export function loadWorkspaceWidgets(): WorkspaceWidget[] {
  try {
    const raw = decodeWorkspace(localStorage.getItem(STORAGE_KEY));
    if (!raw) return DEFAULT_WORKSPACE_WIDGETS.map(w => ({ ...w }));
    const valid = raw.filter((w): w is WorkspaceWidget => !!w && typeof w.id === 'string' && !!WIDGET_DEFS[w.type as WorkspaceWidgetType]);
    if (!valid.length) return DEFAULT_WORKSPACE_WIDGETS.map(w => ({ ...w }));
    return normalizeWorkspace(valid.map(w => ({
      ...w,
      title: WIDGET_DEFS[w.type].title,
      symbol: typeof w.symbol === 'string' ? w.symbol : '',
      timeframe: typeof w.timeframe === 'string' ? w.timeframe : '5m',
      source: typeof w.source === 'string' ? w.source : undefined,
      productType: typeof w.productType === 'string' ? w.productType : undefined,
      symbolLink: w.symbolLink === 'independent' ? 'independent' : 'linked',
      timeframeLink: w.timeframeLink === 'independent' ? 'independent' : 'linked',
      linkGroup: typeof w.linkGroup === 'string' && w.linkGroup.trim() ? w.linkGroup.trim() : undefined,
      visible: w.visible !== false,
      minimized: w.minimized === true,
      minimizedHeight: Number.isFinite(w.minimizedHeight) ? w.minimizedHeight : undefined,
      maximized: w.maximized === true,
      restoreRect: w.restoreRect && Number.isFinite(w.restoreRect.x) ? w.restoreRect : undefined,
      x: Number.isFinite(w.x) ? Math.max(0, w.x) : 0,
      y: Number.isFinite(w.y) ? Math.max(0, w.y) : 0,
      width: Number.isFinite(w.width) ? Math.max(2, Math.min(WORKSPACE_COLUMNS, w.width)) : 4,
      height: Number.isFinite(w.height) ? Math.max(2, Math.min(WORKSPACE_ROWS, w.height)) : 4,
    })));
  } catch { return DEFAULT_WORKSPACE_WIDGETS.map(w => ({ ...w })); }
}

export function saveWorkspaceWidgets(widgets: WorkspaceWidget[]): void {
  try { localStorage.setItem(STORAGE_KEY, encodeWorkspace(widgets)); } catch { /* workspace remains usable in memory */ }
}

/* ----------------------------------------------------------------------- */
/* External store: one owner, one notification channel.                     */
/* ----------------------------------------------------------------------- */

type WorkspaceListener = (widgets: WorkspaceWidget[]) => void;
const listeners = new Set<WorkspaceListener>();
let cache: WorkspaceWidget[] | null = null;

/** Snapshot reader for useSyncExternalStore. Returns a STABLE reference:
 * it only changes when commitWorkspace writes a new array. */
export function getWorkspaceWidgets(): WorkspaceWidget[] {
  if (!cache) cache = loadWorkspaceWidgets();
  return cache;
}

export function subscribeWorkspace(listener: WorkspaceListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Normalize, persist, and broadcast one commit. This is the ONLY path that
 * writes, so persisted state can never diverge from what is on screen. */
export function commitWorkspace(next: WorkspaceWidget[]): WorkspaceWidget[] {
  const normalized = normalizeWorkspace(next);
  cache = normalized;
  saveWorkspaceWidgets(normalized);
  listeners.forEach(listener => listener(normalized));
  return normalized;
}

/** Apply a pure procedure to the current widgets. An identity return (the
 * procedure changed nothing) commits nothing, so effects cannot loop. */
export function updateWorkspaceWidgets(procedure: (widgets: WorkspaceWidget[]) => WorkspaceWidget[]): WorkspaceWidget[] {
  const current = getWorkspaceWidgets();
  const next = procedure(current);
  if (next === current) return current;
  return commitWorkspace(next);
}

/** React binding to the workspace store. */
export function useWorkspaceWidgets(): [WorkspaceWidget[], (procedure: (widgets: WorkspaceWidget[]) => WorkspaceWidget[]) => WorkspaceWidget[]] {
  const widgets = useSyncExternalStore(subscribeWorkspace, getWorkspaceWidgets);
  return [widgets, updateWorkspaceWidgets];
}

/* ----------------------------------------------------------------------- */
/* Pure procedures (no persistence — that is commitWorkspace's job).        */
/* ----------------------------------------------------------------------- */

/** Find the first grid spot with no overlap so new panels never stack. */
function findFreeSpot(widgets: WorkspaceWidget[], width: number, height: number): { x: number; y: number } {
  const visible = widgets.filter(w => w.visible);
  for (let y = 0; y <= WORKSPACE_ROWS; y += 1) {
    for (let x = 0; x <= WORKSPACE_COLUMNS - width; x += 1) {
      const rect: WidgetRect = { x, y, width, height };
      if (!visible.some(w => overlaps(rect, w))) return { x, y };
    }
  }
  const bottom = visible.reduce((max, w) => Math.max(max, w.y + w.height), 0);
  return { x: 0, y: bottom };
}

export function addWorkspaceWidget(widgets: WorkspaceWidget[], type: WorkspaceWidgetType, symbol: string, timeframe: string, source?: string, productType?: string): WorkspaceWidget[] {
  const def = WIDGET_DEFS[type];
  if (def.single && widgets.some(w => w.type === type && w.visible)) return widgets;
  /* Chart panes past the first are tiles — sized like a tile, not the full
   * engine pane, so adding one never swallows the whole grid. */
  const isChart = type === 'chart';
  const hasChart = widgets.some(w => w.type === 'chart' && w.visible);
  const width = isChart ? (hasChart ? 6 : 8) : 4;
  const height = isChart ? (hasChart ? 12 : WORKSPACE_ROWS) : 8;
  const spot = findFreeSpot(widgets, width, height);
  const widget: WorkspaceWidget = {
    id: uid(type), type, title: def.title, symbol, timeframe, source, productType,
    symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false,
    x: spot.x, y: spot.y, width, height,
  };
  return [...widgets, widget];
}

export function removeWorkspaceWidget(widgets: WorkspaceWidget[], id: string): WorkspaceWidget[] {
  if (!widgets.some(w => w.id === id)) return widgets;
  return widgets.filter(w => w.id !== id);
}

export function setWorkspaceWidgetVisibility(widgets: WorkspaceWidget[], id: string, visible: boolean): WorkspaceWidget[] {
  return widgets.map(widget => widget.id === id ? { ...widget, visible } : widget);
}

export function setWorkspaceWidgetMinimized(widgets: WorkspaceWidget[], id: string, minimized: boolean): WorkspaceWidget[] {
  return widgets.map(widget => {
    if (widget.id !== id) return widget;
    if (minimized) return { ...widget, minimized: true, maximized: false, minimizedHeight: widget.height };
    return { ...widget, minimized: false, height: widget.minimizedHeight || widget.height, minimizedHeight: undefined };
  });
}

export function toggleWorkspaceMaximized(widgets: WorkspaceWidget[], id: string): WorkspaceWidget[] {
  return widgets.map(widget => {
    if (widget.id !== id) return widget;
    if (widget.maximized && widget.restoreRect) return { ...widget, ...widget.restoreRect, maximized: false, restoreRect: undefined };
    return { ...widget, maximized: true, minimized: false, restoreRect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height }, x: 0, y: 0, width: WORKSPACE_COLUMNS, height: WORKSPACE_ROWS };
  });
}

export function reorderWorkspaceWidget(widgets: WorkspaceWidget[], id: string, beforeId: string): WorkspaceWidget[] {
  if (id === beforeId) return widgets;
  const source = widgets.find(widget => widget.id === id);
  if (!source) return widgets;
  const remaining = widgets.filter(widget => widget.id !== id);
  const index = Math.max(0, remaining.findIndex(widget => widget.id === beforeId));
  remaining.splice(index < 0 ? remaining.length : index, 0, source);
  return remaining;
}

export function updateWorkspaceLinkGroup(widgets: WorkspaceWidget[], id: string, group?: string): WorkspaceWidget[] {
  return widgets.map(widget => widget.id === id ? { ...widget, linkGroup: group?.trim() || undefined } : widget);
}

export const LINK_GROUPS = ['A', 'B', 'C'] as const;
export const LINK_GROUP_COLORS: Record<string, string> = { A: '#e1b65c', B: '#58d797', C: '#8bb7e8' };

/** Cycle none → A → B → C → none. Group members sync symbol/timeframe with
 * each other; widgets outside every group follow the chart by default. */
export function cycleWorkspaceLinkGroup(widgets: WorkspaceWidget[], id: string): WorkspaceWidget[] {
  return widgets.map(widget => {
    if (widget.id !== id) return widget;
    const current = widget.linkGroup ? LINK_GROUPS.indexOf(widget.linkGroup as typeof LINK_GROUPS[number]) : -1;
    const next = current + 1 >= LINK_GROUPS.length ? undefined : LINK_GROUPS[current + 1];
    return { ...widget, linkGroup: next };
  });
}

export function toggleWorkspaceLink(widgets: WorkspaceWidget[], id: string, field: 'symbol' | 'timeframe'): WorkspaceWidget[] {
  const key = field === 'symbol' ? 'symbolLink' : 'timeframeLink';
  return widgets.map(widget => widget.id === id ? { ...widget, [key]: widget[key] === 'linked' ? 'independent' : 'linked' } : widget);
}

/** Editing a panel's own symbol makes it independent by definition — a panel
 * with a hand-set symbol must not be swept along by the next chart change.
 * The caller propagates the new symbol through the widget's link group. */
export function setWorkspaceWidgetSymbol(widgets: WorkspaceWidget[], id: string, symbol: string): WorkspaceWidget[] {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return widgets;
  return widgets.map(widget => widget.id === id && widget.symbol !== clean ? { ...widget, symbol: clean, symbolLink: 'independent' } : widget);
}

/** Timeframes the panel header's cycle control walks through. The full shell
 * list is reachable from the workspace timeframe toolbar; this is the quick
 * per-pane set. */
export const PANEL_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

/** Editing a panel's own timeframe makes its tf link independent by
 * definition — same rule as hand-set symbols. */
export function setWorkspaceWidgetTimeframe(widgets: WorkspaceWidget[], id: string, timeframe: string): WorkspaceWidget[] {
  const clean = timeframe.trim().toLowerCase();
  if (!(PANEL_TIMEFRAMES as readonly string[]).includes(clean)) return widgets;
  return widgets.map(widget => widget.id === id && widget.timeframe !== clean ? { ...widget, timeframe: clean, timeframeLink: 'independent' } : widget);
}

export function propagateWorkspaceLink(widgets: WorkspaceWidget[], sourceId: string, symbol: string, timeframe: string): WorkspaceWidget[] {
  const source = widgets.find(widget => widget.id === sourceId);
  if (!source) return widgets;
  let changed = widgets;
  const next = widgets.map(widget => {
    const sameGroup = source.linkGroup && widget.linkGroup === source.linkGroup;
    // Ungrouped sources (the chart) drive only ungrouped panels — grouped
    // panels answered to their group's own symbol, which is the whole point.
    const followsWorkspace = !source.linkGroup && widget.id !== sourceId && !widget.linkGroup;
    if (!(widget.id === sourceId || sameGroup || followsWorkspace)) return widget;
    const symbolNext = widget.symbolLink === 'linked' || widget.id === sourceId ? symbol : widget.symbol;
    const timeframeNext = widget.timeframeLink === 'linked' || widget.id === sourceId ? timeframe : widget.timeframe;
    if (symbolNext === widget.symbol && timeframeNext === widget.timeframe) return widget;
    return { ...widget, symbol: symbolNext, timeframe: timeframeNext };
  });
  changed = next.some((widget, index) => widget !== widgets[index]) ? next : widgets;
  return changed;
}

/** Presets tile the visible panels across the full 12x24 workspace grid. */
export function applyWorkspacePreset(widgets: WorkspaceWidget[], preset: '1' | '2' | '4' | '16'): WorkspaceWidget[] {
  const count = Number(preset);
  const perRow = preset === '1' ? 1 : preset === '16' ? 4 : 2;
  const columns = WORKSPACE_COLUMNS / perRow;
  const rowsNeeded = Math.max(1, Math.ceil(count / perRow));
  const rowHeight = Math.max(2, Math.floor(WORKSPACE_ROWS / rowsNeeded));
  return widgets.map((widget, index) => ({
    ...widget,
    x: (index % perRow) * columns,
    y: Math.floor(index / perRow) * rowHeight,
    width: columns,
    height: rowHeight,
    visible: index < count || widget.type === 'chart',
    minimized: false,
    maximized: false,
    restoreRect: undefined,
  }));
}

/**
 * XFlow-style chart split: make the workspace show exactly `count` visible
 * chart panes and lay them in a mosaic (1 -> 1x1, 2 -> 2x1, 4 -> 2x2) across
 * the full grid. Extra chart panes are added linked to the active symbol so
 * they follow the floor until unlinked; surplus panes are dropped (tiles
 * carry no user data beyond a symbol, and the primary pane is never
 * removed). Non-chart panels keep their identity — the commit normalization
 * pushes them below the mosaic instead of deleting them.
 */
export function applyChartSplit(widgets: WorkspaceWidget[], count: 1 | 2 | 4, symbol: string, timeframe: string): WorkspaceWidget[] {
  let charts = widgets.filter(widget => widget.visible && widget.type === 'chart');
  let next = widgets;
  if (charts.length > count) {
    const keep = new Set(charts.slice(0, count).map(widget => widget.id));
    next = next.filter(widget => !(widget.type === 'chart' && widget.visible && !keep.has(widget.id)));
  }
  while (next.filter(widget => widget.visible && widget.type === 'chart').length < count) {
    const spot = findFreeSpot(next, 6, 12);
    const tile: WorkspaceWidget = {
      id: uid('chart'), type: 'chart', title: WIDGET_DEFS.chart.title, symbol, timeframe,
      symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false,
      x: spot.x, y: spot.y, width: 6, height: 12,
    };
    next = [...next, tile];
  }
  const columns = count === 1 ? 1 : 2;
  const rows = Math.ceil(count / columns);
  const cellW = Math.floor(WORKSPACE_COLUMNS / columns);
  const cellH = Math.floor(WORKSPACE_ROWS / rows);
  charts = next.filter(widget => widget.visible && widget.type === 'chart');
  let index = 0;
  return next.map(widget => {
    if (!(widget.visible && widget.type === 'chart')) return widget;
    const col = index % columns;
    const row = Math.floor(index / columns);
    index += 1;
    return {
      ...widget,
      x: col * cellW,
      y: row * cellH,
      // Last column/row absorbs the remainder so the mosaic always spans 12x24.
      width: col === columns - 1 ? WORKSPACE_COLUMNS - col * cellW : cellW,
      height: row === rows - 1 ? WORKSPACE_ROWS - row * cellH : cellH,
      minimized: false,
      maximized: false,
      restoreRect: undefined,
    };
  });
}
