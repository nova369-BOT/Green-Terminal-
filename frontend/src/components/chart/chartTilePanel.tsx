import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchLocalCandles, type CandleRow } from '@/lib/localEngine';
import { formatCompact, timeframeToMs } from '@/lib/footprintAggregator';
import { publishCrosshair, subscribeCrosshair } from '@/lib/chartCrosshairSync';
import { useLiveQuote } from '@/market-data/hooks';
import type { WidgetPanelProps } from './workspaceWidgetPanels';

/**
 * Chart tile — the SECOND and further chart panes of a multi-chart workspace.
 *
 * The primary chart pane keeps the full native engine (every tool, indicator
 * and drawing). A tile renders real engine candles for its own symbol and
 * timeframe, streams the forming bar from the live tick bus, and offers a
 * crosshair with an honest OHLCV legend. No synthetic bars: seeded bars start
 * with volume 0 (ticks carry no volume) and are replaced by engine truth on
 * the next fetch.
 */

const REFETCH_MS = 30000;
const TICK_FLUSH_MS = 500;
const MAX_BARS = 340;

const C_UP = '#58d797';
const C_DOWN = '#e28b91';
const C_GRID = '#1c283066';
const C_TEXT = '#71808a';
const C_CROSS = '#5f7480';
const C_GHOST = '#8bb7e8aa';

export function ChartTilePanel({ widget, symbol, timeframe }: WidgetPanelProps): JSX.Element {
  const sym = widget.symbol || symbol;
  const tf = widget.timeframe || timeframe;
  const [bars, setBars] = useState<CandleRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'empty'>('loading');
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [ghostMs, setGhostMs] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { quote, connected } = useLiveQuote(sym || null, undefined, true);
  const quoteRef = useRef(quote);
  quoteRef.current = quote;

  /* Crosshair sync: mirror other tiles' hovered bar times; publish ours. */
  useEffect(() => subscribeCrosshair(widget.id, setGhostMs), [widget.id]);
  useEffect(() => () => publishCrosshair(widget.id, null), [widget.id]);

  /* Fetch engine candles for this tile. Identity guard: only setState when
   * the payload actually changed, so the 30s refresh does not churn renders. */
  useEffect(() => {
    let alive = true;
    const load = (first: boolean) => {
      if (first) setStatus('loading');
      fetchLocalCandles('chart-tile', { symbol: sym, timeframe: tf, limit: MAX_BARS })
        .then(rows => {
          if (!alive) return;
          setBars(previous => {
            if (rows.length === previous.length
              && rows.length > 0
              && rows[rows.length - 1].timestamp === previous[previous.length - 1].timestamp
              && rows[rows.length - 1].close === previous[previous.length - 1].close
              && rows[0].timestamp === previous[0].timestamp) return previous;
            return rows;
          });
          setStatus(rows.length ? 'ok' : 'empty');
        })
        .catch(() => { if (alive) setStatus(previous => (previous === 'ok' ? previous : 'error')); });
    };
    load(true);
    const tick = setInterval(() => load(false), REFETCH_MS);
    return () => { alive = false; clearInterval(tick); };
  }, [sym, tf]);

  /* Fold live ticks into the forming bar (throttled flush between refetches). */
  useEffect(() => {
    const tfMs = timeframeToMs(tf);
    const flush = setInterval(() => {
      const latest = quoteRef.current;
      if (!latest || !Number.isFinite(latest.price)) return;
      const tickMs = Number.isFinite(latest.tsMs) && latest.tsMs > 0 ? latest.tsMs : Date.now();
      const winStart = Math.floor(tickMs / tfMs) * tfMs;
      setBars(previous => {
        if (!previous.length) return previous;
        const last = previous[previous.length - 1];
        const lastMs = Date.parse(last.timestamp);
        if (winStart === lastMs) {
          const close = latest.price;
          const high = Math.max(last.high, close);
          const low = Math.min(last.low, close);
          if (close === last.close && high === last.high && low === last.low) return previous;
          return [...previous.slice(0, -1), { ...last, close, high, low }];
        }
        if (winStart > lastMs) {
          // New aligned window the engine has not served yet: seed honestly.
          const seed: CandleRow = { timestamp: new Date(winStart).toISOString(), open: latest.price, high: latest.price, low: latest.price, close: latest.price, volume: 0 };
          const grown = [...previous, seed];
          return grown.length > MAX_BARS ? grown.slice(grown.length - MAX_BARS) : grown;
        }
        return previous; // stale tick behind the current window — ignore
      });
    }, TICK_FLUSH_MS);
    return () => clearInterval(flush);
  }, [tf]);

  /* Track the panel box so the canvas follows grid drag/resize. */
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return undefined;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setSize(previous => (previous.w === Math.floor(rect.width) && previous.h === Math.floor(rect.height))
        ? previous
        : { w: Math.floor(rect.width), h: Math.floor(rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /* Ghost bar index for another tile's published crosshair time: bars are
   * ascending ISO window-starts, so a binary search on the string keys is
   * exact — the line lands only on a bar that really exists. */
  const ghostIndex = useMemo(() => {
    if (ghostMs == null || !bars.length) return null;
    const iso = new Date(Math.floor(ghostMs / timeframeToMs(tf)) * timeframeToMs(tf)).toISOString();
    let low = 0;
    let high = bars.length - 1;
    while (low <= high) {
      const midPoint = (low + high) >> 1;
      if (bars[midPoint].timestamp === iso) return midPoint;
      if (bars[midPoint].timestamp < iso) low = midPoint + 1;
      else high = midPoint - 1;
    }
    return null; // the ghost time is outside this tile's loaded range — no line
  }, [ghostMs, bars, tf]);

  /* Full redraw whenever bars, size or crosshair change. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w <= 0 || size.h <= 0) return;
    draw(canvas, size.w, size.h, bars, hover, ghostIndex);
  }, [bars, size, hover, ghostIndex]);

  const legend = useMemo(() => (hover ? pickBar(bars, hover.x, size.w) : pickBar(bars, Number.NaN, size.w) ?? (bars.length ? { bar: bars[bars.length - 1], index: bars.length - 1 } : null)), [bars, hover, size.w]);

  return <div style={tileBodyStyle}>
    <div style={tileStripStyle}>
      <b>Chart · {sym || '—'} · {tf}</b>
      <span style={{ color: connected ? C_UP : C_TEXT }}>{connected ? 'Live' : status === 'error' ? 'Engine error' : status === 'empty' ? 'No candles' : 'Offline'}</span>
    </div>
    {status === 'error'
      ? <div style={tileEmptyStyle}><strong>Engine candles unavailable.</strong><span>The tile retries every {REFETCH_MS / 1000}s — no synthetic bars are drawn.</span></div>
      : status !== 'ok'
        ? <div style={tileEmptyStyle}><strong>{status === 'loading' ? 'Loading candles…' : 'No candles for this symbol/timeframe.'}</strong></div>
        : <div ref={wrapRef} style={tileCanvasWrapStyle}>
            <canvas
              ref={canvasRef}
              style={{ display: 'block', width: size.w, height: size.h }}
              onMouseMove={event => {
                const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
                const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
                setHover(point);
                const picked = pickBar(bars, point.x, size.w);
                publishCrosshair(widget.id, picked ? Date.parse(picked.bar.timestamp) : null);
              }}
              onMouseLeave={() => { setHover(null); publishCrosshair(widget.id, null); }}
            />
            {legend && <div style={tileLegendStyle}>
              <span style={{ color: '#d8e3e8' }}>{fmtTime(legend.bar.timestamp)}</span>
              {' '}O <b style={{ color: C_TEXT }}>{fmtPx(legend.bar.open)}</b>
              {' '}H <b style={{ color: C_UP }}>{fmtPx(legend.bar.high)}</b>
              {' '}L <b style={{ color: C_DOWN }}>{fmtPx(legend.bar.low)}</b>
              {' '}C <b style={{ color: legend.bar.close >= legend.bar.open ? C_UP : C_DOWN }}>{fmtPx(legend.bar.close)}</b>
              {' '}V <b style={{ color: C_TEXT }}>{legend.bar.volume ? formatCompact(legend.bar.volume) : '—'}</b>
            </div>}
          </div>}
    <div style={tileFootStyle}>ENGINE CANDLES + LIVE TICK BUS — no derived volume on seeded bars</div>
  </div>;
}

/* ------------------------------------------------------------------ */

interface PickedBar { bar: CandleRow; index: number; }

function layout(bars: CandleRow[], width: number, height: number) {
  const padL = 4;
  const padR = 54;
  const padT = 8;
  const padB = 16;
  const innerW = Math.max(0, width - padL - padR);
  const innerH = Math.max(0, height - padT - padB);
  const step = bars.length ? innerW / bars.length : 1;
  return { padL, padR, padT, padB, innerW, innerH, step };
}

function pickBar(bars: CandleRow[], x: number, width: number): PickedBar | null {
  if (!bars.length || !Number.isFinite(x)) return null;
  const { padL, innerW, step } = layout(bars, width, 100);
  if (x < padL || x > padL + innerW || step <= 0) return null;
  const index = Math.min(bars.length - 1, Math.max(0, Math.floor((x - padL) / step)));
  return { bar: bars[index], index };
}

function draw(canvas: HTMLCanvasElement, width: number, height: number, bars: CandleRow[], hover: { x: number; y: number } | null, ghostIndex: number | null): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  if (!bars.length) return;

  const { padL, padT, innerW, innerH, step } = layout(bars, width, height);
  const volH = innerH * 0.12;
  const priceH = innerH - volH - 4;
  let hi = -Infinity;
  let lo = Infinity;
  let maxVol = 0;
  for (const bar of bars) { hi = Math.max(hi, bar.high); lo = Math.min(lo, bar.low); maxVol = Math.max(maxVol, bar.volume || 0); }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) { hi = lo + 1; }
  const yOf = (price: number) => padT + (1 - (price - lo) / (hi - lo)) * priceH;

  // Grid + price labels (4 interior lines).
  ctx.strokeStyle = C_GRID;
  ctx.fillStyle = C_TEXT;
  ctx.font = '9px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padT + (priceH * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(padL + innerW, y + 0.5); ctx.stroke();
    ctx.fillText(fmtPx(hi - ((hi - lo) * i) / 4), padL + innerW + 4, y - 4);
  }
  // Sparse time labels.
  for (let i = 0; i < 4; i += 1) {
    const index = Math.min(bars.length - 1, Math.floor(((bars.length - 1) * i) / 3));
    const x = padL + (index + 0.5) * step;
    ctx.textAlign = i === 3 ? 'right' : i === 0 ? 'left' : 'center';
    ctx.fillText(fmtTime(bars[index].timestamp), Math.min(padL + innerW, Math.max(padL, x)), padT + innerH + 3);
  }

  // Volume bars (behind candles).
  const bodyW = Math.max(1, Math.floor(step * 0.7));
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const volumeHeight = maxVol > 0 ? (bar.volume / maxVol) * volH : 0;
    if (volumeHeight <= 0) continue;
    ctx.fillStyle = bar.close >= bar.open ? '#58d79726' : '#e28b9126';
    const x = padL + i * step + (step - bodyW) / 2;
    ctx.fillRect(x, padT + innerH - volumeHeight, bodyW, volumeHeight);
  }

  // Candles.
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const up = bar.close >= bar.open;
    const color = up ? C_UP : C_DOWN;
    const cx = padL + i * step + step / 2;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, yOf(bar.high));
    ctx.lineTo(Math.round(cx) + 0.5, yOf(bar.low));
    ctx.stroke();
    const top = Math.min(yOf(bar.open), yOf(bar.close));
    const heightBody = Math.max(1, Math.abs(yOf(bar.open) - yOf(bar.close)));
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(cx - bodyW / 2), top, bodyW, heightBody);
  }

  // Last close dashed line + price chip.
  const last = bars[bars.length - 1];
  const yc = yOf(last.close);
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = last.close >= last.open ? C_UP : C_DOWN;
  ctx.beginPath(); ctx.moveTo(padL, Math.round(yc) + 0.5); ctx.lineTo(padL + innerW, Math.round(yc) + 0.5); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = last.close >= last.open ? C_UP : C_DOWN;
  ctx.fillRect(padL + innerW + 1, yc - 6, 48, 12);
  ctx.fillStyle = '#0b1014';
  ctx.fillText(fmtPx(last.close), padL + innerW + 4, yc - 4);

  // Ghost cursor mirrored from another chart tile's crosshair (bar-exact).
  if (ghostIndex != null && ghostIndex >= 0 && ghostIndex < bars.length) {
    const gx = padL + (ghostIndex + 0.5) * step;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = C_GHOST;
    ctx.beginPath(); ctx.moveTo(Math.round(gx) + 0.5, padT); ctx.lineTo(Math.round(gx) + 0.5, padT + innerH); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Crosshair.
  if (hover && hover.x >= padL && hover.x <= padL + innerW) {
    const picked = pickBar(bars, hover.x, width);
    const cx = picked ? padL + (picked.index + 0.5) * step : hover.x;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = C_CROSS;
    ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, padT); ctx.lineTo(Math.round(cx) + 0.5, padT + innerH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, Math.round(hover.y) + 0.5); ctx.lineTo(padL + innerW, Math.round(hover.y) + 0.5); ctx.stroke();
    ctx.setLineDash([]);
    if (hover.y >= padT && hover.y <= padT + priceH) {
      const price = lo + (1 - (hover.y - padT) / priceH) * (hi - lo);
      ctx.fillStyle = '#223038';
      ctx.fillRect(padL + innerW + 1, hover.y - 6, 48, 12);
      ctx.fillStyle = '#c8d4da';
      ctx.fillText(fmtPx(price), padL + innerW + 4, hover.y - 4);
    }
  }
}

function fmtPx(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  return value.toLocaleString(undefined, { maximumFractionDigits: abs >= 1000 ? 2 : abs >= 1 ? 4 : 6 });
}

function fmtTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
}

const tileBodyStyle: React.CSSProperties = { height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#0b1014' };
const tileStripStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#d6e0e5', fontSize: 11, padding: '7px 10px', borderBottom: '1px solid #293740', background: '#10171d' };
const tileCanvasWrapStyle: React.CSSProperties = { flex: 1, minHeight: 0, position: 'relative' };
const tileLegendStyle: React.CSSProperties = { position: 'absolute', top: 4, left: 6, fontSize: 9.5, fontFamily: 'ui-monospace, Menlo, monospace', color: '#9fb0ba', background: '#0d1319cc', padding: '2px 6px', borderRadius: 4, pointerEvents: 'none', whiteSpace: 'nowrap' };
const tileEmptyStyle: React.CSSProperties = { flex: 1, color: '#87949c', fontSize: 11, lineHeight: 1.5, padding: 18, textAlign: 'center', display: 'grid', placeContent: 'center', gap: 4 };
const tileFootStyle: React.CSSProperties = { borderTop: '1px solid #293740', color: '#56656f', fontSize: 8.5, padding: '4px 10px' };
