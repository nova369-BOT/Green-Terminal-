import React, { useEffect, useRef, useState } from 'react';
import { getBus, type BusDepth, type BusTrade } from '@/market-data/bus';
import { useLiveQuote } from '@/market-data/hooks';
import { useCapabilities } from '@/market-data/hooks';
import { resolveWidgetCapability } from '@/lib/widgetCapabilities';
import {
  addWorkspaceWidget,
  DEFAULT_WORKSPACE_WIDGETS,
  loadWorkspaceWidgets,
  removeWorkspaceWidget,
  saveWorkspaceWidgets,
  WIDGET_DEFS,
  type WorkspaceWidget,
  type WorkspaceWidgetType,
} from '@/lib/workspaceWidgets';

const GROUPS: Array<{ label: string; types: WorkspaceWidgetType[] }> = [
  { label: 'Charts & flow', types: ['chart', 'footprint', 'heatmap', 'volumeProfile', 'cvdDelta'] },
  { label: 'Market data', types: ['dom', 'orderbook', 'trades', 'marketStats'] },
  { label: 'Trading & tools', types: ['paperTrading', 'watchlist', 'replay'] },
];

/**
 * The workspace chrome is deliberately independent from any feed renderer.
 * This lets unsupported widgets remain honest (and persist in the layout)
 * while each provider-specific renderer is added and verified separately.
 */
export default function WidgetWorkspaceControls({ symbol, timeframe }: { symbol: string; timeframe: string }) {
  const [widgets, setWidgets] = useState<WorkspaceWidget[]>([]);
  const [trades, setTrades] = useState<BusTrade[]>([]);
  const [depth, setDepth] = useState<{ bids: Array<[string, string]>; asks: Array<[string, string]>; ready: boolean; reset?: string }>({ bids: [], asks: [], ready: false });
  const { caps } = useCapabilities();
  const tradesOpen = widgets.some(widget => widget.type === 'trades' && widget.visible);
  const statsOpen = widgets.some(widget => widget.type === 'marketStats' && widget.visible);
  const domOpen = widgets.some(widget => widget.type === 'dom' && widget.visible);
  const { quote, connected, lastTickAgeMs } = useLiveQuote(symbol || null, undefined, statsOpen);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setWidgets(loadWorkspaceWidgets()), []);
  useEffect(() => {
    if (!domOpen || !symbol) { setDepth({ bids: [], asks: [], ready: false }); return; }
    const bus = getBus();
    const stop = bus.stream([symbol], 'binance-depth');
    const off = bus.subscribeDepth((event: BusDepth) => {
      if (event.symbol !== symbol) return;
      if (event.type === 'DEPTH_RESET') { setDepth({ bids: [], asks: [], ready: false, reset: String(event.reason || 'depth reset') }); return; }
      const bids = Array.isArray(event.bids || event.b) ? (event.bids || event.b) as Array<[string, string]> : [];
      const asks = Array.isArray(event.asks || event.a) ? (event.asks || event.a) as Array<[string, string]> : [];
      setDepth(previous => event.type === 'ORDER_BOOK_SNAPSHOT' ? { bids, asks, ready: false } : { bids: applyDepth(previous.bids, bids), asks: applyDepth(previous.asks, asks), ready: true });
    });
    return () => { off(); stop(); };
  }, [symbol, domOpen]);
  useEffect(() => {
    if (!tradesOpen || !symbol) { setTrades([]); return; }
    const bus = getBus();
    const stop = bus.stream([symbol]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol === symbol) setTrades(previous => [trade, ...previous].slice(0, 24));
    });
    return () => { off(); stop(); };
  }, [symbol, tradesOpen]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) { setOpen(false); setMenu(false); }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const add = (type: WorkspaceWidgetType) => {
    const next = addWorkspaceWidget(widgets, type, symbol, timeframe);
    setWidgets(next);
    setOpen(false);
  };
  const remove = (id: string) => {
    const next = removeWorkspaceWidget(widgets, id);
    setWidgets(next);
  };
  const reset = () => {
    const next = DEFAULT_WORKSPACE_WIDGETS.map(widget => ({ ...widget, symbol, timeframe }));
    saveWorkspaceWidgets(next); setWidgets(next); setMenu(false);
  };

  return (
    <div ref={rootRef} style={{ position: 'absolute', zIndex: 30, top: 8, left: 10, right: 10, pointerEvents: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} style={buttonStyle(true)}>
          <span style={{ fontSize: 17, lineHeight: 0 }}>+</span> Widget
        </button>
        <div style={{ display: 'flex', gap: 4, overflow: 'hidden' }}>
          {widgets.filter(w => w.visible).map(widget => (
            <span key={widget.id} style={pillStyle} title={WIDGET_DEFS[widget.type].description}>
              {widget.title}
              {widget.type !== 'chart' && <button type="button" aria-label={`Close ${widget.title}`} onClick={() => remove(widget.id)} style={closeStyle}>×</button>}
            </span>
          ))}
        </div>
      </div>
      <div style={{ pointerEvents: 'auto', position: 'relative' }}>
        <button type="button" aria-label="Workspace options" onClick={() => setMenu(v => !v)} style={buttonStyle(false)}>⋮</button>
        {menu && <div style={menuStyle}>
          <div style={menuTitle}>WORKSPACE</div>
          <button type="button" onClick={reset} style={menuItem}>Reset to Chart + DOM + Trades</button>
          <div style={{ ...menuTitle, marginTop: 8 }}>LINKING</div>
          <div style={{ color: '#87939f', fontSize: 11, padding: '5px 10px 8px' }}>New widgets follow {symbol || 'the active symbol'} and {timeframe} until unlinked.</div>
        </div>}
      </div>
      {open && <div style={pickerStyle}>
        <div style={pickerHeader}><strong>Add widget</strong><span style={{ color: '#7e8a96', fontSize: 11 }}>Native workspace panels</span></div>
        {GROUPS.map((group) => (
          <section key={group.label}>
            <div style={groupLabel}>{group.label}</div>
            <div style={gridStyle}>
              {group.types.map((type) => {
                const def = WIDGET_DEFS[type];
                const exists = Boolean(def.single && widgets.some(widget => widget.type === type && widget.visible));
                const capability = resolveWidgetCapability(type, caps);
                const unavailable = capability.availability === 'unavailable';
                const disabled = exists || unavailable;
                return (
                  <button type="button" key={type} disabled={disabled} title={capability.reason} onClick={() => add(type)} style={{ ...pickerItem, opacity: disabled ? 0.42 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                    <span style={iconStyle}>{iconFor(type)}</span>
                    <span><b>{def.title}</b><small>{def.description}</small><em style={capabilityTextStyle}>{capability.availability === 'unknown' ? 'Capability pending' : capability.availability}</em></span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>}
      {domOpen && <div style={domPanelStyle}>
        <div style={tradeHeaderStyle}><b>DOM · Binance L2</b><span style={{ color: depth.ready ? '#58d797' : '#e1a650' }}>{depth.ready ? 'Live' : 'Syncing'}</span></div>
        {depth.ready ? <div style={domGridStyle}><div><strong style={domSideBid}>BIDS</strong>{depth.bids.slice(0, 8).reverse().map(([price, qty]) => <div key={`b${price}`} style={domRowStyle}><span>{price}</span><i style={barStyle(qty, '#318f69')}>{qty}</i></div>)}</div><div><strong style={domSideAsk}>ASKS</strong>{depth.asks.slice(0, 8).map(([price, qty]) => <div key={`a${price}`} style={domRowStyle}><span>{price}</span><i style={barStyle(qty, '#b55e63')}>{qty}</i></div>)}</div></div> : <div style={emptyTradeStyle}>{depth.reset || 'Waiting for a validated snapshot and sequence bridge.'}<br /><small>No stale or synthetic levels are displayed.</small></div>}
      </div>}
      {statsOpen && <div style={statsPanelStyle}>
        <div style={tradeHeaderStyle}><b>Market statistics · live</b><span style={{ color: connected ? '#58d797' : '#e1a650' }}>{connected ? 'Connected' : 'Offline'}</span></div>
        <div style={statsGridStyle}>
          <Stat label="Last" value={formatPrice(quote?.price)} />
          <Stat label="Bid" value={formatPrice(quote?.bid)} />
          <Stat label="Ask" value={formatPrice(quote?.ask)} />
          <Stat label="Source" value={quote?.source || '—'} />
        </div>
        <div style={statsFootStyle}>{lastTickAgeMs == null ? 'No live tick received.' : `Last tick ${Math.round(lastTickAgeMs / 100) / 10}s ago.`}</div>
      </div>}
      {tradesOpen && <div style={tradePanelStyle}>
        <div style={tradeHeaderStyle}><b>Trades · live</b><span>{trades.length ? `${trades.length} prints` : 'Waiting'}</span></div>
        {trades.length ? trades.map((trade, index) => <div key={`${trade.tsMs}-${index}`} style={tradeRowStyle}>
          <time>{new Date(trade.tsMs).toLocaleTimeString()}</time><strong>{formatPrice(trade.price)}</strong><span>{trade.size == null ? '—' : trade.size}</span>
        </div>) : <div style={emptyTradeStyle}>No verified trade prints received yet.<br /><small>The panel will populate only from the selected live provider.</small></div>}
      </div>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return <div><div style={statLabelStyle}>{label}</div><strong style={statValueStyle}>{value}</strong></div>;
}

function applyDepth(current: Array<[string, string]>, updates: Array<[string, string]>): Array<[string, string]> {
  const map = new Map(current);
  for (const [price, quantity] of updates) quantity === '0' ? map.delete(price) : map.set(price, quantity);
  return [...map.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
}
function barStyle(quantity: string, color: string): React.CSSProperties { return { color, fontStyle: 'normal', textAlign: 'right', minWidth: 50, background: `linear-gradient(90deg, transparent 0%, ${color}33 ${Math.min(100, Number(quantity) || 0)}%)` }; }
function formatPrice(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—';
}

function iconFor(type: WorkspaceWidgetType): string {
  return ({ chart: '▥', footprint: '▤', heatmap: '▦', volumeProfile: '▥', cvdDelta: '∿', dom: '⇅', orderbook: '≋', trades: '≡', marketStats: '◌', paperTrading: '⌁', watchlist: '☆', replay: '↺' } as Record<WorkspaceWidgetType, string>)[type];
}
const buttonStyle = (accent: boolean): React.CSSProperties => ({ background: accent ? '#123d2d' : '#131a20', border: `1px solid ${accent ? '#1e9b68' : '#34404a'}`, borderRadius: 5, color: accent ? '#7bf0b5' : '#b5c0c8', padding: '5px 9px', fontSize: 12, cursor: 'pointer', boxShadow: '0 3px 12px #0008' });
const pillStyle: React.CSSProperties = { background: '#11181eeb', border: '1px solid #29353e', borderRadius: 4, color: '#aebbc4', padding: '5px 7px', fontSize: 11, whiteSpace: 'nowrap' };
const closeStyle: React.CSSProperties = { background: 'none', border: 0, color: '#71808b', cursor: 'pointer', padding: '0 0 0 5px', fontSize: 13 };
const pickerStyle: React.CSSProperties = { pointerEvents: 'auto', position: 'absolute', top: 38, left: 0, width: 360, maxHeight: 'calc(100vh - 110px)', overflowY: 'auto', background: '#10171d', border: '1px solid #33414b', borderRadius: 7, boxShadow: '0 14px 40px #000b', padding: '12px 12px 10px' };
const pickerHeader: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', color: '#e1e9ee', padding: '0 2px 10px', fontSize: 13 };
const groupLabel: React.CSSProperties = { color: '#697983', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.08em', padding: '9px 2px 5px' };
const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 };
const pickerItem: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left', background: '#161f26', border: '1px solid #26343d', borderRadius: 5, color: '#d8e0e5', padding: '8px 7px', cursor: 'pointer' };
const iconStyle: React.CSSProperties = { color: '#42d493', fontSize: 17, width: 18, textAlign: 'center' };
const domPanelStyle: React.CSSProperties = { position: 'absolute', top: 42, right: 0, width: 360, maxHeight: 'calc(100% - 52px)', overflow: 'auto', pointerEvents: 'auto', background: '#10171df2', border: '1px solid #34434d', borderRadius: 5, boxShadow: '0 8px 24px #000b' };
const domGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 10 };
const domRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 6, color: '#b8c5cc', fontSize: 10, padding: '3px 0', borderBottom: '1px solid #1e292f' };
const domSideBid: React.CSSProperties = { color: '#58d797', fontSize: 9 };
const domSideAsk: React.CSSProperties = { color: '#e28b91', fontSize: 9 };
const statsPanelStyle: React.CSSProperties = { position: 'absolute', top: 42, right: 0, width: 280, pointerEvents: 'auto', background: '#10171df2', border: '1px solid #34434d', borderRadius: 5, boxShadow: '0 8px 24px #000b' };
const statsGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 };
const statLabelStyle: React.CSSProperties = { color: '#71808a', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em' };
const statValueStyle: React.CSSProperties = { display: 'block', color: '#d8e3e8', fontSize: 13, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' };
const statsFootStyle: React.CSSProperties = { borderTop: '1px solid #293740', color: '#71808a', fontSize: 10, padding: '8px 12px' };
const tradePanelStyle: React.CSSProperties = { position: 'absolute', top: 42, right: 0, width: 280, maxHeight: 'calc(100% - 52px)', overflow: 'auto', pointerEvents: 'auto', background: '#10171df2', border: '1px solid #34434d', borderRadius: 5, boxShadow: '0 8px 24px #000b' };
const tradeHeaderStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', color: '#d6e0e5', fontSize: 11, padding: '9px 10px', borderBottom: '1px solid #293740' };
const tradeRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, padding: '5px 10px', borderBottom: '1px solid #1e292f', color: '#b8c5cc', fontSize: 11 };
const emptyTradeStyle: React.CSSProperties = { color: '#87949c', fontSize: 11, lineHeight: 1.5, padding: 18, textAlign: 'center' };
const capabilityTextStyle: React.CSSProperties = { display: 'block', color: '#71808a', fontSize: 9, fontStyle: 'normal', textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 3 };
const menuStyle: React.CSSProperties = { position: 'absolute', right: 0, top: 32, width: 220, background: '#10171d', border: '1px solid #33414b', borderRadius: 6, boxShadow: '0 12px 28px #000b', padding: '9px 0' };
const menuTitle: React.CSSProperties = { color: '#60717c', fontSize: 10, letterSpacing: '.08em', padding: '0 10px 4px' };
const menuItem: React.CSSProperties = { width: '100%', textAlign: 'left', border: 0, background: 'transparent', color: '#ccd6dc', cursor: 'pointer', padding: '7px 10px', fontSize: 12 };
