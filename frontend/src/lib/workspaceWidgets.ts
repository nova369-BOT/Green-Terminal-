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
  chart: { title: 'Chart', description: 'Native price chart with existing tools and indicators.', single: true },
  orderbook: { title: 'Orderbook', description: 'Current visible bid/ask liquidity.' },
  dom: { title: 'Depth of Market (DOM)', description: 'Price ladder with bid, ask, delta, and execution controls.' },
  trades: { title: 'Trades', description: 'Time and Sales for the resolved market source.' },
  marketStats: { title: 'Market Statistics', description: 'Live mark, funding, open interest, volume, and session data.' },
  footprint: { title: 'Footprint', description: 'Executed buy/sell volume at each traded price.' },
  heatmap: { title: 'Heatmap', description: 'Historical and live resting depth when the feed supplies it.' },
  volumeProfile: { title: 'Volume Profile', description: 'Volume-by-price and delta profile.' },
  cvdDelta: { title: 'CVD / Delta', description: 'Cumulative and per-period aggressive volume delta.' },
  paperTrading: { title: 'Paper Trading', description: 'Simulation order entry and position tracking.' },
  watchlist: { title: 'Watchlist', description: 'Symbols and live changes.' },
  replay: { title: 'Replay Library', description: 'Recorded market data and replay sessions.' },
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
  const width = type === 'chart' ? 8 : 4;
  const height = type === 'chart' ? WORKSPACE_ROWS : 8;
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

export function propagateWorkspaceLink(widgets: WorkspaceWidget[], sourceId: string, symbol: string, timeframe: string): WorkspaceWidget[] {
  const source = widgets.find(widget => widget.id === sourceId);
  if (!source) return widgets;
  let changed = widgets;
  const next = widgets.map(widget => {
    const sameGroup = source.linkGroup && widget.linkGroup === source.linkGroup;
    const followsWorkspace = !source.linkGroup && widget.id !== sourceId;
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
