// Chart drawing tools that are not the usual desk set.
// Every number comes from the bars passed in. Nothing here invents a price.

export type DeskBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type DeskPoint = { time: number; price: number };

export type DeskDrawing = {
  type: 'trend' | 'rectangle';
  points: DeskPoint[];
  text?: string;
  color: string;
  textColor: string;
  textFontSize: number;
  strokeWidth: number;
  lineStyle?: 'solid' | 'dashed';
  fillColor?: string;
  fillOpacity?: number;
};

const INK = 'var(--accent-bar, #b08d57)';
const TEXT = 'var(--text, #f4f1e8)';

function ms(t: number): number {
  return t > 1e12 ? t : t * 1000;
}

function barsOf(rows: DeskBar[]): DeskBar[] {
  return (rows || [])
    .filter((b) => b && isFinite(+b.open) && isFinite(+b.high) && isFinite(+b.low) && isFinite(+b.close))
    .map((b) => ({
      time: ms(+b.time),
      open: +b.open,
      high: +b.high,
      low: +b.low,
      close: +b.close,
    }))
    .filter((b) => b.high >= b.low);
}

function nearest(bars: DeskBar[], time: number): number {
  let best = 0;
  let dist = Infinity;
  const t = ms(time);
  for (let i = 0; i < bars.length; i++) {
    const d = Math.abs(bars[i].time - t);
    if (d < dist) { dist = d; best = i; }
  }
  return best;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function medianRange(bars: DeskBar[]): number | null {
  return median(bars.map((b) => b.high - b.low).filter((r) => r > 0));
}

function priceText(n: number): string {
  const a = Math.abs(n);
  const d = a >= 100 ? 2 : a >= 1 ? 4 : 6;
  return n.toFixed(d);
}

function signed(n: number, ref: number): string {
  const body = priceText(Math.abs(n) < 1e-12 ? 0 : n);
  if (n > 0 && !body.startsWith('-')) return '+' + (Math.abs(ref) >= 100 ? n.toFixed(2) : body);
  return Math.abs(ref) >= 100 ? n.toFixed(2) : body;
}

function base(partial: Partial<DeskDrawing> & Pick<DeskDrawing, 'type' | 'points'>): DeskDrawing {
  return {
    color: INK,
    textColor: TEXT,
    textFontSize: 11,
    strokeWidth: 1.25,
    ...partial,
  };
}

function thin(point: DeskPoint, text: string): DeskDrawing {
  return base({
    type: 'trend',
    points: [point, { time: point.time, price: point.price }],
    text,
  });
}

function isSwingHigh(bars: DeskBar[], i: number): boolean {
  if (i < 2 || i > bars.length - 3) return false;
  const h = bars[i].high;
  return h >= bars[i - 1].high && h >= bars[i - 2].high && h >= bars[i + 1].high && h >= bars[i + 2].high;
}

function isSwingLow(bars: DeskBar[], i: number): boolean {
  if (i < 2 || i > bars.length - 3) return false;
  const l = bars[i].low;
  return l <= bars[i - 1].low && l <= bars[i - 2].low && l <= bars[i + 1].low && l <= bars[i + 2].low;
}

export function placeSwing(barsIn: DeskBar[], click: DeskPoint): DeskDrawing {
  const bars = barsOf(barsIn);
  const t = ms(click.time);
  if (bars.length < 5) return thin({ time: t, price: click.price }, 'not enough bars');
  const i = nearest(bars, t);
  const a = Math.max(2, i - 10);
  const b = Math.min(bars.length - 3, i + 10);
  let best: { time: number; price: number; dist: number } | null = null;
  for (let k = a; k <= b; k++) {
    const cands: number[] = [];
    if (isSwingHigh(bars, k)) cands.push(bars[k].high);
    if (isSwingLow(bars, k)) cands.push(bars[k].low);
    for (const price of cands) {
      const dist = Math.abs(price - click.price);
      if (!best || dist < best.dist) best = { time: bars[k].time, price, dist };
    }
  }
  if (!best) {
    const bar = bars[i];
    const price = Math.abs(click.price - bar.high) <= Math.abs(click.price - bar.low) ? bar.high : bar.low;
    best = { time: bar.time, price, dist: 0 };
  }
  const end = bars[bars.length - 1].time;
  const from = bars[Math.max(0, nearest(bars, best.time) - 8)].time;
  return base({
    type: 'trend',
    points: [
      { time: from, price: best.price },
      { time: Math.max(end, from + 1), price: best.price },
    ],
    text: priceText(best.price),
  });
}

export function placeSpan(barsIn: DeskBar[], a: DeskPoint, b: DeskPoint): DeskDrawing {
  const bars = barsOf(barsIn);
  const t1 = ms(a.time);
  const t2 = ms(b.time);
  const lo = Math.min(t1, t2);
  const hi = Math.max(t1, t2);
  const inside = bars.filter((bar) => bar.time >= lo && bar.time <= hi);
  const count = Math.max(1, inside.length);
  const delta = b.price - a.price;
  const scale = medianRange(bars);
  let text = count + (count === 1 ? ' bar' : ' bars') + ' · ' + signed(delta, a.price);
  if (scale && scale > 0) {
    text += ' · ' + (Math.abs(delta) / scale).toFixed(1) + ' ranges';
  }
  return base({
    type: 'trend',
    points: [{ time: t1, price: a.price }, { time: t2, price: b.price }],
    text,
  });
}

export function placeBand(barsIn: DeskBar[], click: DeskPoint): DeskDrawing {
  const bars = barsOf(barsIn);
  const t = ms(click.time);
  const scale = medianRange(bars);
  if (!scale || bars.length < 8) return thin({ time: t, price: click.price }, 'not enough bars');
  const last = bars[bars.length - 1].time;
  let start = t;
  if (last - start < 1) start = bars[Math.max(0, bars.length - 21)].time;
  return base({
    type: 'rectangle',
    points: [
      { time: Math.min(start, last), price: click.price - scale },
      { time: Math.max(start, last), price: click.price + scale },
    ],
    text: '1 range',
    fillColor: INK,
    fillOpacity: 28,
  });
}

function woundSide(bar: DeskBar): -1 | 0 | 1 {
  const range = bar.high - bar.low;
  if (!(range > 0)) return 0;
  const loc = (bar.close - bar.low) / range;
  if (loc <= 0.25) return -1;
  if (loc >= 0.75) return 1;
  return 0;
}

export function placeWound(barsIn: DeskBar[], click: DeskPoint): DeskDrawing {
  const bars = barsOf(barsIn);
  const t = ms(click.time);
  if (bars.length < 8) return thin({ time: t, price: click.price }, 'not enough bars');
  const origin = nearest(bars, t);
  let idx = -1;
  for (let d = 0; d <= 12 && idx < 0; d++) {
    if (origin - d >= 0 && woundSide(bars[origin - d])) idx = origin - d;
    else if (d && origin + d < bars.length && woundSide(bars[origin + d])) idx = origin + d;
  }
  if (idx < 0) return thin({ time: t, price: click.price }, 'no wound nearby');
  const bar = bars[idx];
  const side = woundSide(bar);
  let hit: number | null = null;
  const last = Math.min(bars.length - 1, idx + 40);
  for (let j = idx + 1; j <= last; j++) {
    if (side < 0 ? bars[j].high >= bar.open : bars[j].low <= bar.open) { hit = j; break; }
  }
  const end = hit != null ? bars[hit].time : bars[Math.min(bars.length - 1, idx + 40)].time;
  const text = hit != null ? 'reclaimed in ' + (hit - idx) : 'still open';
  return base({
    type: 'trend',
    points: [
      { time: bar.time, price: bar.open },
      { time: end, price: bar.open },
    ],
    text,
    lineStyle: hit == null ? 'dashed' : 'solid',
  });
}

export function placeStreak(barsIn: DeskBar[], click: DeskPoint): DeskDrawing {
  const bars = barsOf(barsIn);
  const t = ms(click.time);
  if (bars.length < 3) return thin({ time: t, price: click.price }, 'not enough bars');
  const i = nearest(bars, t);
  if (i < 1) return thin({ time: bars[i].time, price: bars[i].close }, 'no run');
  const sign = bars[i].close > bars[i - 1].close ? 1 : bars[i].close < bars[i - 1].close ? -1 : 0;
  if (!sign) return thin({ time: bars[i].time, price: bars[i].close }, 'no run');
  let a = i;
  while (a > 0) {
    const s = bars[a].close > bars[a - 1].close ? 1 : bars[a].close < bars[a - 1].close ? -1 : 0;
    if (s !== sign) break;
    a--;
  }
  let b = i;
  while (b < bars.length - 1) {
    const s = bars[b + 1].close > bars[b].close ? 1 : bars[b + 1].close < bars[b].close ? -1 : 0;
    if (s !== sign) break;
    b++;
  }
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = a; k <= b; k++) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
  }
  const len = b - a + 1;
  return base({
    type: 'rectangle',
    points: [
      { time: bars[a].time, price: lo },
      { time: bars[b].time, price: hi },
    ],
    text: len + ' bars ' + (sign > 0 ? 'up' : 'down'),
    fillColor: INK,
    fillOpacity: 22,
  });
}
