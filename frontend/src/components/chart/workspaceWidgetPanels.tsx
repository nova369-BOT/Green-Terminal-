import React, { useEffect, useRef, useState } from 'react';
import { getBus, type BusDepth, type BusTrade } from '@/market-data/bus';
import { useCapabilities, useLiveQuote } from '@/market-data/hooks';
import { DepthHeatmapHistory, type HeatmapFrame } from '@/lib/depthHeatmap';
import type { WorkspaceWidget, WorkspaceWidgetType } from '@/lib/workspaceWidgets';

/**
 * Live widget renderers for the native workspace.
 *
 * One component per widget type. Each panel owns its own data subscription:
 * it subscribes while mounted (i.e. while the panel is visible in the grid)
 * and unsubscribes on unmount. Panels never synthesize data — no candles as
 * volume, no quotes as trades, no inferred aggressor side.
 */

export interface WidgetPanelProps {
  widget: WorkspaceWidget;
  symbol: string;
  timeframe: string;
}

function formatPrice(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 8 })
    : '—';
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return <div><div style={statLabelStyle}>{label}</div><strong style={statValueStyle}>{value}</strong></div>;
}

function applyDepth(current: Array<[string, string]>, updates: Array<[string, string]>): Array<[string, string]> {
  const map = new Map(current);
  for (const [price, quantity] of updates) quantity === '0' ? map.delete(price) : map.set(price, quantity);
  return [...map.entries()].sort((a, b) => Number(b[0]) - Number(a[0]));
}

function StatusStrip({ left, right, tone }: { left: string; right: string; tone: 'live' | 'wait' | 'muted' }): JSX.Element {
  const color = tone === 'live' ? '#58d797' : tone === 'wait' ? '#e1a650' : '#71808a';
  return <div style={statusStripStyle}><b>{left}</b><span style={{ color }}>{right}</span></div>;
}

function EmptyNote({ children }: { children: React.ReactNode }): JSX.Element {
  return <div style={emptyStyle}>{children}</div>;
}

/* ---------------------------------- Trades ---------------------------------- */

export function TradesPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const [trades, setTrades] = useState<BusTrade[]>([]);
  useEffect(() => {
    if (!sym) return undefined;
    const bus = getBus();
    const stop = bus.stream([sym]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== sym) return;
      setTrades(previous => [trade, ...previous].slice(0, 24));
    });
    return () => { off(); stop(); };
  }, [sym]);
  return <div style={bodyStyle}>
    <StatusStrip left="Time & Sales" right={trades.length ? `Live · ${trades.length} prints` : 'Waiting'} tone={trades.length ? 'live' : 'wait'} />
    {trades.length ? trades.map((trade, index) => <div key={`${trade.tsMs}-${index}`} style={tradeRowStyle}>
      <time>{new Date(trade.tsMs).toLocaleTimeString()}</time>
      <strong style={{ color: trade.side === 'buy' ? '#58d797' : trade.side === 'sell' ? '#e28b91' : '#b8c5cc' }}>{formatPrice(trade.price)}</strong>
      <span>{trade.size == null ? '—' : trade.size}</span>
    </div>) : <EmptyNote>No verified trade prints received yet.<br /><small>The panel populates only from the selected live provider.</small></EmptyNote>}
  </div>;
}

/* ------------------------------ Market statistics ------------------------------ */

export function MarketStatsPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const { quote, connected, lastTickAgeMs } = useLiveQuote(sym || null, undefined, true);
  return <div style={bodyStyle}>
    <StatusStrip left={sym || 'No symbol'} right={connected ? 'Connected' : 'Offline'} tone={connected ? 'live' : 'wait'} />
    <div style={statsGridStyle}>
      <Stat label="Last" value={formatPrice(quote?.price)} />
      <Stat label="Bid" value={formatPrice(quote?.bid)} />
      <Stat label="Ask" value={formatPrice(quote?.ask)} />
      <Stat label="Source" value={quote?.source || '—'} />
    </div>
    <div style={statsFootStyle}>{lastTickAgeMs == null ? 'No live tick received.' : `Last tick ${Math.round(lastTickAgeMs / 100) / 10}s ago.`}</div>
  </div>;
}

/* ------------------------------------- DOM ------------------------------------- */

export function DomPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const [depth, setDepth] = useState<{ bids: Array<[string, string]>; asks: Array<[string, string]>; ready: boolean; reset?: string }>({ bids: [], asks: [], ready: false });
  useEffect(() => {
    if (!sym) return undefined;
    setDepth({ bids: [], asks: [], ready: false });
    const bus = getBus();
    const stop = bus.stream([sym], 'binance-depth');
    const off = bus.subscribeDepth((event: BusDepth) => {
      if (event.symbol !== sym) return;
      if (event.type === 'DEPTH_RESET') { setDepth({ bids: [], asks: [], ready: false, reset: String(event.reason || 'depth reset') }); return; }
      const bids = Array.isArray(event.bids || event.b) ? (event.bids || event.b) as Array<[string, string]> : [];
      const asks = Array.isArray(event.asks || event.a) ? (event.asks || event.a) as Array<[string, string]> : [];
      setDepth(previous => event.type === 'ORDER_BOOK_SNAPSHOT'
        ? { bids, asks, ready: false }
        : { bids: applyDepth(previous.bids, bids), asks: applyDepth(previous.asks, asks), ready: true });
    });
    return () => { off(); stop(); };
  }, [sym]);
  return <div style={bodyStyle}>
    <StatusStrip left="DOM · Binance L2" right={depth.ready ? 'Live' : 'Syncing'} tone={depth.ready ? 'live' : 'wait'} />
    {depth.ready ? <div style={domGridStyle}>
      <div><strong style={domSideBid}>BIDS</strong>{depth.bids.slice(0, 8).reverse().map(([price, qty]) => <div key={`b${price}`} style={domRowStyle}><span>{price}</span><i style={barStyle(qty, '#318f69')}>{qty}</i></div>)}</div>
      <div><strong style={domSideAsk}>ASKS</strong>{depth.asks.slice(0, 8).map(([price, qty]) => <div key={`a${price}`} style={domRowStyle}><span>{price}</span><i style={barStyle(qty, '#b55e63')}>{qty}</i></div>)}</div>
    </div> : <EmptyNote>{depth.reset || 'Waiting for a validated snapshot and sequence bridge.'}<br /><small>No stale or synthetic levels are displayed.</small></EmptyNote>}
  </div>;
}

/* ---------------------------------- Footprint ---------------------------------- */

export function FootprintPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const [footprint, setFootprint] = useState<Record<string, { buy: number; sell: number }>>({});
  useEffect(() => {
    if (!sym) return undefined;
    setFootprint({});
    const bus = getBus();
    const stop = bus.stream([sym]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== sym || !trade.side || typeof trade.price !== 'number') return;
      setFootprint(previous => {
        const key = String(trade.price);
        const row = previous[key] || { buy: 0, sell: 0 };
        const size = typeof trade.size === 'number' ? trade.size : 0;
        return { ...previous, [key]: trade.side === 'buy' ? { ...row, buy: row.buy + size } : { ...row, sell: row.sell + size } };
      });
    });
    return () => { off(); stop(); };
  }, [sym]);
  const rows = Object.entries(footprint).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 18);
  return <div style={bodyStyle}>
    <StatusStrip left="Footprint · live prints" right={rows.length ? 'Real prints' : 'Waiting'} tone={rows.length ? 'live' : 'wait'} />
    <div style={footprintHeaderStyle}><span>Price</span><span>Buy × Sell</span><span>Delta</span></div>
    {rows.map(([price, row]) => <div key={price} style={footprintRowStyle}><span>{price}</span><span>{row.buy} × {row.sell}</span><strong style={{ color: row.buy - row.sell >= 0 ? '#58d797' : '#e28b91' }}>{row.buy - row.sell}</strong></div>)}
    {!rows.length && <EmptyNote>Waiting for provider trade prints with aggressor side.<br /><small>Buy/sell is never inferred from candle direction.</small></EmptyNote>}
  </div>;
}

/* ---------------------------------- CVD / Delta ---------------------------------- */

export function CvdPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const [cvd, setCvd] = useState({ value: 0, buy: 0, sell: 0, sideKnown: true });
  useEffect(() => {
    if (!sym) return undefined;
    setCvd({ value: 0, buy: 0, sell: 0, sideKnown: true });
    const bus = getBus();
    const stop = bus.stream([sym]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== sym) return;
      setCvd(previous => {
        const size = typeof trade.size === 'number' ? trade.size : 0;
        if (!trade.side) return { ...previous, sideKnown: false };
        return trade.side === 'buy'
          ? { ...previous, value: previous.value + size, buy: previous.buy + size }
          : { ...previous, value: previous.value - size, sell: previous.sell + size };
      });
    });
    return () => { off(); stop(); };
  }, [sym]);
  return <div style={bodyStyle}>
    <StatusStrip left="Cumulative delta" right={formatPrice(cvd.value)} tone={cvd.value >= 0 ? 'live' : 'wait'} />
    <div style={statsGridStyle}>
      <Stat label="Aggressive buy" value={formatPrice(cvd.buy)} />
      <Stat label="Aggressive sell" value={formatPrice(cvd.sell)} />
    </div>
    {!cvd.sideKnown && <div style={statsFootStyle}>Provider has not supplied aggressor side; delta is not complete.</div>}
  </div>;
}

/* ----------------------------------- Heatmap ----------------------------------- */

export function HeatmapPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const historyRef = useRef<DepthHeatmapHistory | null>(null);
  const [frames, setFrames] = useState<HeatmapFrame[]>([]);
  useEffect(() => {
    if (!sym) return undefined;
    const history = new DepthHeatmapHistory(240);
    historyRef.current = history;
    setFrames([]);
    const bus = getBus();
    const stop = bus.stream([sym], 'binance-depth');
    const off = bus.subscribeDepth((event: BusDepth) => {
      if (event.symbol !== sym) return;
      const frame = history.apply(event);
      if (frame) setFrames(history.snapshot());
      if (event.type === 'DEPTH_RESET') setFrames([]);
    });
    return () => { off(); stop(); historyRef.current = null; };
  }, [sym]);
  const recent = frames.slice(-12);
  return <div style={bodyStyle}>
    <StatusStrip left="Resting liquidity history" right={frames.length ? `${frames.length} frames` : 'Waiting'} tone={frames.length ? 'live' : 'wait'} />
    {recent.length ? <div style={{ padding: '4px 10px 10px' }}>{recent.map((frame, index) => <div key={`${frame.receivedAt}-${index}`} style={heatmapFrameStyle}>
      <time>{new Date(frame.receivedAt).toLocaleTimeString()}</time>
      <span style={{ color: '#58d797' }}>B {frame.bids.length}</span>
      <span style={{ color: '#e28b91' }}>A {frame.asks.length}</span>
    </div>)}</div> : <EmptyNote>Waiting for validated depth frames.<br /><small>Only resting Binance L2 liquidity is recorded — never candle volume.</small></EmptyNote>}
  </div>;
}

/* -------------------------------- Volume Profile -------------------------------- */

export function VolumeProfilePanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const [profile, setProfile] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!sym) return undefined;
    setProfile({});
    const bus = getBus();
    const stop = bus.stream([sym]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== sym || typeof trade.price !== 'number') return;
      setProfile(previous => {
        const key = String(trade.price);
        return { ...previous, [key]: (previous[key] || 0) + (typeof trade.size === 'number' ? trade.size : 0) };
      });
    });
    return () => { off(); stop(); };
  }, [sym]);
  const rows = Object.entries(profile).sort((a, b) => b[1] - a[1]).slice(0, 18);
  const max = rows[0]?.[1] || 1;
  return <div style={bodyStyle}>
    <StatusStrip left="Volume by price" right={Object.keys(profile).length ? `${Object.keys(profile).length} prices` : 'Waiting'} tone={rows.length ? 'live' : 'wait'} />
    {rows.map(([price, volume], index) => <div key={price} style={profileRowStyle}>
      <span>{price}</span>
      <i style={profileBarStyle(volume, max)}>{volume.toFixed(4)}</i>
      {index === 0 && <strong style={{ color: '#e1b65c' }}>POC</strong>}
    </div>)}
    {!rows.length && <EmptyNote>Waiting for verified trade volume.<br /><small>Candle volume is never used as a substitute.</small></EmptyNote>}
  </div>;
}

/* ---------------------------- Truthful unavailable ---------------------------- */

export function UnsupportedPanel({ widget }: WidgetPanelProps): JSX.Element {
  const { caps } = useCapabilities();
  const label = widget.source || (caps ? 'Provider capability pending' : 'Capability catalog loading');
  return <div style={emptyStyle}>
    <strong>{widget.title}</strong>
    <span>No verified renderer is active for this widget yet.</span>
    <small>{label}</small>
  </div>;
}

/** Widget type → live renderer. Types missing here resolve to UnsupportedPanel
 * so the workspace never implies data it cannot supply. */
export const WIDGET_PANELS: Partial<Record<WorkspaceWidgetType, (props: WidgetPanelProps) => JSX.Element>> = {
  trades: TradesPanel,
  marketStats: MarketStatsPanel,
  dom: DomPanel,
  footprint: FootprintPanel,
  cvdDelta: CvdPanel,
  heatmap: HeatmapPanel,
  volumeProfile: VolumeProfilePanel,
};

function barStyle(quantity: string, color: string): React.CSSProperties {
  return { color, fontStyle: 'normal', textAlign: 'right', minWidth: 50, background: `linear-gradient(90deg, transparent 0%, ${color}33 ${Math.min(100, Number(quantity) || 0)}%)` };
}
function profileBarStyle(value: number, max: number): React.CSSProperties {
  return { color: '#8bb7e8', fontStyle: 'normal', background: `linear-gradient(90deg, #366a9d55 ${Math.min(100, (value / max) * 100)}%, transparent 0)` };
}

const bodyStyle: React.CSSProperties = { height: '100%', minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' };
const statusStripStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#d6e0e5', fontSize: 11, padding: '7px 10px', borderBottom: '1px solid #293740', position: 'sticky', top: 0, background: '#10171d', zIndex: 1 };
const emptyStyle: React.CSSProperties = { color: '#87949c', fontSize: 11, lineHeight: 1.5, padding: 18, textAlign: 'center', display: 'grid', placeContent: 'center', gap: 4, height: '100%' };
const tradeRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, padding: '5px 10px', borderBottom: '1px solid #1e292f', color: '#b8c5cc', fontSize: 11 };
const statsGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 };
const statsFootStyle: React.CSSProperties = { borderTop: '1px solid #293740', color: '#71808a', fontSize: 10, padding: '8px 12px' };
const statLabelStyle: React.CSSProperties = { color: '#71808a', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em' };
const statValueStyle: React.CSSProperties = { display: 'block', color: '#d8e3e8', fontSize: 13, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' };
const domGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 10 };
const domRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 6, color: '#b8c5cc', fontSize: 10, padding: '3px 0', borderBottom: '1px solid #1e292f' };
const domSideBid: React.CSSProperties = { color: '#58d797', fontSize: 9 };
const domSideAsk: React.CSSProperties = { color: '#e28b91', fontSize: 9 };
const footprintHeaderStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1.4fr .6fr', color: '#71808a', fontSize: 9, padding: '8px 10px 4px', textTransform: 'uppercase' };
const footprintRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1.4fr .6fr', color: '#c0cbd0', fontSize: 10, padding: '4px 10px', borderTop: '1px solid #1e292f' };
const heatmapFrameStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr .5fr .5fr', gap: 8, color: '#aab8bf', fontSize: 10, padding: '5px 0', borderTop: '1px solid #1e292f' };
const profileRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1.5fr .5fr', gap: 7, color: '#c0cbd0', fontSize: 10, padding: '4px 10px', borderTop: '1px solid #1e292f' };
