import React, { useEffect, useRef, useState } from 'react';
import { getBus, type BusDepth, type BusTrade } from '@/market-data/bus';
import { useLiveQuote } from '@/market-data/hooks';
import { useCapabilities } from '@/market-data/hooks';
import { resolveWidgetCapability } from '@/lib/widgetCapabilities';
import { DepthHeatmapHistory, type HeatmapFrame } from '@/lib/depthHeatmap';
import {
  addWorkspaceWidget,
  applyWorkspacePreset,
  DEFAULT_WORKSPACE_WIDGETS,
  propagateWorkspaceLink,
  loadWorkspaceWidgets,
  removeWorkspaceWidget,
  reorderWorkspaceWidget,
  saveWorkspaceWidgets,
  toggleWorkspaceLink,
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
  const [footprint, setFootprint] = useState<Record<string, { buy: number; sell: number }>>({});
  const [volumeProfile, setVolumeProfile] = useState<Record<string, number>>({});
  const [cvd, setCvd] = useState({ value: 0, buy: 0, sell: 0, sideKnown: true });
  const [depth, setDepth] = useState<{ bids: Array<[string, string]>; asks: Array<[string, string]>; ready: boolean; reset?: string }>({ bids: [], asks: [], ready: false });
  const [heatmapFrames, setHeatmapFrames] = useState<HeatmapFrame[]>([]);
  const { caps } = useCapabilities();
  const tradesOpen = widgets.some(widget => widget.type === 'trades' && widget.visible);
  const statsOpen = widgets.some(widget => widget.type === 'marketStats' && widget.visible);
  const domOpen = widgets.some(widget => widget.type === 'dom' && widget.visible);
  const cvdOpen = widgets.some(widget => widget.type === 'cvdDelta' && widget.visible);
  const footprintOpen = widgets.some(widget => widget.type === 'footprint' && widget.visible);
  const heatmapOpen = widgets.some(widget => widget.type === 'heatmap' && widget.visible);
  const profileOpen = widgets.some(widget => widget.type === 'volumeProfile' && widget.visible);
  const { quote, connected, lastTickAgeMs } = useLiveQuote(symbol || null, undefined, statsOpen);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setWidgets(loadWorkspaceWidgets()), []);
  useEffect(() => {
    if (!symbol) return;
    setWidgets(previous => {
      const chart = previous.find(widget => widget.type === 'chart');
      return chart ? propagateWorkspaceLink(previous, chart.id, symbol, timeframe) : previous;
    });
  }, [symbol, timeframe]);
  useEffect(() => {
    if ((!domOpen && !heatmapOpen) || !symbol) { setDepth({ bids: [], asks: [], ready: false }); setHeatmapFrames([]); return; }
    const history = new DepthHeatmapHistory(240);
    const bus = getBus();
    const stop = bus.stream([symbol], 'binance-depth');
    const off = bus.subscribeDepth((event: BusDepth) => {
      if (event.symbol !== symbol) return;
      const frame = history.apply(event);
      if (frame && heatmapOpen) setHeatmapFrames(history.snapshot());
      if (event.type === 'DEPTH_RESET') { setDepth({ bids: [], asks: [], ready: false, reset: String(event.reason || 'depth reset') }); return; }
      const bids = Array.isArray(event.bids || event.b) ? (event.bids || event.b) as Array<[string, string]> : [];
      const asks = Array.isArray(event.asks || event.a) ? (event.asks || event.a) as Array<[string, string]> : [];
      setDepth(previous => event.type === 'ORDER_BOOK_SNAPSHOT' ? { bids, asks, ready: false } : { bids: applyDepth(previous.bids, bids), asks: applyDepth(previous.asks, asks), ready: true });
    });
    return () => { off(); stop(); };
  }, [symbol, domOpen, heatmapOpen]);
  useEffect(() => {
    if ((!tradesOpen && !cvdOpen && !footprintOpen && !profileOpen) || !symbol) { setTrades([]); setCvd({ value: 0, buy: 0, sell: 0, sideKnown: true }); setFootprint({}); setVolumeProfile({}); return; }
    const bus = getBus();
    const stop = bus.stream([symbol]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== symbol) return;
      if (tradesOpen) setTrades(previous => [trade, ...previous].slice(0, 24));
      if (profileOpen && typeof trade.price === 'number') setVolumeProfile(previous => {
        const key = String(trade.price);
        return { ...previous, [key]: (previous[key] || 0) + (typeof trade.size === 'number' ? trade.size : 0) };
      });
      if (footprintOpen && trade.side && typeof trade.price === 'number') setFootprint(previous => {
        const key = String(trade.price);
        const row = previous[key] || { buy: 0, sell: 0 };
        const size = typeof trade.size === 'number' ? trade.size : 0;
        return { ...previous, [key]: trade.side === 'buy' ? { ...row, buy: row.buy + size } : { ...row, sell: row.sell + size } };
      });
      if (cvdOpen) setCvd(previous => {
        const size = typeof trade.size === 'number' ? trade.size : 0;
        if (!trade.side) return { ...previous, sideKnown: false };
        return trade.side === 'buy'
          ? { ...previous, value: previous.value + size, buy: previous.buy + size }
          : { ...previous, value: previous.value - size, sell: previous.sell + size };
      });
    });
    return () => { off(); stop(); };
  }, [symbol, tradesOpen, cvdOpen, footprintOpen, profileOpen]);
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
            <span key={widget.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/green-terminal-widget', widget.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
              event.preventDefault();
              const dragged = event.dataTransfer.getData('text/green-terminal-widget');
              if (dragged) setWidgets(reorderWorkspaceWidget(widgets, dragged, widget.id));
            }} style={{ ...pillStyle, cursor: 'grab' }} title={`${WIDGET_DEFS[widget.type].description} Source: ${widget.source || 'AUTO'}${widget.productType ? ` · ${widget.productType}` : ''}`}>
              {widget.title}
              <button type="button" aria-label={`Toggle symbol link for ${widget.title}`} onClick={(event) => { event.stopPropagation(); setWidgets(toggleWorkspaceLink(widgets, widget.id, 'symbol')); }} style={{ ...closeStyle, color: widget.symbolLink === 'linked' ? '#58d797' : '#71808a' }}>S</button>
              <button type="button" aria-label={`Toggle timeframe link for ${widget.title}`} onClick={(event) => { event.stopPropagation(); setWidgets(toggleWorkspaceLink(widgets, widget.id, 'timeframe')); }} style={{ ...closeStyle, color: widget.timeframeLink === 'linked' ? '#58d797' : '#71808a' }}>T</button>
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
          <div style={{ ...menuTitle, marginTop: 8 }}>PANEL PRESETS</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, padding: '3px 10px 7px' }}>
            {(['1', '2', '4', '16'] as const).map(preset => <button key={preset} type="button" onClick={() => { setWidgets(applyWorkspacePreset(widgets, preset)); setMenu(false); }} style={{ ...menuItem, border: '1px solid #2b3942', borderRadius: 3, padding: '5px 2px', textAlign: 'center' }}>{preset}</button>)}
          </div>
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
      {heatmapOpen && <div style={heatmapPanelStyle}>
        <div style={tradeHeaderStyle}><b>Heatmap · resting liquidity</b><span>{heatmapFrames.length ? `${heatmapFrames.length} frames` : 'Waiting'}</span></div>
        {heatmapFrames.length ? <div style={heatmapBodyStyle}>{heatmapFrames.slice(-12).map((frame, index) => <div key={`${frame.receivedAt}-${index}`} style={heatmapFrameStyle}><time>{new Date(frame.receivedAt).toLocaleTimeString()}</time><span style={{ color: '#58d797' }}>B {frame.bids.length}</span><span style={{ color: '#e28b91' }}>A {frame.asks.length}</span></div>)}</div> : <div style={emptyTradeStyle}>Waiting for validated depth frames.<br /><small>Only resting Binance L2 liquidity is recorded.</small></div>}
      </div>}
      {domOpen && <div style={domPanelStyle}>
        <div style={tradeHeaderStyle}><b>DOM · Binance L2</b><span style={{ color: depth.ready ? '#58d797' : '#e1a650' }}>{depth.ready ? 'Live' : 'Syncing'}</span></div>
        {depth.ready ? <div style={domGridStyle}><div><strong style={domSideBid}>BIDS</strong>{depth.bids.slice(0, 8).reverse().map(([price, qty]) => <div key={`b${price}`} style={domRowStyle}><span>{price}</span><i style={barStyle(qty, '#318f69')}>{qty}</i></div>)}</div><div><strong style={domSideAsk}>ASKS</strong>{depth.asks.slice(0, 8).map(([price, qty]) => <div key={`a${price}`} style={domRowStyle}><span>{price}</span><i style={barStyle(qty, '#b55e63')}>{qty}</i></div>)}</div></div> : <div style={emptyTradeStyle}>{depth.reset || 'Waiting for a validated snapshot and sequence bridge.'}<br /><small>No stale or synthetic levels are displayed.</small></div>}
      </div>}
      {profileOpen && <div style={statsPanelStyle}>
        <div style={tradeHeaderStyle}><b>Volume Profile · live</b><span>{Object.keys(volumeProfile).length} prices</span></div>
        {Object.entries(volumeProfile).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([price, volume], index) => <div key={price} style={profileRowStyle}><span>{price}</span><i style={profileBarStyle(volume, Object.entries(volumeProfile).sort((a, b) => b[1] - a[1])[0]?.[1] || 1)}>{volume.toFixed(4)}</i>{index === 0 && <strong style={{ color: '#e1b65c' }}>POC</strong>}</div>)}
        {!Object.keys(volumeProfile).length && <div style={emptyTradeStyle}>Waiting for verified trade volume.</div>}
      </div>}
      {footprintOpen && <div style={statsPanelStyle}>
        <div style={tradeHeaderStyle}><b>Footprint · live</b><span>Real prints</span></div>
        <div style={footprintHeaderStyle}><span>Price</span><span>Buy × Sell</span><span>Delta</span></div>
        {Object.entries(footprint).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 18).map(([price, row]) => <div key={price} style={footprintRowStyle}><span>{price}</span><span>{row.buy} × {row.sell}</span><strong style={{ color: row.buy - row.sell >= 0 ? '#58d797' : '#e28b91' }}>{row.buy - row.sell}</strong></div>)}
        {!Object.keys(footprint).length && <div style={emptyTradeStyle}>Waiting for provider trade prints with aggressor side.</div>}
      </div>}
      {cvdOpen && <div style={statsPanelStyle}>
        <div style={tradeHeaderStyle}><b>CVD / Delta · live</b><span style={{ color: cvd.value >= 0 ? '#58d797' : '#e28b91' }}>{formatPrice(cvd.value)}</span></div>
        <div style={cvdBodyStyle}><div><span style={statLabelStyle}>Aggressive buy</span><strong style={statValueStyle}>{formatPrice(cvd.buy)}</strong></div><div><span style={statLabelStyle}>Aggressive sell</span><strong style={statValueStyle}>{formatPrice(cvd.sell)}</strong></div></div>
        {!cvd.sideKnown && <div style={statsFootStyle}>Provider has not supplied aggressor side; delta is not complete.</div>}
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
const heatmapPanelStyle: React.CSSProperties = { position: 'absolute', top: 42, right: 0, width: 300, maxHeight: 'calc(100% - 52px)', overflow: 'auto', pointerEvents: 'auto', background: '#10171df2', border: '1px solid #34434d', borderRadius: 5, boxShadow: '0 8px 24px #000b' };
const heatmapBodyStyle: React.CSSProperties = { padding: '4px 10px 10px' };
const heatmapFrameStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr .5fr .5fr', gap: 8, color: '#aab8bf', fontSize: 10, padding: '5px 0', borderTop: '1px solid #1e292f' };
const domPanelStyle: React.CSSProperties = { position: 'absolute', top: 42, right: 0, width: 360, maxHeight: 'calc(100% - 52px)', overflow: 'auto', pointerEvents: 'auto', background: '#10171df2', border: '1px solid #34434d', borderRadius: 5, boxShadow: '0 8px 24px #000b' };
const domGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 10 };
const domRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 6, color: '#b8c5cc', fontSize: 10, padding: '3px 0', borderBottom: '1px solid #1e292f' };
const domSideBid: React.CSSProperties = { color: '#58d797', fontSize: 9 };
const domSideAsk: React.CSSProperties = { color: '#e28b91', fontSize: 9 };
const statsPanelStyle: React.CSSProperties = { position: 'absolute', top: 42, right: 0, width: 280, minWidth: 220, minHeight: 120, pointerEvents: 'auto', resize: 'both', overflow: 'auto', background: '#10171df2', border: '1px solid #34434d', borderRadius: 5, boxShadow: '0 8px 24px #000b' };
const statsGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 };
const cvdBodyStyle: React.CSSProperties = { ...statsGridStyle, borderTop: '1px solid #293740' };
const profileRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1.5fr .5fr', gap: 7, color: '#c0cbd0', fontSize: 10, padding: '4px 10px', borderTop: '1px solid #1e292f' };
function profileBarStyle(value: number, max: number): React.CSSProperties { return { color: '#8bb7e8', fontStyle: 'normal', background: `linear-gradient(90deg, #366a9d55 ${Math.min(100, value / max * 100)}%, transparent 0)` }; }
const footprintHeaderStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1.4fr .6fr', color: '#71808a', fontSize: 9, padding: '8px 10px 4px', textTransform: 'uppercase' };
const footprintRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1.4fr .6fr', color: '#c0cbd0', fontSize: 10, padding: '4px 10px', borderTop: '1px solid #1e292f' };
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
