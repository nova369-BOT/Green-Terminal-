/** Native Green Terminal workspace widget model.
 *
 * Widgets are not a second application. They are typed panels in the same
 * workspace and share the chart symbol bus unless explicitly unlinked.
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
  symbolLink: WidgetLinkMode;
  timeframeLink: WidgetLinkMode;
  visible: boolean;
  minimized: boolean;
  // Grid coordinates are persisted; the renderer may translate them into
  // CSS grid/flex positions without changing the widget contract.
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

export const DEFAULT_WORKSPACE_WIDGETS: WorkspaceWidget[] = [
  { id: 'chart-1', type: 'chart', title: 'Chart', symbol: '', timeframe: '5m', symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false, x: 0, y: 0, width: 8, height: 8 },
  { id: 'dom-1', type: 'dom', title: 'DOM', symbol: '', timeframe: '5m', symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false, x: 8, y: 0, width: 4, height: 5 },
  { id: 'trades-1', type: 'trades', title: 'Trades', symbol: '', timeframe: '5m', symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false, x: 8, y: 5, width: 4, height: 3 },
];

const STORAGE_KEY = 'green-terminal.workspace.widgets.v1';
function uid(type: WorkspaceWidgetType): string { return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

export function loadWorkspaceWidgets(): WorkspaceWidget[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!Array.isArray(raw)) return DEFAULT_WORKSPACE_WIDGETS.map(w => ({ ...w }));
    return raw.filter((w): w is WorkspaceWidget => !!w && typeof w.id === 'string' && !!WIDGET_DEFS[w.type as WorkspaceWidgetType]);
  } catch { return DEFAULT_WORKSPACE_WIDGETS.map(w => ({ ...w })); }
}

export function saveWorkspaceWidgets(widgets: WorkspaceWidget[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets)); } catch { /* workspace remains usable in memory */ }
}

export function addWorkspaceWidget(widgets: WorkspaceWidget[], type: WorkspaceWidgetType, symbol: string, timeframe: string): WorkspaceWidget[] {
  const def = WIDGET_DEFS[type];
  if (def.single && widgets.some(w => w.type === type && w.visible)) return widgets;
  const widget: WorkspaceWidget = {
    id: uid(type), type, title: def.title, symbol, timeframe,
    symbolLink: 'linked', timeframeLink: 'linked', visible: true, minimized: false,
    x: 0, y: 0, width: type === 'chart' ? 8 : 4, height: type === 'chart' ? 8 : 4,
  };
  const next = [...widgets, widget];
  saveWorkspaceWidgets(next); return next;
}

export function removeWorkspaceWidget(widgets: WorkspaceWidget[], id: string): WorkspaceWidget[] {
  const next = widgets.filter(w => w.id !== id); saveWorkspaceWidgets(next); return next;
}
