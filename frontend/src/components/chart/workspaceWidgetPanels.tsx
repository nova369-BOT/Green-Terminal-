import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBus, type BusDepth, type BusTrade } from '@/market-data/bus';
import { useCapabilities, useLiveQuote } from '@/market-data/hooks';
import { DepthHeatmapHistory, type HeatmapFrame } from '@/lib/depthHeatmap';
import { bucketPrints, FOOTPRINT_PERIODS, formatCompact, isBuyImbalance, isSellImbalance, MAX_RETAINED_PRINTS, timeframeToMs, type FootprintPeriod, type FootprintPrint } from '@/lib/footprintAggregator';
import { buildCvdSeries, type CvdPrint, type CvdSeries } from '@/lib/cvdSeries';
import { buildVolumeProfile, type ProfilePrint, type VolumeProfileResult } from '@/lib/volumeProfile';
import { applyPaperOrder, closePaperPosition, loadPaperAccount, paperUnrealized, savePaperAccount, type PaperAccount, type PaperFill } from '@/lib/paperTrading';
import { drawCvd } from './cvdCanvas';
import { drawHeatmap } from './heatmapCanvas';
import { buildLadderModel, decimalsForTick, deriveTickFromPrices, formatPrice as fmtLadderPrice, oceanLuminance, oceanRgb, priceKey, resolveCenterKey, TradeAtPriceAccumulator, RESET_PRESETS, type LadderCurrentModel, type LadderRowModel } from '@/lib/domLadder';
import { resolveFlowSource, useAdaptiveFlowSource, useFlowCatalogVersion, noteFlowVenueEvent, type AdaptiveFlow } from '@/lib/flowSources';
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

/** Banner shown when the Binance venue is measurably down and the panel is
 * reading the Hyperliquid Perp fallback — never hidden, never silent. */
function SwapBanner({ flow }: { flow: AdaptiveFlow }): JSX.Element | null {
  if (!flow.swapped) return null;
  return <div style={swapBannerStyle}>{flow.swapReason}</div>;
}

function formatPrice(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 8 })
    : '—';
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return <div style={statsCellStyle}><div style={statLabelStyle}>{label}</div><strong style={statValueStyle}>{value}</strong></div>;
}

/** Binance semantics: a level with absolute quantity 0 means REMOVE. The
 * venue emits fixed-precision strings ("0.00000000"), so compare numerically —
 * the old `quantity === '0'` never matched and dead levels accumulated.
 * Bids sort best-first DESC; asks sort best-first ASC (the old single DESC
 * sort put the highest ask on top and inverted the book / spread / mid). */
function applyDepth(current: Array<[string, string]>, updates: Array<[string, string]>, side: 'bid' | 'ask'): Array<[string, string]> {
  const map = new Map(current);
  for (const [price, quantity] of updates) Number(quantity) === 0 ? map.delete(price) : map.set(price, quantity);
  const rows = [...map.entries()];
  return side === 'bid'
    ? rows.sort((a, b) => Number(b[0]) - Number(a[0]))
    : rows.sort((a, b) => Number(a[0]) - Number(b[0]));
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
  /* Venue resolution, same rule as the DOM: subscribe the resolved venue
   * stream (BTCUSDT) — the raw display symbol (BTC/USD) is not a Binance
   * stream id, so subscribing it only produced reset loops and an empty
   * tape. Trades also filter on the venue stream id, never the display
   * name. Adaptive: Binance down ⇒ Hyperliquid Perp, banner-disclosed. */
  const flow = useAdaptiveFlowSource(sym);
  const stream = flow.flow.status === 'resolved' ? flow.flow.source.stream : null;
  const [trades, setTrades] = useState<BusTrade[]>([]);
  useEffect(() => {
    if (!stream || flow.flow.status !== 'resolved') { setTrades([]); return undefined; }
    const provider = flow.flow.source.provider;
    const bus = getBus();
    const stop = bus.stream([stream], provider);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== stream) return;
      noteFlowVenueEvent(provider, 'data');
      setTrades(previous => [trade, ...previous].slice(0, 24));
    });
    return () => { off(); stop(); };
  }, [stream, flow]);
  if (flow.flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left="Time & Sales" right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.flow.reason}</span></EmptyNote></div>;
  }
  return <div style={bodyStyle}>
    <StatusStrip left={`Time & Sales · ${stream}`} right={trades.length ? `Live · ${trades.length} prints` : 'Waiting'} tone={trades.length ? 'live' : 'wait'} />
    <SwapBanner flow={flow} />
    {trades.length ? trades.map((trade, index) => <div key={`${trade.tsMs}-${index}`} style={tradeRowStyle}>
      <time>{new Date(trade.tsMs).toLocaleTimeString()}</time>
      <strong style={{ color: trade.side === 'buy' ? '#58d797' : trade.side === 'sell' ? '#e28b91' : '#b8c5cc' }}>{formatPrice(trade.price)}</strong>
      <span>{trade.size == null ? '—' : trade.size}</span>
    </div>) : <EmptyNote>No verified trade prints received yet.<br /><small>The panel populates only from the selected live provider.</small></EmptyNote>}
  </div>;
}

/* ------------------------------ Market statistics ------------------------------ */

/** A cell the venue feed cannot fill. Shown honestly, never derived. */
function NotProvided({ label }: { label: string }): JSX.Element {
  return <div style={statsCellStyle}><div style={statLabelStyle}>{label}</div><strong style={statValueStyle}>—</strong><small style={notProvidedStyle}>NOT PROVIDED</small></div>;
}

export function MarketStatsPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const flow = useAdaptiveFlowSource(sym);
  const resolved = flow.flow.status === 'resolved' ? flow.flow.source : null;
  /* The display symbol alone ("BTC/USD") is not a provider stream and the
   * subscribe carries no provider hint → the hub rejects with "provider
   * required" and no tick ever arrived. Follow the resolved venue stream;
   * Binance down ⇒ Hyperliquid Perp with an honest banner. */
  const { quote, connected, lastTickAgeMs } = useLiveQuote(resolved?.stream ?? null, resolved?.provider, true);
  /* The normalized tick carries price/bid/ask/source only. Mark, index,
   * funding, open interest and the 24h set are NOT published into this feed
   * today, so they render NOT PROVIDED instead of candle-derived guesses. */
  if (flow.flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left={`${sym || 'No symbol'} · expanded`} right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.flow.reason}</span></EmptyNote></div>;
  }
  return <div style={bodyStyle}>
    <StatusStrip left={`${(resolved?.stream ?? sym) || 'No symbol'} · expanded`} right={connected ? (quote ? 'Connected' : 'Connecting') : 'Offline'} tone={quote ? 'live' : connected ? 'wait' : 'muted'} />
    <SwapBanner flow={flow} />
    <div style={statsCellGridStyle}>
      <Stat label="Last" value={formatPrice(quote?.price)} />
      <Stat label="Bid" value={formatPrice(quote?.bid)} />
      <Stat label="Ask" value={formatPrice(quote?.ask)} />
      <Stat label="Source" value={quote?.source || '—'} />
      <NotProvided label="Mark price" />
      <NotProvided label="Index" />
      <NotProvided label="Funding" />
      <NotProvided label="Open interest" />
      <NotProvided label="24h volume" />
      <NotProvided label="24h high" />
      <NotProvided label="24h low" />
      <NotProvided label="24h change" />
    </div>
    <div style={statsFootStyle}>{lastTickAgeMs == null ? 'No live tick received.' : `Last tick ${Math.round(lastTickAgeMs / 100) / 10}s ago.`} NOT PROVIDED cells are fields the venue feed does not publish — never derived from candles.</div>
  </div>;
}

/* ------------------------------ Shared depth hook ------------------------------ */

interface DepthBookState { bids: Array<[string, string]>; asks: Array<[string, string]>; ready: boolean; reset?: string; }

/** One validated L2 pipeline for every depth consumer (DOM, Orderbook):
 * resolve the venue stream, subscribe, apply sequence-safe updates, and
 * expose the freshness timestamp the UI turns into Live/Stale. */
function useResolvedDepth(widget: WorkspaceWidget, symbol: string): { flow: AdaptiveFlow; depth: DepthBookState; lastEventAt: number } {
  const flow = useAdaptiveFlowSource(widget.symbol || symbol);
  const [depth, setDepth] = useState<DepthBookState>({ bids: [], asks: [], ready: false });
  const [lastEventAt, setLastEventAt] = useState(0);
  useEffect(() => {
    if (flow.flow.status !== 'resolved') return undefined;
    const stream = flow.flow.source.stream;
    const provider = flow.flow.source.provider;
    setDepth({ bids: [], asks: [], ready: false });
    setLastEventAt(0);
    const bus = getBus();
    const stop = bus.stream([stream], provider);
    const off = bus.subscribeDepth((event: BusDepth) => {
      if (event.symbol !== stream) return;
      setLastEventAt(Date.now());
      if (event.type === 'DEPTH_RESET') {
        noteFlowVenueEvent(provider, 'reset', String(event.reason || 'depth reset'));
        setDepth({ bids: [], asks: [], ready: false, reset: String(event.reason || 'depth reset') });
        return;
      }
      noteFlowVenueEvent(provider, 'data');
      const bids = Array.isArray(event.bids || event.b) ? (event.bids || event.b) as Array<[string, string]> : [];
      const asks = Array.isArray(event.asks || event.a) ? (event.asks || event.a) as Array<[string, string]> : [];
      setDepth(previous => event.type === 'ORDER_BOOK_SNAPSHOT'
        /* Snapshot feeds whose frames are entire books (Hyperliquid l2Book,
         * marked full_book) are live on the FIRST frame — there is no diff
         * sequence to bridge. Binance diffs stay bridged: snapshot alone
         * never renders until a sequence-validated update lands. */
        ? { bids: [...bids].sort((a, b) => Number(b[0]) - Number(a[0])), asks: [...asks].sort((a, b) => Number(a[0]) - Number(b[0])), ready: Boolean(event.full_book) }
        : { bids: applyDepth(previous.bids, bids, 'bid'), asks: applyDepth(previous.asks, asks, 'ask'), ready: true });
    });
    return () => { off(); stop(); };
  }, [flow]);
  return { flow, depth, lastEventAt };
}

function useStaleness(lastEventAt: number, staleAfterMs: number): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!lastEventAt) { setStale(false); return undefined; }
    const update = () => setStale(Date.now() - lastEventAt > staleAfterMs);
    update();
    const tick = setInterval(update, 1000);
    return () => clearInterval(tick);
  }, [lastEventAt, staleAfterMs]);
  return stale;
}

function bookStats(depth: DepthBookState, levels: number): { mid: number | null; spread: number | null; imbalance: number | null } {
  const topBid = depth.bids[0]?.[0];
  const topAsk = depth.asks[0]?.[0];
  const mid = topBid && topAsk ? (Number(topBid) + Number(topAsk)) / 2 : null;
  const spread = topBid && topAsk ? Number(topAsk) - Number(topBid) : null;
  const sumSide = (rows: Array<[string, string]>) => rows.slice(0, levels).reduce((sum, [, qty]) => sum + (Number(qty) || 0), 0);
  const bidSum = sumSide(depth.bids);
  const askSum = sumSide(depth.asks);
  const imbalance = bidSum + askSum > 0 ? ((bidSum - askSum) / (bidSum + askSum)) * 100 : null;
  return { mid, spread, imbalance };
}

/* ------------------------------------- DOM ------------------------------------- */

const DOM_STALE_AFTER_MS = 3000;

/**
 * DOM (Depth of Market) — G-Flow parity port of ui/dom_widget.cpp.
 *
 * Structure (identical to the original):
 *   BUYS | BIDS | PRICE | ASKS | SELLS | DELTA   (trade columns toggleable)
 *   ask rows (highest first) → CURRENT row (BRAND chip + session totals)
 *   → bid rows (best first), all on a tick grid centered at the trade price
 *   with mid-book boot fallback; scroll via wheel / ↑ / ↓, Home recenters.
 *
 * Performance contract (identical to the original row-model cache): the
 * ladder model is rebuilt only when an input actually changed — book state
 * object identity, accumulator revision, center tick, scroll, grouping,
 * units — never per animation frame and never on unrelated renders.
 *
 * Honesty contract (identical to the original): the tick grid is derived
 * from the venue's own quoted precision; there is no invented ladder. Until
 * the book is ready the pending state is shown. Deltas accumulate only from
 * observed prints with a side — nothing is inferred from book shape.
 */
export function DomPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const { flow, depth, lastEventAt } = useResolvedDepth(widget, symbol);
  const stale = useStaleness(lastEventAt, DOM_STALE_AFTER_MS);
  const resolved = flow.flow.status === 'resolved' ? flow.flow : null;
  const streamId = resolved ? resolved.source.stream : 'none';

  const [levels, setLevels] = useState<8 | 12 | 16>(12);
  const [groupMult, setGroupMult] = useState<1 | 10 | 100>(1);
  const [displayUsd, setDisplayUsd] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoCenter, setAutoCenter] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [flowWindow, setFlowWindow] = useState<'manual' | '5m' | '15m' | '1h' | 'session'>('5m');
  const [accRev, setAccRev] = useState(0);
  const [lastTradePrice, setLastTradePrice] = useState<number | null>(null);

  const accRef = useRef<TradeAtPriceAccumulator>(new TradeAtPriceAccumulator(1));
  const ladderRef = useRef<HTMLDivElement | null>(null);
  const currentRowRef = useRef<HTMLDivElement | null>(null);

  /* Late-bind the instrument (refresh_instrument parity): a venue swap or
   * symbol change invalidates the old grid AND the old tape — their buckets
   * were hashed on that instrument's prices. Fresh accumulator, fresh grid. */
  useEffect(() => {
    accRef.current = new TradeAtPriceAccumulator(1);
    accRef.current.setResetMode('periodic', RESET_PRESETS.FIVE_MIN);
    setScrollOffset(0);
    setAutoCenter(true);
    setLastTradePrice(null);
    setFlowWindow('5m');
    setAccRev(0);
  }, [streamId]);

  /* The honest grid: tick = venue-quoted precision of the observed book
   * prices (never metadata-guessed). Rebuilt maps re-key levels onto the
   * tick grid exactly the way the C++ row builder looks them up. */
  const derivedBook = useMemo(() => {
    if (!depth.ready) return null;
    const strings: string[] = [];
    for (const [price] of depth.bids) strings.push(price);
    for (const [price] of depth.asks) strings.push(price);
    const tick = strings.length ? deriveTickFromPrices(strings) : 0;
    if (!(tick > 0)) return null;
    if (accRef.current.getTick() !== tick) accRef.current.setTickSize(tick);
    const bids = new Map<number, number>();
    for (const [price, qty] of depth.bids) {
      const p = Number(price); const q = Number(qty);
      if (p > 0 && q > 0) bids.set(priceKey(p, tick), q);
    }
    const asks = new Map<number, number>();
    for (const [price, qty] of depth.asks) {
      const p = Number(price); const q = Number(qty);
      if (p > 0 && q > 0) asks.set(priceKey(p, tick), q);
    }
    const bestBid = depth.bids.length ? Number(depth.bids[0][0]) : null;
    const bestAsk = depth.asks.length ? Number(depth.asks[0][0]) : null;
    return { tick, decimals: decimalsForTick(tick), bids, asks, bestBid, bestAsk };
  }, [depth]);

  /* Tape → accumulator. Only prints with a venue-side and a size buy/sell
   * bucket; malformed prints are dropped by addTrade itself. */
  useEffect(() => {
    if (!resolved) return undefined;
    const provider = resolved.source.provider;
    const bus = getBus();
    const off = bus.subscribeTrade((trade: BusTrade) => {
      if (trade.symbol !== resolved.source.stream) return;
      if (typeof trade.price !== 'number' || typeof trade.size !== 'number') return;
      if (trade.side !== 'buy' && trade.side !== 'sell') return;
      setLastTradePrice(trade.price);
      if (accRef.current.addTrade(trade.price, trade.size, trade.side === 'buy')) {
        setAccRev(accRef.current.revision());
      }
      noteFlowVenueEvent(provider, 'data');
    });
    return off;
  }, [resolved]);

  /* Flow-window watchdog (check_auto_reset parity): periodic/session reset
   * decisions happen on wall-clock time, not on prints — a dead tape must
   * still reset its window. */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const before = accRef.current.revision();
      accRef.current.checkAutoReset(Date.now());
      if (accRef.current.revision() !== before) setAccRev(accRef.current.revision());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const applyFlowWindow = (window_: typeof flowWindow): void => {
    setFlowWindow(window_);
    const acc = accRef.current;
    if (window_ === 'manual') acc.setResetMode('manual');
    else if (window_ === 'session') acc.setResetMode('session');
    else acc.setResetMode('periodic', window_ === '5m' ? RESET_PRESETS.FIVE_MIN : window_ === '15m' ? RESET_PRESETS.FIFTEEN_MIN : RESET_PRESETS.ONE_HOUR);
    setAccRev(acc.revision());
  };
  const resetFlow = (): void => { accRef.current.reset(); setAccRev(accRef.current.revision()); };

  /* update() centering parity: auto-center follows the last trade (mid-book
   * boot fallback) quantised to the tick grid; touching scroll disengages. */
  const centerKey = derivedBook && autoCenter
    ? resolveCenterKey({ lastPrice: lastTradePrice, bestBid: derivedBook.bestBid, bestAsk: derivedBook.bestAsk, tick: derivedBook.tick })
    : 0;

  const model = useMemo(() => {
    if (!derivedBook || centerKey <= 0) return null;
    return buildLadderModel({
      bids: { byTick: derivedBook.bids },
      asks: { byTick: derivedBook.asks },
      lastPrice: lastTradePrice,
      centerKey,
      scrollOffset,
      groupMult,
      levelsPerSide: levels,
      tick: derivedBook.tick,
      decimals: derivedBook.decimals,
      displayUsd,
      showTradeColumns: true,
      accumulator: accRef.current,
    });
    // accRev pins the cache to accumulator revision — same role the C++
    // cache_acc_rev_ field plays in the rebuild gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedBook, centerKey, scrollOffset, groupMult, levels, displayUsd, accRev, lastTradePrice]);

  /* Keyboard parity (handle_keyboard_input): ↑/↓ shift the ladder one row,
   * Home recenters. Wheel parity (handle_mouse_input): wheel moves the
   * window, never the page. */
  const shiftWindow = useCallback((delta: number) => {
    setAutoCenter(false);
    setScrollOffset(previous => previous + delta);
  }, []);
  useEffect(() => {
    const node = ladderRef.current;
    if (!node) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      shiftWindow(event.deltaY > 0 ? -1 : 1);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [shiftWindow]);
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowUp') { event.preventDefault(); shiftWindow(1); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); shiftWindow(-1); }
    else if (event.key === 'Home') { event.preventDefault(); setScrollOffset(0); setAutoCenter(true); }
  };

  /* SetScrollHereY(0.5) parity: while auto-center is on, every re-center
   * keeps the current-price chip vertically centered in the viewport. */
  useEffect(() => {
    if (!autoCenter) return;
    const scroll = ladderRef.current;
    const chip = currentRowRef.current;
    if (!scroll || !chip) return;
    scroll.scrollTop = Math.max(0, chip.offsetTop - scroll.clientHeight / 2 + chip.offsetHeight / 2);
  }, [autoCenter, model]);

  if (flow.flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left="DOM" right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.flow.reason}</span><small>Depth is never substituted from another instrument.</small></EmptyNote></div>;
  }

  const flowLabel = flowWindow === 'manual' ? 'Manual' : flowWindow === 'session' ? 'Session' : flowWindow;

  return <div style={bodyStyle}>
    <StatusStrip left={`DOM · ${flow.flow.source.stream}`} right={depth.ready ? (stale ? 'Stale' : 'Live') : 'Syncing'} tone={depth.ready && !stale ? 'live' : 'wait'} />
    <SwapBanner flow={flow} />
    <div style={{ ...domToolbarStyle, position: 'relative' }}>
      <div style={domSegmentStyle}>
        <button type="button" onClick={() => { setAutoCenter(!autoCenter); if (!autoCenter) setScrollOffset(0); }} style={{ ...domSegmentButtonStyle, color: autoCenter ? '#7bf0b5' : '#71808a', borderColor: autoCenter ? '#1e9b68' : '#26343d' }}>Auto center</button>
        <button type="button" onClick={() => setSettingsOpen(!settingsOpen)} style={{ ...domSegmentButtonStyle, color: settingsOpen ? '#7bf0b5' : '#b8c5cc', borderColor: settingsOpen ? '#1e9b68' : '#26343d' }}>
          {displayUsd ? 'USD' : 'Coin'} / {flowLabel} · SETTINGS
        </button>
      </div>
      <div style={domSegmentStyle}>
        {([8, 12, 16] as const).map(count => <button key={count} type="button" onClick={() => setLevels(count)} style={{ ...domSegmentButtonStyle, color: levels === count ? '#7bf0b5' : '#71808a', borderColor: levels === count ? '#1e9b68' : '#26343d' }}>{count}</button>)}
      </div>
      {settingsOpen ? <>
        <button type="button" aria-label="Close settings" onClick={() => setSettingsOpen(false)} style={domSettingsBackdrop} />
        <div style={domSettingsPop}>
          <div style={domSettingsSection}>PRICE GROUPING</div>
          <div style={domSegmentStyle}>
            {([1, 10, 100] as const).map(mult => <button key={mult} type="button" onClick={() => { setGroupMult(mult); setScrollOffset(0); setAutoCenter(true); }} style={{ ...domSegmentButtonStyle, color: groupMult === mult ? '#7bf0b5' : '#71808a', borderColor: groupMult === mult ? '#1e9b68' : '#26343d' }}>
              {derivedBook ? fmtLadderPrice(derivedBook.tick * mult, derivedBook.decimals) : `x${mult}`}
            </button>)}
          </div>
          <div style={domSettingsSection}>DISPLAY UNITS</div>
          <div style={domSegmentStyle}>
            <button type="button" onClick={() => setDisplayUsd(false)} style={{ ...domSegmentButtonStyle, color: !displayUsd ? '#7bf0b5' : '#71808a', borderColor: !displayUsd ? '#1e9b68' : '#26343d' }}>Coin</button>
            <button type="button" onClick={() => setDisplayUsd(true)} style={{ ...domSegmentButtonStyle, color: displayUsd ? '#7bf0b5' : '#71808a', borderColor: displayUsd ? '#1e9b68' : '#26343d' }}>USD</button>
          </div>
          <div style={domSettingsSection}>CUMULATIVE FLOW</div>
          <div style={{ ...domSegmentStyle, flexWrap: 'wrap' }}>
            {(['manual', '5m', '15m', '1h', 'session'] as const).map(w => <button key={w} type="button" onClick={() => applyFlowWindow(w)} style={{ ...domSegmentButtonStyle, color: flowWindow === w ? '#7bf0b5' : '#71808a', borderColor: flowWindow === w ? '#1e9b68' : '#26343d' }}>
              {w === 'manual' ? 'Manual' : w === 'session' ? 'Session' : `Every ${w}`}
            </button>)}
          </div>
          <button type="button" onClick={resetFlow} style={{ ...domSegmentButtonStyle, marginTop: 8, color: '#e1a650', borderColor: '#3d3424', width: '100%' }}>Reset accumulated flow</button>
        </div>
      </> : null}
    </div>
    {!model ? <EmptyNote>
      {depth.ready ? 'Waiting for the first print to center the ladder.' : (depth.reset || 'Waiting for a validated snapshot and sequence bridge.')}
      <br /><small>No stale or synthetic levels are displayed — the grid renders only on the venue&apos;s own quotes.</small>
    </EmptyNote> : <div ref={ladderRef} tabIndex={0} onKeyDown={onKeyDown} style={domLadderStyle}>
      <div style={domHeadRowStyle}>
        <span style={{ ...domHeadCell, textAlign: 'right' }}>BUYS</span>
        <span style={{ ...domHeadCell, textAlign: 'right' }}>BIDS</span>
        <span style={{ ...domHeadCell, textAlign: 'center' }}>PRICE</span>
        <span style={{ ...domHeadCell, textAlign: 'left' }}>ASKS</span>
        <span style={{ ...domHeadCell, textAlign: 'right' }}>SELLS</span>
        <span style={{ ...domHeadCell, textAlign: 'right' }}>DELTA</span>
      </div>
      {model.asks.map(row => <LadderLevelRow key={`a${row.price}`} row={row} side="ask" />)}
      <DomCurrentRow ref={currentRowRef} model={model.current} />
      {model.bids.map(row => <LadderLevelRow key={`b${row.price}`} row={row} side="bid" />)}
      <div style={domFootNoteStyle}>
        {flow.swapped ? `${flow.flow.source.label} · FALLBACK · ` : `${flow.flow.source.label} · `}TAPE-VERIFIED · ↑↓ SCROLL · HOME RECENTERS
      </div>
    </div>}
  </div>;
}

/** One ask/bid ladder row — render_level_row port. Grove ramp bar anchored
 * to the price column, luminance-aware ink, trade columns faint by side. */
function LadderLevelRow({ row, side }: { row: LadderRowModel; side: 'ask' | 'bid' }): JSX.Element {
  const isAsk = side === 'ask';
  const showBook = isAsk ? row.hasSize : row.hasSize;
  const barT = 0.12 + row.depthFrac * 0.88;
  const barColor = oceanRgb(barT);
  const ink = oceanLuminance(barT) > 0.45 ? '#11150f' : '#eef3ef';
  const barWidth = `${Math.max(2, row.depthFrac * 100)}%`;
  return <div style={domRowGrid}>
    <span style={{ ...domCellRight, color: 'rgba(50,200,120,.55)' }}>{row.hasBuy ? row.buyText : ''}</span>
    <span style={domDepthCell}>
      {showBook && !isAsk ? <span style={{ ...domDepthBar, right: 0, width: barWidth, background: barColor }}>
        <span style={{ ...domDepthText, color: ink }}>{row.sizeText}</span>
      </span> : null}
    </span>
    <span style={domPriceCell}>{row.priceText}</span>
    <span style={domDepthCell}>
      {showBook && isAsk ? <span style={{ ...domDepthBar, left: 0, width: barWidth, background: barColor }}>
        <span style={{ ...domDepthText, color: ink, left: 4, right: 'auto' }}>{row.sizeText}</span>
      </span> : null}
    </span>
    <span style={{ ...domCellRight, color: 'rgba(220,90,110,.55)' }}>{row.hasSell ? row.sellText : ''}</span>
    <span style={{ ...domCellRight, color: row.deltaPos ? '#58d797' : '#e28b91' }}>{row.hasDelta ? row.deltaText : ''}</span>
  </div>;
}

/** Current-price row — ELEV fill, BRAND chip, session totals, hairlines. */
const DomCurrentRow = React.forwardRef<HTMLDivElement, { model: LadderCurrentModel }>(function DomCurrentRow({ model }, ref) {
  return <div ref={ref} style={domCurrentRowStyle}>
    <span style={{ ...domCellRight, color: '#58d797' }}>{model.hasBuy ? model.buyText : ''}</span>
    <span />
    <span style={{ display: 'flex', justifyContent: 'center' }}><b style={domPriceChipStyle}>{model.priceText}</b></span>
    <span />
    <span style={{ ...domCellRight, color: '#e28b91' }}>{model.hasSell ? model.sellText : ''}</span>
    <span style={{ ...domCellRight, color: model.deltaPos ? '#58d797' : '#e28b91' }}>{model.deltaText}</span>
  </div>;
});

/* ---------------------------------- Orderbook ---------------------------------- */

/** Read-only depth view of the SAME validated L2 book the DOM drives — the
 * depth bars the mockup shows, with no second stream and no execution keys. */
export function OrderbookPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const { flow, depth, lastEventAt } = useResolvedDepth(widget, symbol);
  const stale = useStaleness(lastEventAt, DOM_STALE_AFTER_MS);
  if (flow.flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left="Orderbook" right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.flow.reason}</span></EmptyNote></div>;
  }
  const { mid, spread, imbalance } = bookStats(depth, 6);
  const topBids = depth.bids.slice(0, 6);
  const topAsks = depth.asks.slice(0, 6);
  const bidMax = Math.max(0, ...topBids.map(([, qty]) => Number(qty) || 0));
  const askMax = Math.max(0, ...topAsks.map(([, qty]) => Number(qty) || 0));
  return <div style={bodyStyle}>
    <StatusStrip left={`Orderbook · ${flow.flow.source.stream}`} right={depth.ready ? (stale ? 'Stale' : 'Live') : 'Syncing'} tone={depth.ready && !stale ? 'live' : 'wait'} />
    <SwapBanner flow={flow} />
    {depth.ready ? <>
      <div style={obGridStyle}>
        <div><strong style={domSideBid}>BIDS</strong>{topBids.map(([price, qty]) => <ObRow key={`b${price}`} price={price} qty={qty} max={bidMax} color="#318f69" />)}</div>
        <div><strong style={domSideAsk}>ASKS</strong>{topAsks.map(([price, qty]) => <ObRow key={`a${price}`} price={price} qty={qty} max={askMax} color="#b55e63" flip />)}</div>
      </div>
      <div style={domQuoteRowStyle}>
        <span>Spread <b style={{ color: '#d8e3e8' }}>{spread != null ? spread.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}</b></span>
        <span>Mid <b style={{ color: '#d8e3e8' }}>{mid != null ? mid.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}</b></span>
        <span>Imbalance <b style={{ color: imbalance != null && imbalance >= 0 ? '#58d797' : '#e28b91' }}>{imbalance != null ? `${imbalance >= 0 ? '+' : ''}${imbalance.toFixed(1)}%` : '—'}</b></span>
      </div>
    </> : <EmptyNote>{depth.reset || 'Waiting for a validated snapshot and sequence bridge.'}</EmptyNote>}
    <div style={statsFootStyle}>SECONDARY VIEW — same validated L2 book as the DOM · {flow.flow.source.label}</div>
  </div>;
}

function ObRow({ price, qty, max, color, flip }: { price: string; qty: string; max: number; color: string; flip?: boolean }): JSX.Element {
  const pct = max > 0 ? Math.min(100, ((Number(qty) || 0) / max) * 100) : 0;
  return <div style={{ ...obRowStyle, background: `linear-gradient(${flip ? '270deg' : '90deg'}, ${color}2e ${pct}%, transparent ${pct}%)` }}>
    <span style={{ color: '#b8c5cc' }}>{price}</span>
    <span style={{ color }}>{qty}</span>
  </div>;
}

/* ---------------------------------- Watchlist ---------------------------------- */

interface ShellWatchlist { id: string; name: string; symbols: string[]; }

function readShellWatchlists(): ShellWatchlist[] {
  try {
    const bridge = (window as unknown as { __lseShell?: { getWatchlists?: () => ShellWatchlist[] } }).__lseShell;
    const lists = bridge?.getWatchlists?.();
    return Array.isArray(lists) ? lists.filter(list => list && typeof list.id === 'string' && Array.isArray(list.symbols)) : [];
  } catch { return []; }
}

export function WatchlistPanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const [lists, setLists] = useState<ShellWatchlist[]>([]);
  const [activeList, setActiveList] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    const refresh = () => setLists(readShellWatchlists());
    refresh();
    const tick = setInterval(refresh, 5000);
    return () => clearInterval(tick);
  }, []);
  const list = lists.find(item => item.id === activeList) || lists[0] || null;
  const query = filter.trim().toUpperCase();
  const symbols = list ? list.symbols.filter(item => !query || item.toUpperCase().includes(query)) : [];
  const effSymbol = widget.symbol || symbol;
  const pick = (sym: string) => {
    /* One product, one symbol: the row drives the REAL chart symbol through
     * the shell bridge; candles and every linked panel follow. */
    try { (window as unknown as { __lseShell?: { setSymbol?: (s: string) => void } }).__lseShell?.setSymbol?.(sym); } catch { /* bridge absent outside the shell */ }
  };
  return <div style={bodyStyle}>
    <StatusStrip left={list ? `Watchlist · ${list.name}` : 'Watchlist'} right={symbols.length ? `${symbols.length} symbols` : 'Empty'} tone={symbols.length ? 'live' : 'muted'} />
    {lists.length > 1 && <div style={wlTabsStyle}>{lists.map(item => <button key={item.id} type="button" onClick={() => setActiveList(item.id)} style={{ ...wlTabStyle, ...(list && list.id === item.id ? wlTabActiveStyle : {}) }}>{item.name}</button>)}</div>}
    <div style={wlFilterWrapStyle}>
      <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter symbols…" aria-label="Filter watchlist symbols" style={wlFilterStyle} />
    </div>
    {list
      ? (symbols.length
          ? symbols.map(item => <WatchlistRow key={item} symbol={item} active={item === effSymbol} onPick={pick} />)
          : <EmptyNote>No symbols match “{filter}”.</EmptyNote>)
      : <EmptyNote><strong>No shell watchlists yet.</strong><span>Add symbols in the sidebar watchlist — they appear here as workspace rows automatically.</span></EmptyNote>}
    <div style={statsFootStyle}>Row click switches the real chart symbol — candles and every linked panel follow. 24h stats read “—” until the venue publishes them.</div>
  </div>;
}

function WatchlistRow({ symbol: rowSymbol, active, onPick }: { symbol: string; active: boolean; onPick: (sym: string) => void }): JSX.Element {
  const { quote, connected } = useLiveQuote(rowSymbol, undefined, true);
  return <button type="button" onClick={() => onPick(rowSymbol)} style={{ ...wlRowStyle, borderColor: active ? '#1e9b6855' : 'transparent', background: active ? '#123d2d33' : 'transparent' }}>
    <span style={{ color: active ? '#7bf0b5' : '#d6e0e5', fontWeight: 600 }}>{rowSymbol}</span>
    <span style={{ color: '#8fa8b3' }}>{quote?.price != null ? quote.price.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—'}</span>
    <span style={{ color: '#5f6e77' }}>{connected ? '24h —' : 'offline'}</span>
  </button>;
}

/* ------------------------------- Replay Library ------------------------------- */

interface ReplayRecording { id: string; symbol: string; provider: string; startMs?: number; endMs?: number; sizeBytes?: number; }

export function ReplayLibraryPanel(_props: WidgetPanelProps): JSX.Element {
  const [recordings, setRecordings] = useState<ReplayRecording[] | null>(null);
  const load = useCallback(() => {
    let alive = true;
    fetch('/api/market-data/recordings')
      .then(response => (response.ok ? response.json() : { recordings: [] }))
      .then(data => { if (alive) setRecordings(Array.isArray(data?.recordings) ? data.recordings : []); })
      .catch(() => { if (alive) setRecordings([]); });
    return () => { alive = false; };
  }, []);
  useEffect(load, [load]);
  return <div style={bodyStyle}>
    <StatusStrip left="Replay Library" right={recordings == null ? 'Loading' : recordings.length ? `${recordings.length} sessions` : 'Empty'} tone={recordings && recordings.length ? 'live' : 'muted'} />
    <div style={paperBannerStyle}>REPLAY — RECORDED DATA, NEVER LIVE.</div>
    {recordings == null ? <EmptyNote>Loading the engine catalog…</EmptyNote>
      : recordings.length ? recordings.map(recording => <div key={recording.id} style={replayRowStyle}>
          <div>
            <div style={{ color: '#d6e0e5', fontSize: 11, fontWeight: 600 }}>{recording.symbol || 'Unknown symbol'} · {recording.provider || 'unknown venue'}</div>
            <div style={{ color: '#71808a', fontSize: 9, marginTop: 2 }}>{fmtReplayRange(recording.startMs, recording.endMs)} · {fmtReplayBytes(recording.sizeBytes)}</div>
          </div>
          <button type="button" disabled title="Playback transport ships with the replay engine phase — the catalog is live, playback is next" style={replayPlayStyle}>▶</button>
        </div>)
      : <EmptyNote><strong>No recorded sessions on this engine yet.</strong><span>When the session recorder ships, DOM + tape recordings appear here with play / step / speed / scrub controls.</span><small>Replay data can never masquerade as live.</small></EmptyNote>}
    <div style={{ margin: 'auto 10px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: '#5f6e77', fontSize: 9 }}>Catalog: /api/market-data/recordings</span>
      <button type="button" onClick={load} style={replayRefreshStyle}>Refresh</button>
    </div>
  </div>;
}

function fmtReplayBytes(n?: number): string {
  if (!Number.isFinite(n as number)) return '—';
  const value = n as number;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1e3))} KB`;
}
function fmtReplayRange(startMs?: number, endMs?: number): string {
  if (!startMs || !endMs) return '—';
  const a = new Date(startMs);
  const b = new Date(endMs);
  return `${a.toLocaleDateString()} ${a.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${b.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/* ---------------------------------- Footprint ---------------------------------- */

export function FootprintPanel({ widget, symbol, timeframe }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const tf = widget.timeframe || timeframe;
  const flow = useAdaptiveFlowSource(sym);
  const stream = flow.flow.status === 'resolved' ? flow.flow.source.stream : null;
  const printsRef = useRef<FootprintPrint[]>([]);
  const dirtyRef = useRef(false);
  const [view, setView] = useState<{ periods: FootprintPeriod[]; ignoredNoSide: number }>({ periods: [], ignoredNoSide: 0 });
  useEffect(() => {
    if (!stream || flow.flow.status !== 'resolved') { setView({ periods: [], ignoredNoSide: 0 }); return undefined; }
    printsRef.current = [];
    dirtyRef.current = false;
    setView({ periods: [], ignoredNoSide: 0 });
    const provider = flow.flow.source.provider;
    const bus = getBus();
    const stop = bus.stream([stream], provider);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== stream || typeof trade.price !== 'number') return;
      noteFlowVenueEvent(provider, 'data');
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
  }, [stream, flow, tf]);
  if (flow.flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left={`Footprint · ${tf} periods`} right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.flow.reason}</span></EmptyNote></div>;
  }
  const hasAny = view.periods.some(period => period.cells.length);
  return <div style={bodyStyle}>
    <StatusStrip left={`Footprint · ${tf} periods`} right={hasAny ? 'Real prints' : 'Waiting'} tone={hasAny ? 'live' : 'wait'} />
    <SwapBanner flow={flow} />
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
  const flow = useAdaptiveFlowSource(sym);
  const stream = flow.flow.status === 'resolved' ? flow.flow.source.stream : null;
  const [mode, setMode] = useState<'cvd' | 'delta'>('cvd');
  const printsRef = useRef<CvdPrint[]>([]);
  const dirtyRef = useRef(false);
  const [series, setSeries] = useState<CvdSeries>({ periods: [], cumulative: [], buyTotal: 0, sellTotal: 0, ignoredNoSide: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!stream || flow.flow.status !== 'resolved') { setSeries({ periods: [], cumulative: [], buyTotal: 0, sellTotal: 0, ignoredNoSide: 0 }); return undefined; }
    printsRef.current = [];
    dirtyRef.current = false;
    setSeries({ periods: [], cumulative: [], buyTotal: 0, sellTotal: 0, ignoredNoSide: 0 });
    const provider = flow.flow.source.provider;
    const bus = getBus();
    const stop = bus.stream([stream], provider);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== stream) return;
      noteFlowVenueEvent(provider, 'data');
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
  }, [stream, flow, tf]);
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
  if (flow.flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left={`${mode === 'cvd' ? 'Cumulative delta' : 'Period delta'} · ${tf}`} right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.flow.reason}</span></EmptyNote></div>;
  }
  return <div style={bodyStyle}>
    <SwapBanner flow={flow} />
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
  const flow = useAdaptiveFlowSource(widget.symbol || symbol);
  const historyRef = useRef<DepthHeatmapHistory | null>(null);
  const [frames, setFrames] = useState<HeatmapFrame[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (flow.flow.status !== 'resolved') return undefined;
    const stream = flow.flow.source.stream;
    const provider = flow.flow.source.provider;
    const history = new DepthHeatmapHistory(240);
    historyRef.current = history;
    setFrames([]);
    const bus = getBus();
    const stop = bus.stream([stream], provider);
    const off = bus.subscribeDepth((event: BusDepth) => {
      if (event.symbol !== stream) return;
      if (event.type === 'DEPTH_RESET') {
        noteFlowVenueEvent(provider, 'reset', String(event.reason || 'depth reset'));
        setFrames([]);
        return;
      }
      noteFlowVenueEvent(provider, 'data');
      const frame = history.apply(event);
      if (frame) setFrames(history.snapshot());
    });
    return () => { off(); stop(); historyRef.current = null; };
  }, [flow]);
  /* Redraw on new frames AND on panel resize (widget drag-resize included). */
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas || flow.flow.status !== 'resolved') return undefined;
    const draw = () => drawHeatmap(canvas, { width: wrap.clientWidth, height: wrap.clientHeight, frames, devicePixelRatio: window.devicePixelRatio || 1 });
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    draw();
    return () => observer.disconnect();
  }, [frames, flow]);
  if (flow.flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left="Resting liquidity history" right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.flow.reason}</span><small>Heatmap is never painted from candles or trade prints.</small></EmptyNote></div>;
  }
  return <div style={bodyStyle}>
    <StatusStrip left={`Liquidity · ${flow.flow.source.stream}`} right={frames.length ? `${frames.length} frames` : 'Waiting'} tone={frames.length ? 'live' : 'wait'} />
    <SwapBanner flow={flow} />
    <div ref={wrapRef} style={heatWrapStyle}>
      {frames.length ? <canvas ref={canvasRef} style={heatCanvasStyle} /> : <EmptyNote>Building liquidity history…<br /><small>Only validated L2 frames from {flow.flow.source.product} — never candle volume or trade prints.</small></EmptyNote>}
    </div>
    <div style={statsFootStyle}>Intensity = resting size vs visible max · green bids / red asks · dashed line = best mid</div>
  </div>;
}

/* -------------------------------- Volume Profile -------------------------------- */

export function VolumeProfilePanel({ widget, symbol }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const flow = useAdaptiveFlowSource(sym);
  const stream = flow.flow.status === 'resolved' ? flow.flow.source.stream : null;
  const [mode, setMode] = useState<'volume' | 'delta'>('volume');
  const printsRef = useRef<ProfilePrint[]>([]);
  const dirtyRef = useRef(false);
  const [profile, setProfile] = useState<VolumeProfileResult | null>(null);
  useEffect(() => {
    if (!stream || flow.flow.status !== 'resolved') { setProfile(null); return undefined; }
    printsRef.current = [];
    dirtyRef.current = false;
    setProfile(null);
    const provider = flow.flow.source.provider;
    const bus = getBus();
    const stop = bus.stream([stream], provider);
    const off = bus.subscribeTrade((trade) => {
      if (trade.symbol !== stream || typeof trade.price !== 'number') return;
      noteFlowVenueEvent(provider, 'data');
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
  }, [stream, flow]);
  if (flow.flow.status === 'none') {
    return <div style={bodyStyle}><StatusStrip left={`Session profile · ${sym || '—'}`} right="No source" tone="muted" /><EmptyNote><strong>No order-flow source</strong><span>{flow.flow.reason}</span></EmptyNote></div>;
  }
  return <div style={bodyStyle}>
    <StatusStrip left={`Session profile · ${sym || '—'}`} right={profile ? `POC ${profile.poc != null ? profile.poc.toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}` : 'Waiting'} tone={profile ? 'live' : 'wait'} />
    <SwapBanner flow={flow} />
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
  orderbook: OrderbookPanel,
  watchlist: WatchlistPanel,
  replay: ReplayLibraryPanel,
};

function barStyle(quantity: string, color: string): React.CSSProperties {
  return { color, fontStyle: 'normal', textAlign: 'right', minWidth: 50, background: `linear-gradient(90deg, transparent 0%, ${color}33 ${Math.min(100, Number(quantity) || 0)}%)` };
}

const bodyStyle: React.CSSProperties = { height: '100%', minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' };
const statusStripStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#d6e0e5', fontSize: 11, padding: '7px 10px', borderBottom: '1px solid #293740', position: 'sticky', top: 0, background: '#10171d', zIndex: 1 };
const swapBannerStyle: React.CSSProperties = { background: '#2b2416', color: '#e1b65c', fontSize: 10, lineHeight: 1.4, padding: '5px 10px', borderBottom: '1px solid #3d3424' };
const emptyStyle: React.CSSProperties = { color: '#87949c', fontSize: 11, lineHeight: 1.5, padding: 18, textAlign: 'center', display: 'grid', placeContent: 'center', gap: 4, height: '100%' };
const tradeRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, padding: '5px 10px', borderBottom: '1px solid #1e292f', color: '#b8c5cc', fontSize: 11 };
const statsGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 };
const statsFootStyle: React.CSSProperties = { borderTop: '1px solid #293740', color: '#71808a', fontSize: 10, padding: '8px 12px' };
const statLabelStyle: React.CSSProperties = { color: '#71808a', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em' };
const statValueStyle: React.CSSProperties = { display: 'block', color: '#d8e3e8', fontSize: 13, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' };
/* DOM ladder chrome, ported from ui/dom_widget.cpp's theme usage:
 * ELEV #0e1511, TX2 #b9c0b4, TX3 #7d8a80, BRAND #b08d57 + ink #11150f,
 * hairlines = BD2 #2c3b32. 18px rows = row_h_dense. */
const domGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 10 };
const domLadderStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', outline: 'none', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10, lineHeight: '18px' };
const domRowGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(30px, .7fr) 1fr minmax(64px, auto) 1fr minmax(30px, .7fr) minmax(34px, .7fr)', alignItems: 'center', minHeight: 18, padding: '0 6px' };
const domHeadRowStyle: React.CSSProperties = { ...domRowGrid, position: 'sticky', top: 0, background: '#0e1511', zIndex: 1, height: 22, lineHeight: '22px', borderBottom: '1px solid #1c2a22' };
const domHeadCell: React.CSSProperties = { color: '#7d8a80', fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase' };
const domCellRight: React.CSSProperties = { textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const domDepthCell: React.CSSProperties = { position: 'relative', height: 18, margin: '0 4px' };
const domDepthBar: React.CSSProperties = { position: 'absolute', top: 1, bottom: 1, borderRadius: 1, minWidth: 2, display: 'flex', alignItems: 'center' };
const domDepthText: React.CSSProperties = { position: 'absolute', right: 4, fontWeight: 600, textShadow: '0 1px 0 rgba(0,0,0,.45)' };
const domPriceCell: React.CSSProperties = { color: '#b9c0b4', textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' };
const domCurrentRowStyle: React.CSSProperties = { ...domRowGrid, background: '#0e1511', borderTop: '1px solid #2c3b32', borderBottom: '1px solid #2c3b32', minHeight: 20 };
const domPriceChipStyle: React.CSSProperties = { background: '#b08d57', color: '#11150f', borderRadius: 2, padding: '0 7px', lineHeight: '16px', fontWeight: 700 };
const domSettingsBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 40, background: 'transparent', border: 'none', cursor: 'default', padding: 0 };
const domSettingsPop: React.CSSProperties = { position: 'absolute', top: '100%', left: 10, zIndex: 41, minWidth: 210, background: '#10171d', border: '1px solid #2c3b32', borderRadius: 4, padding: '10px 12px', display: 'grid', gap: 6, boxShadow: '0 12px 32px rgba(0,0,0,.55)' };
const domSettingsSection: React.CSSProperties = { color: '#7d8a80', fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase', marginTop: 4 };
const domFootNoteStyle: React.CSSProperties = { position: 'sticky', bottom: 0, color: '#7d8a80', fontSize: 8, letterSpacing: '.05em', padding: '4px 8px', background: '#0e1511', borderTop: '1px solid #1c2a22', textAlign: 'center' };
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
const statsCellGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '1px', background: '#1e292f', borderTop: '1px solid #1e292f', borderBottom: '1px solid #1e292f' };
const statsCellStyle: React.CSSProperties = { background: '#10171d', padding: '8px 10px' };
const notProvidedStyle: React.CSSProperties = { display: 'block', color: '#7d6a2f', fontSize: 7.5, fontWeight: 700, letterSpacing: '.1em', marginTop: 2 };
const obGridStyle: React.CSSProperties = { flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 10, overflow: 'auto', alignContent: 'start' };
const obRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 6, padding: '3px 6px', borderRadius: 3, fontSize: 10.5, fontVariantNumeric: 'tabular-nums', marginTop: 2 };
const wlTabsStyle: React.CSSProperties = { display: 'flex', gap: 4, padding: '6px 8px 0', flexWrap: 'wrap' };
const wlTabStyle: React.CSSProperties = { background: '#111a21', border: '1px solid #223038', borderRadius: 5, color: '#93a7b3', fontSize: 9.5, padding: '3px 9px', cursor: 'pointer', fontFamily: 'inherit' };
const wlTabActiveStyle: React.CSSProperties = { borderColor: '#2a8f6a88', color: '#7bf0b5', background: '#12372b' };
const wlFilterWrapStyle: React.CSSProperties = { padding: '6px 8px' };
const wlFilterStyle: React.CSSProperties = { width: '100%', background: '#0b1218', border: '1px solid #223038', borderRadius: 6, color: '#cfe2cf', fontFamily: 'inherit', fontSize: 10.5, padding: '5px 8px', outline: 'none', boxSizing: 'border-box' };
const wlRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr) auto', gap: 8, alignItems: 'center', width: 'calc(100% - 16px)', margin: '2px 8px', padding: '6px 8px', border: '1px solid transparent', borderRadius: 7, background: 'transparent', cursor: 'pointer', fontSize: 10.5, fontFamily: 'inherit', textAlign: 'left', fontVariantNumeric: 'tabular-nums' };
const replayRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 10px', padding: '7px 9px', background: '#0d141b', border: '1px solid #1b2530', borderRadius: 8 };
const replayPlayStyle: React.CSSProperties = { width: 26, height: 26, borderRadius: '50%', border: '1px solid #2b3a44', background: '#141e26', color: '#5f6e77', cursor: 'not-allowed', fontSize: 10 };
const replayRefreshStyle: React.CSSProperties = { background: '#111a21', border: '1px solid #223038', borderRadius: 5, color: '#93a7b3', fontSize: 9, padding: '3px 10px', cursor: 'pointer', fontFamily: 'inherit' };
const profileRowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1.5fr .5fr', gap: 7, color: '#c0cbd0', fontSize: 10, padding: '4px 10px', borderTop: '1px solid #1e292f' };
