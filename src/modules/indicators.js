/**
 * Indicators — pure functions over Float64Array, O(n), no allocations per bar.
 *
 * Conventions that matter for correctness:
 *  - every series is aligned to the input index (warmup slots are NaN, never 0)
 *  - Wilder smoothing is used where the industry standard says Wilder (RSI/ATR/ADX)
 *  - VWAP is session-anchored (UTC day) because an unanchored VWAP drifts into
 *    irrelevance on multi-week windows
 * Signals are read at bar *close*; that convention is enforced in the engine, not here.
 */

export function sma(src, period) {
  const n = src.length;
  const out = new Float64Array(n).fill(NaN);
  if (!(period > 0) || n < period) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(src, period) {
  const n = src.length;
  const out = new Float64Array(n).fill(NaN);
  if (!(period > 0) || n < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += src[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. Returns 0..100. */
export function rsi(src, period = 14) {
  const n = src.length;
  const out = new Float64Array(n).fill(NaN);
  if (n <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = src[i] - src[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < n; i++) {
    const d = src[i] - src[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(src, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast);
  const s = ema(src, slow);
  const n = src.length;
  const line = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) line[i] = f[i] - s[i];
  // Seed the signal EMA on the contiguous valid block, then realign.
  const start = slow - 1;
  const block = line.slice(start);
  const sig = new Float64Array(n).fill(NaN);
  const hist = new Float64Array(n).fill(NaN);
  const e = ema(block, signal);
  for (let i = 0; i < e.length; i++) {
    if (Number.isNaN(e[i])) continue;
    sig[start + i] = e[i];
    hist[start + i] = line[start + i] - e[i];
  }
  return { line, signal: sig, hist };
}

/** Wilder's ATR — the volatility yardstick every stop in this terminal is measured in. */
export function atr(dataset, period = 14) {
  const { high, low, close } = dataset;
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (n <= period) return out;
  const tr = new Float64Array(n);
  tr[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) {
    const a = high[i] - low[i];
    const b = Math.abs(high[i] - close[i - 1]);
    const c = Math.abs(low[i] - close[i - 1]);
    tr[i] = Math.max(a, b, c);
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function bollinger(src, period = 20, mult = 2) {
  const n = src.length;
  const mid = sma(src, period);
  const upper = new Float64Array(n).fill(NaN);
  const lower = new Float64Array(n).fill(NaN);
  const width = new Float64Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = src[j] - mid[i];
      acc += d * d;
    }
    const sd = Math.sqrt(acc / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] === 0 ? 0 : (upper[i] - lower[i]) / mid[i];
  }
  return { mid, upper, lower, width };
}

/** Session-anchored VWAP (resets at each UTC midnight), plus 1/2/3σ bands. */
export function vwap(dataset) {
  const { t, high, low, close, volume } = dataset;
  const n = close.length;
  const line = new Float64Array(n).fill(NaN);
  const upper = new Float64Array(n).fill(NaN);
  const lower = new Float64Array(n).fill(NaN);
  let cumPV = 0;
  let cumV = 0;
  let cumSq = 0;
  let day = NaN;
  for (let i = 0; i < n; i++) {
    const d = Math.floor(t[i] / 86400000);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumV = 0;
      cumSq = 0;
    }
    const typical = (high[i] + low[i] + close[i]) / 3;
    const v = volume[i];
    cumPV += typical * v;
    cumV += v;
    cumSq += typical * typical * v;
    if (cumV > 0) {
      const mean = cumPV / cumV;
      const variance = Math.max(0, cumSq / cumV - mean * mean);
      const sd = Math.sqrt(variance);
      line[i] = mean;
      upper[i] = mean + 2 * sd;
      lower[i] = mean - 2 * sd;
    }
  }
  return { line, upper, lower };
}

/** Stochastic oscillator over %K/%D, plus the slow variant traders actually use. */
export function stoch(dataset, kPeriod = 14, dPeriod = 3, smooth = 3) {
  const { high, low, close } = dataset;
  const n = close.length;
  const raw = new Float64Array(n).fill(NaN);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j] < ll) ll = low[j];
    }
    raw[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
  }
  const k = sma(raw, smooth);
  const d = sma(k, dPeriod);
  return { k, d };
}

/** Normalized momentum: distance from the `lookback`-bar mean, in ATR units. */
export function roc(src, period) {
  const n = src.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    const prev = src[i - period];
    out[i] = prev === 0 ? 0 : (src[i] / prev - 1) * 100;
  }
  return out;
}

/** Rolling max/min of a series — used for Donchian channels and divergence scans. */
export function roll(src, period, mode = 'max') {
  const n = src.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let best = mode === 'max' ? -Infinity : Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const v = src[j];
      if (Number.isNaN(v)) continue;
      best = mode === 'max' ? Math.max(best, v) : Math.min(best, v);
    }
    out[i] = best;
  }
  return out;
}

/**
 * Rolling max/min over the `period` bars ENDING AT i-1 (current bar excluded).
 * This is the range a breakout is measured against.
 */
export function rollExcluding(src, period, mode = 'max') {
  const n = src.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let best = mode === 'max' ? -Infinity : Infinity;
    for (let j = i - period; j < i; j++) {
      const v = src[j];
      if (Number.isNaN(v)) continue;
      best = mode === 'max' ? Math.max(best, v) : Math.min(best, v);
    }
    out[i] = best;
  }
  return out;
}

/** True if a crossed `b` from below at index i (classic cross-up). */
export function crossUp(a, b, i) {
  if (i < 1) return false;
  const a0 = a[i - 1];
  const a1 = a[i];
  const b0 = b[i - 1];
  const b1 = b[i];
  if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(b0) || Number.isNaN(b1)) return false;
  return a0 <= b0 && a1 > b1;
}

export function crossDown(a, b, i) {
  if (i < 1) return false;
  const a0 = a[i - 1];
  const a1 = a[i];
  const b0 = b[i - 1];
  const b1 = b[i];
  if (Number.isNaN(a0) || Number.isNaN(a1) || Number.isNaN(b0) || Number.isNaN(b1)) return false;
  return a0 >= b0 && a1 < b1;
}

/** Count of bars the series has been continuously above `level` (0 if not). */
export function runLength(series, i, above = true) {
  let n = 0;
  for (let j = i; j >= 0; j--) {
    const v = series[j];
    if (Number.isNaN(v)) break;
    if (above ? v > 0 : v < 0) n++;
    else break;
  }
  return n;
}

export const INDICATOR_SPECS = {
  ema: { label: 'EMA', args: [20], minBars: 1, kind: 'overlay' },
  sma: { label: 'SMA', args: [50], minBars: 1, kind: 'overlay' },
  vwap: { label: 'VWAP', args: [], minBars: 1, kind: 'overlay' },
  bb: { label: 'Bollinger', args: [20, 2], minBars: 1, kind: 'overlay' },
  donchian: { label: 'Donchian', args: [20], minBars: 1, kind: 'overlay' },
  rsi: { label: 'RSI', args: [14], minBars: 2, kind: 'pane', zero: null },
  macd: { label: 'MACD', args: [12, 26, 9], minBars: 3, kind: 'pane' },
  atr: { label: 'ATR', args: [14], minBars: 1, kind: 'pane' },
  stoch: { label: 'Stoch', args: [14, 3, 3], minBars: 3, kind: 'pane' },
  roc: { label: 'ROC %', args: [20], minBars: 1, kind: 'pane' },
};

/**
 * Build every indicator a dataset needs in one pass. Returns a map of
 * Float64Array keyed by canonical id, e.g. `ema:20`, `rsi:14`, `bb:20:2:up`.
 * The engine and the UI both read from this map so they can never disagree.
 */
export function buildIndicatorSet(dataset, close, wanted) {
  const out = {};
  const ensure = (key, fn) => {
    if (out[key]) return;
    out[key] = fn();
  };
  for (const spec of wanted) {
    const { name, args } = spec;
    if (name === 'ema') {
      const p = args[0] ?? 20;
      ensure(`ema:${p}`, () => ema(close, p));
    } else if (name === 'sma') {
      const p = args[0] ?? 50;
      ensure(`sma:${p}`, () => sma(close, p));
    } else if (name === 'rsi') {
      const p = args[0] ?? 14;
      ensure(`rsi:${p}`, () => rsi(close, p));
    } else if (name === 'roc') {
      const p = args[0] ?? 20;
      ensure(`roc:${p}`, () => roc(close, p));
    } else if (name === 'atr') {
      const p = args[0] ?? 14;
      ensure(`atr:${p}`, () => atr(dataset, p));
    } else if (name === 'vwap') {
      const v = vwap(dataset);
      ensure('vwap', () => v.line);
      ensure('vwap:up', () => v.upper);
      ensure('vwap:lo', () => v.lower);
    } else if (name === 'macd') {
      const f = args[0] ?? 12;
      const sl = args[1] ?? 26;
      const sg = args[2] ?? 9;
      const m = macd(close, f, sl, sg);
      // canonical keys match rule.js indKey(name, args, part); short aliases exist so the
      // chart can read the default configuration without hard-coding the arg list
      ensure(`macd:${f}:${sl}:${sg}:line`, () => m.line);
      ensure(`macd:${f}:${sl}:${sg}:sig`, () => m.signal);
      ensure(`macd:${f}:${sl}:${sg}:hist`, () => m.hist);
      if (f === 12 && sl === 26 && sg === 9) {
        ensure('macd:line', () => m.line);
        ensure('macd:sig', () => m.signal);
        ensure('macd:hist', () => m.hist);
      }
    } else if (name === 'bb') {
      const p = args[0] ?? 20;
      const k = args[1] ?? 2;
      const b = bollinger(close, p, k);
      ensure(`bb:${p}:${k}:mid`, () => b.mid);
      ensure(`bb:${p}:${k}:up`, () => b.upper);
      ensure(`bb:${p}:${k}:lo`, () => b.lower);
      ensure(`bb:${p}:${k}:w`, () => b.width);
    } else if (name === 'donchian') {
      // EXCLUDE the current bar: a "breakout" of the prior N-bar range is the whole
      // point of the channel, and `close > max(high including this bar)` is impossible
      // by construction (close ≤ high of the same bar), which silently made every
      // donchian-based strategy dead on arrival.
      const p = args[0] ?? 20;
      ensure(`donchian:${p}:hi`, () => rollExcluding(dataset.high, p, 'max'));
      ensure(`donchian:${p}:lo`, () => rollExcluding(dataset.low, p, 'min'));
    } else if (name === 'stoch') {
      const kp = args[0] ?? 14;
      const dp = args[1] ?? 3;
      const sm = args[2] ?? 3;
      const s = stoch(dataset, kp, dp, sm);
      ensure(`stoch:${kp}:${dp}:${sm}`, () => s.k);
      ensure(`stoch:${kp}:${dp}:${sm}:d`, () => s.d);
    }
  }
  return out;
}
