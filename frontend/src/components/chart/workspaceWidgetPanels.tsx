import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getBus, type BusDepth, type BusTrade } from '@/market-data/bus';
import { useCapabilities, useLiveQuote } from '@/market-data/hooks';
import { DepthHeatmapHistory, type HeatmapFrame } from '@/lib/depthHeatmap';
import { bucketPrints, FOOTPRINT_PERIODS, formatCompact, isBuyImbalance, isSellImbalance, MAX_RETAINED_PRINTS, timeframeToMs, type FootprintPeriod, type FootprintPrint } from '@/lib/footprintAggregator';
import { buildCvdSeries, type CvdPrint, type CvdSeries } from '@/lib/cvdSeries';
import { buildVolumeProfile, type ProfilePrint, type VolumeProfileResult } from '@/lib/volumeProfile';
import { applyPaperOrder, closePaperPosition, loadPaperAccount, paperUnrealized, savePaperAccount, type PaperAccount, type PaperFill } from '@/lib/paperTrading';
import { drawCvd } from './cvdCanvas';
import { drawHeatmap } from './heatmapCanvas';
import { resolveFlowSource } from '@/lib/flowSources';
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

const DOM_STALE_AFTER_MS = 3000;

export function DomPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const flow = useMemo(() => resolveFlowSource(widget.symbol || symbol), [widget.symbol, symbol]);
  const [levels, setLevels] = useState<8 | 12 | 16>(8);
  const [depth, setDepth] = useState<{ bids: Array<[string, string]>; asks: Array<[string, string]>; ready: boolean; reset?: string }>({ bids: [], asks: [], ready: false });
  const [lastEventAt, setLastEventAt] = useState(0);
  const [eventAgeMs, setEventAgeMs] = useState<number | null>(null);

  useEffect(() => {
    if (flow.status !== 'resolved') return undefined;
    const stream = flow.source.stream;
    setDepth({ bids: [], asks: [], ready: false });
    setLastEventAt(0);
    const bus = getBus();
    const stop = bus.stream([stream], flow.source.provider);
    const off = bus.subscribeDepth((event: BusDepth) => {
      if (event.symbol !== stream) return;
      setLastEventAt(Date.now());
      if (event.type === 'DEPTH_RESET') { setDepth({ bids: [], asks: [], ready: false, reset: String(event.reason || 'depth reset') }); return; }
      const bids = Array.isArray(event.bids || event.b) ? (event.bids || event.b) as Array<[string, string]> : [];
      const asks = Array.isArray(event.asks || event.a) ? (event.asks || event.a) as Array<[string, string]> : [];
      setDepth(previous => event.type === 'ORDER_BOOK_SNAPSHOT'
        ? { bids, asks, ready: false }
        : { bids: applyDepth(previous.bids, bids), asks: applyDepth(previous.asks, asks), ready: true });
    });
    return () => { off(); stop(); };
  }, [flow]);

  /* Measured staleness: a DOM that has not moved in seconds is not "live". */
  useEffect(() => {
    if (!lastEventAt) return undefined;
    const tick = setInterval(() => setEventAgeMs(Date.now() - lastEventAt), 1000);
    setEventAgeMs(Date.now() - lastEventAt);
    return () => clearInterval(tick);
  }, [lastEventAt]);

  if (flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left="DOM" right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.reason}</span><small>Depth is never substituted from another instrument.</small></EmptyNote></div>;
  }

  const stale = eventAgeMs != null && eventAgeMs > DOM_STALE_AFTER_MS;
  const topBid = depth.bids[0]?.[0];
  const topAsk = depth.asks[0]?.[0];
  const mid = topBid && topAsk ? (Number(topBid) + Number(topAsk)) / 2 : null;
  const spread = topBid && topAsk ? Number(topAsk) - Number(topBid) : null;
  const sumSide = (rows: Array<[string, string]>) => rows.slice(0, levels).reduce((sum, [, qty]) => sum + (Number(qty) || 0), 0);
  const bidSum = sumSide(depth.bids);
  const askSum = sumSide(depth.asks);
  const imbalance = bidSum + askSum > 0 ? ((bidSum - askSum) / (bidSum + askSum)) * 100 : null;
  const statusText = depth.ready ? (stale ? `Stale ${eventAgeMs != null ? Math.round(eventAgeMs / 1000) : ''}s` : 'Live') : 'Syncing';

  return <div style={bodyStyle}>
    <StatusStrip left={`DOM · ${flow.source.stream}`} right={statusText} tone={depth.ready ? (stale ? 'wait' : 'live') : 'wait'} />
    <div style={domToolbarStyle}>
      <div style={domSegmentStyle}>
        {([8, 12, 16] as const).map(count => <button key={count} type="button" onClick={() => setLevels(count)} style={{ ...domSegmentButtonStyle, color: levels === count ? '#7bf0b5' : '#71808a', borderColor: levels === count ? '#1e9b68' : '#26343d' }}>{count}</button>)}
      </div>
      <span style={sourceChipStyle}>{flow.source.label}</span>
    </div>
    {depth.ready ? <>
      <div style={domQuoteRowStyle}>
        <span>Mid <b style={{ color: '#d8e3e8' }}>{mid != null ? mid.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}</b></span>
        <span>Spread <b style={{ color: '#d8e3e8' }}>{spread != null ? spread.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}</b></span>
        <span>Imbalance <b style={{ color: imbalance != null && imbalance >= 0 ? '#58d797' : '#e28b91' }}>{imbalance != null ? `${imbalance >= 0 ? '+' : ''}${imbalance.toFixed(1)}%` : '—'}</b></span>
      </div>
      <div style={domGridStyle}>
        <div><strong style={domSideBid}>BIDS</strong>{depth.bids.slice(0, levels).reverse().map(([price, qty]) => <div key={`b${price}`} style={domRowStyle}><span>{price}</span><i style={barStyle(qty, '#318f69')}>{qty}</i></div>)}</div>
        <div><strong style={domSideAsk}>ASKS</strong>{depth.asks.slice(0, levels).map(([price, qty]) => <div key={`a${price}`} style={domRowStyle}><span>{price}</span><i style={barStyle(qty, '#b55e63')}>{qty}</i></div>)}</div>
      </div>
    </> : <EmptyNote>{depth.reset || 'Waiting for a validated snapshot and sequence bridge.'}<br /><small>No stale or synthetic levels are displayed.</small></EmptyNote>}
  </div>;
}

/* ---------------------------------- Footprint ---------------------------------- */

export function FootprintPanel({ widget, symbol, timeframe }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const tf = widget.timeframe || timeframe;
  const printsRef = useRef<FootprintPrint[]>([]);
  const dirtyRef = useRef(false);
  const [view, setView] = useState<{ periods: FootprintPeriod[]; ignoredNoSide: number }>({ periods: [], ignoredNoSide: 0 });
  useEffect(() => {
    if (!sym) return undefined;
    printsRef.current = [];
    dirtyRef.current = false;
    setView({ periods: [], ignoredNoSide: 0 });
    const bus = getBus();
    const stop = bus.stream([sym]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== sym || typeof trade.price !== 'number') return;
      printsRef.current.push({ tsMs: trade.tsMs, price: trade.price, size: typeof trade.size === 'number' ? trade.size : 0, side: trade.side === 'buy' || trade.side === 'sell' ? trade.side : null });
      if (printsRef.current.length > MAX_RETAINED_PRINTS) printsRef.current.splice(0, printsRef.current.length - MAX_RETAINED_PRINTS);
      dirtyRef.current = true;
    });
    /* Aggregation runs on a timer, not per print: a 500-trade/s burst never
     * schedules 500 renders. */
    const flush = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setView(bucketPrints(printsRef.current, timeframeToMs(tf), Date.now(), FOOTPRINT_PERIODS));
    }, 400);
    return () => { off(); stop(); clearInterval(flush); };
  }, [sym, tf]);
  const hasAny = view.periods.some(period => period.cells.length);
  return <div style={bodyStyle}>
    <StatusStrip left={`Footprint · ${tf} periods`} right={hasAny ? 'Real prints' : 'Waiting'} tone={hasAny ? 'live' : 'wait'} />
    {hasAny ? <div style={footColumnsStyle}>
      {view.periods.map((period, periodIndex) => <div key={period.startMs} style={{ ...footColumnStyle, borderStyle: periodIndex === view.periods.length - 1 ? 'dashed' : 'solid' }}>
        <div style={footColumnTimeStyle}>{new Date(period.startMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div>
        {period.cells.map((cell, index) => {
          const buyImb = isBuyImbalance(period.cells, index);
          const sellImb = isSellImbalance(period.cells, index);
          return <div key={cell.price} style={{ ...footCellStyle, background: buyImb ? '#318f6940' : sellImb ? '#b55e6340' : cell.price === period.poc ? '#e1b65c1f' : 'transparent' }}>
            <span style={{ color: '#8fa8b3' }}>{cell.price}</span>
            <span><b style={{ color: '#58d797', fontWeight: 600 }}>{formatCompact(cell.buy)}</b><span style={{ color: '#5f6e77' }}> × </span><b style={{ color: '#e28b91', fontWeight: 600 }}>{formatCompact(cell.sell)}</b></span>
          </div>;
        })}
        {!period.cells.length && <div style={footEmptyCell}>—</div>}
        <div style={{ ...footDeltaStyle, color: period.delta >= 0 ? '#58d797' : '#e28b91' }}>Δ {formatCompact(period.delta)}</div>
      </div>)}
    </div> : <EmptyNote>Waiting for provider trade prints with aggressor side.<br /><small>Buy/sell is never inferred from candle direction.</small></EmptyNote>}
    {hasAny && <div style={statsFootStyle}>Live prints since panel opened{view.ignoredNoSide ? ` · ${view.ignoredNoSide} prints lacked side data` : ''} · POC highlighted · 3:1 imbalances shaded</div>}
  </div>;
}

/* ---------------------------------- CVD / Delta ---------------------------------- */

export function CvdPanel({ widget, symbol, timeframe }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const tf = widget.timeframe || timeframe;
  const [mode, setMode] = useState<'cvd' | 'delta'>('cvd');
  const printsRef = useRef<CvdPrint[]>([]);
  const dirtyRef = useRef(false);
  const [series, setSeries] = useState<CvdSeries>({ periods: [], cumulative: [], buyTotal: 0, sellTotal: 0, ignoredNoSide: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!sym) return undefined;
    printsRef.current = [];
    dirtyRef.current = false;
    setSeries({ periods: [], cumulative: [], buyTotal: 0, sellTotal: 0, ignoredNoSide: 0 });
    const bus = getBus();
    const stop = bus.stream([sym]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== sym) return;
      printsRef.current.push({ tsMs: trade.tsMs, size: typeof trade.size === 'number' ? trade.size : 0, side: trade.side === 'buy' || trade.side === 'sell' ? trade.side : null });
      if (printsRef.current.length > MAX_RETAINED_PRINTS) printsRef.current.splice(0, printsRef.current.length - MAX_RETAINED_PRINTS);
      dirtyRef.current = true;
    });
    const flush = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setSeries(buildCvdSeries(printsRef.current, timeframeToMs(tf), Date.now(), 60));
    }, 400);
    return () => { off(); stop(); clearInterval(flush); };
  }, [sym, tf]);
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const draw = () => drawCvd(canvas, { width: wrap.clientWidth, height: wrap.clientHeight, series, mode, devicePixelRatio: window.devicePixelRatio || 1 });
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    draw();
    return () => observer.disconnect();
  }, [series, mode]);
  const last = series.cumulative[series.cumulative.length - 1] || 0;
  const reset = () => { printsRef.current = []; dirtyRef.current = false; setSeries({ periods: [], cumulative: [], buyTotal: 0, sellTotal: 0, ignoredNoSide: 0 }); };
  return <div style={bodyStyle}>
    <StatusStrip left={`${mode === 'cvd' ? 'Cumulative delta' : 'Period delta'} · ${tf}`} right={formatPrice(last)} tone={last >= 0 ? 'live' : 'wait'} />
    <div style={domToolbarStyle}>
      <div style={domSegmentStyle}>
        {(['cvd', 'delta'] as const).map(value => <button key={value} type="button" onClick={() => setMode(value)} style={{ ...domSegmentButtonStyle, color: mode === value ? '#7bf0b5' : '#71808a', borderColor: mode === value ? '#1e9b68' : '#26343d' }}>{value === 'cvd' ? 'CVD' : 'Δ bars'}</button>)}
        <button type="button" onClick={reset} title="Reset the session accumulation" style={{ ...domSegmentButtonStyle, color: '#84949d' }}>Reset</button>
      </div>
      <span style={{ color: '#71808a', fontSize: 9 }}>buy {formatCompact(series.buyTotal)} · sell {formatCompact(series.sellTotal)}</span>
    </div>
    <div ref={wrapRef} style={heatWrapStyle}>
      {series.periods.length ? <canvas ref={canvasRef} style={heatCanvasStyle} /> : <EmptyNote>Waiting for provider trade prints.<br /><small>Side is never inferred from price movement.</small></EmptyNote>}
    </div>
    <div style={statsFootStyle}>{series.ignoredNoSide ? `Provider omitted aggressor side on ${series.ignoredNoSide} prints — delta is not complete.` : 'Aggressor side supplied by the provider only.'}</div>
  </div>;
}

/* ----------------------------------- Heatmap ----------------------------------- */

export function HeatmapPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const flow = useMemo(() => resolveFlowSource(widget.symbol || symbol), [widget.symbol, symbol]);
  const historyRef = useRef<DepthHeatmapHistory | null>(null);
  const [frames, setFrames] = useState<HeatmapFrame[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (flow.status !== 'resolved') return undefined;
    const stream = flow.source.stream;
    const history = new DepthHeatmapHistory(240);
    historyRef.current = history;
    setFrames([]);
    const bus = getBus();
    const stop = bus.stream([stream], flow.source.provider);
    const off = bus.subscribeDepth((event: BusDepth) => {
      if (event.symbol !== stream) return;
      const frame = history.apply(event);
      if (frame) setFrames(history.snapshot());
      if (event.type === 'DEPTH_RESET') setFrames([]);
    });
    return () => { off(); stop(); historyRef.current = null; };
  }, [flow]);
  /* Redraw on new frames AND on panel resize (widget drag-resize included). */
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas || flow.status !== 'resolved') return undefined;
    const draw = () => drawHeatmap(canvas, { width: wrap.clientWidth, height: wrap.clientHeight, frames, devicePixelRatio: window.devicePixelRatio || 1 });
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    draw();
    return () => observer.disconnect();
  }, [frames, flow]);
  if (flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left="Resting liquidity history" right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.reason}</span><small>Heatmap is never painted from candles or trade prints.</small></EmptyNote></div>;
  }
  return <div style={bodyStyle}>
    <StatusStrip left={`Liquidity · ${flow.source.stream}`} right={frames.length ? `${frames.length} frames` : 'Waiting'} tone={frames.length ? 'live' : 'wait'} />
    <div ref={wrapRef} style={heatWrapStyle}>
      {frames.length ? <canvas ref={canvasRef} style={heatCanvasStyle} /> : <EmptyNote>Building liquidity history…<br /><small>Only validated Binance L2 frames — never candle volume or trade prints.</small></EmptyNote>}
    </div>
    <div style={statsFootStyle}>Intensity = resting size vs visible max · green bids / red asks · dashed line = best mid</div>
  </div>;
}

/* -------------------------------- Volume Profile -------------------------------- */

export function VolumeProfilePanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const [mode, setMode] = useState<'volume' | 'delta'>('volume');
  const printsRef = useRef<ProfilePrint[]>([]);
  const dirtyRef = useRef(false);
  const [profile, setProfile] = useState<VolumeProfileResult | null>(null);
  useEffect(() => {
    if (!sym) return undefined;
    printsRef.current = [];
    dirtyRef.current = false;
    setProfile(null);
    const bus = getBus();
    const stop = bus.stream([sym]);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== sym || typeof trade.price !== 'number') return;
      printsRef.current.push({ price: trade.price, size: typeof trade.size === 'number' ? trade.size : 0, side: trade.side === 'buy' || trade.side === 'sell' ? trade.side : null });
      if (printsRef.current.length > MAX_RETAINED_PRINTS) printsRef.current.splice(0, printsRef.current.length - MAX_RETAINED_PRINTS);
      dirtyRef.current = true;
    });
    const flush = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setProfile(buildVolumeProfile(printsRef.current, 24));
    }, 600);
    return () => { off(); stop(); clearInterval(flush); };
  }, [sym]);
  return <div style={bodyStyle}>
    <StatusStrip left={`Session profile · ${sym || '—'}`} right={profile ? `POC ${profile.poc != null ? profile.poc.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}` : 'Waiting'} tone={profile ? 'live' : 'wait'} />
    <div style={domToolbarStyle}>
      <div style={domSegmentStyle}>
        {(['volume', 'delta'] as const).map(value => <button key={value} type="button" onClick={() => setMode(value)} style={{ ...domSegmentButtonStyle, color: mode === value ? '#7bf0b5' : '#71808a', borderColor: mode === value ? '#1e9b68' : '#26343d' }}>{value === 'volume' ? 'Volume' : 'Delta'}</button>)}
      </div>
      {profile && <span style={{ color: '#71808a', fontSize: 9 }}>VAH {profile.vah?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? '—'} · VAL {profile.val?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? '—'}</span>}
    </div>
    {profile ? <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 0' }}>
      {profile.rows.map(row => {
        const share = row.total / profile.maxRowVolume;
        const delta = row.buy - row.sell;
        const isPoc = row.price === profile.poc;
        const isVa = profile.vah != null && profile.val != null && row.price <= profile.vah && row.price >= profile.val;
        return <div key={row.price} style={{ ...vpRowStyle, borderLeft: isPoc ? '2px solid #e1b65c' : '2px solid transparent', background: isVa ? '#e1b65c10' : 'transparent' }}>
          <span style={vpPriceStyle}>{row.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
          {mode === 'volume' ? <span style={vpBarTrackStyle}>
            <i style={{ ...vpFillStyle, width: `${(row.buy / (row.buy + row.sell || 1)) * share * 100}%`, background: '#318f6990' }} />
            <i style={{ ...vpFillStyle, width: `${(row.sell / (row.buy + row.sell || 1)) * share * 100}%`, background: '#b55e6390' }} />
          </span> : <span style={vpBarTrackStyle}>
            <i style={{ ...vpDeltaStyle, width: `${Math.min(100, Math.abs(delta) / (profile.maxRowVolume || 1) * 100)}%`, background: delta >= 0 ? '#318f69aa' : '#b55e63aa', alignSelf: delta >= 0 ? 'flex-end' : 'flex-start' }} />
          </span>}
          <span style={{ ...vpTagStyle, color: isPoc ? '#e1b65c' : row.hvn ? '#8bb7e8' : row.lvn ? '#5f6e77' : 'transparent' }}>{isPoc ? 'POC' : row.hvn ? 'HVN' : row.lvn ? 'LVN' : '·'}</span>
        </div>;
      })}
    </div> : <EmptyNote>Waiting for verified trade volume.<br /><small>Candle volume is never used as a substitute.</small></EmptyNote>}
    {profile && <div style={statsFootStyle}>Prints since panel opened · buy/sell split from provider aggressor only · value area = 70%</div>}
  </div>;
}

/* -------------------------------- Paper Trading -------------------------------- */

export function PaperTradingPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const { quote, connected } = useLiveQuote(sym || null, undefined, true);
  const [account, setAccount] = useState<PaperAccount>(() => loadPaperAccount(widget.id));
  const [qtyText, setQtyText] = useState('0.01');
  const [notice, setNotice] = useState('');
  useEffect(() => { setAccount(loadPaperAccount(widget.id)); setNotice(''); }, [widget.id, sym]);
  const commit = (result: { account: PaperAccount; fill: PaperFill }) => {
    setAccount(result.account);
    savePaperAccount(widget.id, result.account);
    setNotice(result.fill.pnl != null ? `${result.fill.message} · P&L ${result.fill.pnl >= 0 ? '+' : ''}${result.fill.pnl.toFixed(2)}` : result.fill.message);
  };
  const qty = Number(qtyText);
  const mark = typeof quote?.price === 'number' ? quote.price : 0;
  const position = account.position && account.position.symbol === sym ? account.position : null;
  const unrealized = position && mark > 0 ? paperUnrealized(position, mark) : null;
  return <div style={bodyStyle}>
    <StatusStrip left={`Paper trading · ${sym || '—'}`} right={connected ? 'Live marks' : 'Offline'} tone={connected ? 'live' : 'wait'} />
    <div style={paperBannerStyle}>SIMULATION ONLY — no real orders, no broker, no risk.</div>
    <div style={{ padding: '10px 12px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={statLabelStyle}>Qty</span>
        <input value={qtyText} onChange={event => setQtyText(event.target.value)} inputMode="decimal" aria-label="Order quantity" style={symbolInputStyle2} />
        <span style={{ color: '#71808a', fontSize: 10 }}>@ {mark > 0 ? mark.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—'}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" onClick={() => commit(applyPaperOrder(account, sym, 'buy', qty, mark))} style={paperBuyStyle}>BUY / LONG</button>
        <button type="button" onClick={() => commit(applyPaperOrder(account, sym, 'sell', qty, mark))} style={paperSellStyle}>SELL / SHORT</button>
        <button type="button" onClick={() => commit(closePaperPosition(account, mark))} style={paperFlatStyle}>FLATTEN</button>
      </div>
      {notice && <div style={{ color: '#84949d', fontSize: 10 }}>{notice}</div>}
    </div>
    <div style={paperPositionStyle}>
      {position ? <>
        <div><span style={statLabelStyle}>Position</span><strong style={{ ...statValueStyle, color: position.side === 'long' ? '#58d797' : '#e28b91' }}>{position.side.toUpperCase()} {position.qty} @ {position.entry.toLocaleString(undefined, { maximumFractionDigits: 8 })}</strong></div>
        <div><span style={statLabelStyle}>Unrealized</span><strong style={{ ...statValueStyle, color: unrealized != null && unrealized >= 0 ? '#58d797' : '#e28b91' }}>{unrealized != null ? `${unrealized >= 0 ? '+' : ''}${unrealized.toFixed(2)}` : '—'}</strong></div>
      </> : <div><span style={statLabelStyle}>Position</span><strong style={statValueStyle}>Flat</strong></div>}
      <div><span style={statLabelStyle}>Realized (session)</span><strong style={{ ...statValueStyle, color: account.realized >= 0 ? '#58d797' : '#e28b91' }}>{account.realized >= 0 ? '+' : ''}{account.realized.toFixed(2)}</strong></div>
      <div><span style={statLabelStyle}>Fills</span><strong style={statValueStyle}>{account.trades}</strong></div>
    </div>
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
  paperTrading: PaperTradingPanel,
};

function barStyle(quantity: string, color: string): React.CSSProperties {
  return { color, fontStyle: 'normal', textAlign: 'right', minWidth: 50, background: `linear-gradient(90deg, transparent 0%, ${color}33 ${Math.min(100, Number(quantity) || 0)}%)` };
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
const domToolbarStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 10px', borderBottom: '1px solid #1e292f' };
const domSegmentStyle: React.CSSProperties = { display: 'flex', gap: 3 };
const domSegmentButtonStyle: React.CSSProperties = { border: '1px solid #26343d', borderRadius: 3, background: 'transparent', cursor: 'pointer', fontSize: 10, padding: '2px 7px' };
const sourceChipStyle: React.CSSProperties = { color: '#6f8a7d', fontSize: 8, letterSpacing: '.06em', textTransform: 'uppercase', border: '1px solid #23413a', borderRadius: 3, padding: '2px 5px' };
const domQuoteRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 10px', color: '#71808a', fontSize: 10, borderBottom: '1px solid #1e292f' };
const domRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 6, color: '#b8c5cc', fontSize: 10, padding: '3px 0', borderBottom: '1px solid #1e292f' };
const domSideBid: React.CSSProperties = { color: '#58d797', fontSize: 9 };
const domSideAsk: React.CSSProperties = { color: '#e28b91', fontSize: 9 };
const footColumnsStyle: React.CSSProperties = { display: 'flex', alignItems: 'stretch', gap: 6, padding: '8px 10px', overflowX: 'auto', flex: 1, minHeight: 0 };
const footColumnStyle: React.CSSProperties = { flex: '0 0 108px', display: 'flex', flexDirection: 'column', border: '1px solid #26343d', borderRadius: 4, overflow: 'hidden', background: '#0e151b' };
const footColumnTimeStyle: React.CSSProperties = { textAlign: 'center', color: '#71808a', fontSize: 9, padding: '4px 2px', borderBottom: '1px solid #1e292f', background: '#121b21' };
const footCellStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 4, padding: '3px 6px', fontSize: 9, borderBottom: '1px solid #1a2329' };
const footEmptyCell: React.CSSProperties = { color: '#4d5c64', textAlign: 'center', padding: '10px 0', fontSize: 9 };
const footDeltaStyle: React.CSSProperties = { marginTop: 'auto', textAlign: 'center', fontSize: 10, fontWeight: 700, padding: '4px 2px', borderTop: '1px solid #1e292f', background: '#121b21' };
const heatWrapStyle: React.CSSProperties = { flex: 1, minHeight: 0, position: 'relative' };
const heatCanvasStyle: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' };
const vpRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '92px 1fr 40px', gap: 8, alignItems: 'center', padding: '3px 10px' };
const vpPriceStyle: React.CSSProperties = { color: '#8fa8b3', fontSize: 9, textAlign: 'right' };
const vpBarTrackStyle: React.CSSProperties = { display: 'flex', height: 11, background: '#121b21', borderRadius: 2, overflow: 'hidden' };
const vpFillStyle: React.CSSProperties = { display: 'block', height: '100%' };
const vpDeltaStyle: React.CSSProperties = { display: 'block', height: '100%' };
const vpTagStyle: React.CSSProperties = { fontSize: 8, fontWeight: 700, letterSpacing: '.05em', textAlign: 'right' };
const paperBannerStyle: React.CSSProperties = { margin: '8px 10px 0', padding: '6px 9px', border: '1px dashed #e1a650', borderRadius: 4, color: '#e1a650', fontSize: 9, letterSpacing: '.05em', textTransform: 'uppercase', textAlign: 'center' };
const symbolInputStyle2: React.CSSProperties = { width: 90, background: '#0d141a', border: '1px solid #26343d', borderRadius: 3, color: '#d8e3e8', fontSize: 11, padding: '4px 6px' };
const paperBuyStyle: React.CSSProperties = { flex: 1, border: '1px solid #1e9b68', borderRadius: 4, background: '#123d2d', color: '#7bf0b5', cursor: 'pointer', padding: '8px 0', fontSize: 11, fontWeight: 700 };
const paperSellStyle: React.CSSProperties = { flex: 1, border: '1px solid #b55e63', borderRadius: 4, background: '#3d1518', color: '#f0a0a5', cursor: 'pointer', padding: '8px 0', fontSize: 11, fontWeight: 700 };
const paperFlatStyle: React.CSSProperties = { flex: 1, border: '1px solid #34404a', borderRadius: 4, background: '#131a20', color: '#b5c0c8', cursor: 'pointer', padding: '8px 0', fontSize: 11 };
const paperPositionStyle: React.CSSProperties = { margin: '0 10px 10px', padding: '10px 12px', borderTop: '1px solid #293740', display: 'grid', gap: 10 };
const profileRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1.5fr .5fr', gap: 7, color: '#c0cbd0', fontSize: 10, padding: '4px 10px', borderTop: '1px solid #1e292f' };
