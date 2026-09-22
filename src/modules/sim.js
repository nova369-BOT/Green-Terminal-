/**
 * Market simulator — the reference data provider.
 *
 * Why a simulator instead of a scraped feed: the sandbox can't reach exchanges, and
 * more importantly an automation engine is only trustworthy if the data behind it is
 * deterministic and reproducible. Every symbol here is generated from a 32-bit seed,
 * so a backtest result is re-runnable to the tick — which is exactly the property a
 * strategy vendor needs before you trust a live order path.
 *
 * Model: log-price jump-diffusion with GARCH-style volatility clustering, a slow
 * regime drift (so trends exist and indicators are meaningful), intraday volume
 * seasonality, and hard price limits. Realistic fat tails, not random walk confetti.
 */

/**
 * Fixed demo epoch. The simulator's RNG path is anchored to absolute minutes, so a
 * wall-clock start made every backtest drift as the session ran (same config, different
 * numbers minutes later — the fastest way to lose a trader's trust). History now begins
 * at this instant and only advances with the simulated clock.
 */
export const SIM_EPOCH = Date.UTC(2026, 8, 15, 12, 0, 0); // 15 Sep 2026 12:00:00 UTC, hour-aligned

export const UNIVERSE = [
  {
    symbol: 'BTC/USD',
    label: 'Bitcoin',
    venue: 'GREENX',
    class: 'crypto',
    seed: 0x5eed01,
    start: 61250,
    tick: 0.5,
    qtyStep: 0.0001,
    annVol: 0.52,
    hours: 24,
    contract: 'spot',
  },
  {
    symbol: 'ETH/USD',
    label: 'Ethereum',
    venue: 'GREENX',
    class: 'crypto',
    seed: 0x5eed02,
    start: 3385,
    tick: 0.01,
    qtyStep: 0.001,
    annVol: 0.66,
    hours: 24,
    contract: 'spot',
  },
  {
    symbol: 'SOL/USD',
    label: 'Solana',
    venue: 'GREENX',
    class: 'crypto',
    seed: 0x5eed03,
    start: 148.2,
    tick: 0.001,
    qtyStep: 0.1,
    annVol: 0.92,
    hours: 24,
    contract: 'spot',
  },
  {
    symbol: 'NVDA',
    label: 'NVIDIA Corp',
    venue: 'GREENUS',
    class: 'equity',
    seed: 0x5eed04,
    start: 121.4,
    tick: 0.01,
    qtyStep: 1,
    annVol: 0.51,
    hours: 16,
    contract: 'stock',
  },
  {
    symbol: 'AAPL',
    label: 'Apple Inc',
    venue: 'GREENUS',
    class: 'equity',
    seed: 0x5eed05,
    start: 227.9,
    tick: 0.01,
    qtyStep: 1,
    annVol: 0.26,
    hours: 16,
    contract: 'stock',
  },
  {
    symbol: 'TSLA',
    label: 'Tesla Inc',
    venue: 'GREENUS',
    class: 'equity',
    seed: 0x5eed06,
    start: 219.6,
    tick: 0.01,
    qtyStep: 1,
    annVol: 0.58,
    hours: 16,
    contract: 'stock',
  },
  {
    symbol: 'XAU/USD',
    label: 'Gold Spot',
    venue: 'GREENFX',
    class: 'commodity',
    seed: 0x5eed07,
    start: 2338.5,
    tick: 0.05,
    qtyStep: 0.1,
    annVol: 0.15,
    hours: 24,
    contract: 'spot',
  },
  {
    symbol: 'SPX',
    label: 'S&P 500 Index',
    venue: 'GREENIDX',
    class: 'index',
    seed: 0x5eed08,
    start: 5128.75,
    tick: 0.25,
    qtyStep: 1,
    annVol: 0.14,
    hours: 24,
    contract: 'cash',
  },
];

export const TIMEFRAMES = [
  { id: '1m', label: '1m', minutes: 1 },
  { id: '5m', label: '5m', minutes: 5 },
  { id: '15m', label: '15m', minutes: 15 },
  { id: '1h', label: '1h', minutes: 60 },
  { id: '4h', label: '4h', minutes: 240 },
  { id: '1D', label: '1D', minutes: 1440 },
];

export const tfMinutes = (id) => TIMEFRAMES.find((t) => t.id === id)?.minutes ?? 1;

/** Deterministic 32-bit PRNG (mulberry32). Small, fast, reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussPair(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

/** Minutes since epoch, truncated to a 1m boundary in UTC. */
export const minuteFloor = (ms) => Math.floor(ms / 60000) * 60000;

/**
 * Generate the base 1-minute series for a symbol, then keep it alive.
 * Returns a live object — `step()` advances the clock and mutates the forming bar.
 */
export function createSimulatedInstrument(meta, { historyMinutes = 90 * 1440, capacity = 512 } = {}) {
  const rng = makeRng(meta.seed);
  const barsPerDay = meta.class === 'crypto' ? 1440 : 1440;
  const dt = 1 / (barsPerDay * 365); // one minute in years
  const baseSigma = meta.annVol * Math.sqrt(dt);

  const cap = historyMinutes + capacity;
  const t = new Float64Array(cap);
  const open = new Float64Array(cap);
  const high = new Float64Array(cap);
  const low = new Float64Array(cap);
  const close = new Float64Array(cap);
  const volume = new Float64Array(cap);
  let count = 0;

  let logP = Math.log(meta.start);
  let s2 = baseSigma * baseSigma; // variance state (GARCH)
  let drift = 0; // slow regime component, in log-returns per minute
  let anchor = logP; // weak mean reversion keeps 45k bars from wandering off-earth
  const w = 0.00002;
  const gArch = 0.88;
  const bArch = 0.1;

  const endMinute = minuteFloor(SIM_EPOCH);
  const startMinute = endMinute - historyMinutes * 60000;

  function returnsFor(barIndex, minuteOfDay) {
    // GARCH(1,1)-ish clustering: vol feeds on recent squared returns
    const shock = gaussPair(rng);
    const z = shock[0];
    s2 = w + bArch * z * z * s2 + gArch * s2;
    let sigma = Math.sqrt(s2);
    sigma = Math.min(sigma, baseSigma * 6);

    // Regime drift, STATIONARITY-FIRST: kicks are rare, decay fast (half-life ~12h) and
    // are hard-capped so the realised annual drift stays in a plausible band. An uncapped
    // regime term is how a simulator turns BTC into a quadrillion-dollar asset in 45 days
    // and quietly ruins every indicator downstream (the root cause of "no strategy fires").
    if (rng() < 1 / 2600) drift += (rng() - 0.5) * baseSigma * 0.8;
    drift *= 0.999;
    drift = Math.max(-baseSigma * 0.8, Math.min(baseSigma * 0.8, drift));

    // intraday vol seasonality: busier around the open/close
    const phase = (minuteOfDay / 1440) * Math.PI * 2;
    const season =
      1 +
      0.55 * Math.cos(phase - Math.PI * 0.5) ** 8 +
      (meta.class === 'equity' ? 0.5 * Math.exp(-((minuteOfDay - 570) ** 2) / 900) : 0);

    let ret = drift + sigma * season * z;
    // fat tails: jump component, sized in ATR-ish units not quadrillions
    if (rng() < 0.0006) ret += (rng() - 0.5) * sigma * 12;
    // Ornstein–Uhlenbeck pull: the anchor drifts slowly with the regime, while the
    // deviation from it mean-reverts (half-life ≈ log(2)/1.2e-4 ≈ 96 min for the
    // fast component, slower tail kept by the small coefficient)
    ret += (anchor - logP) * 1.2e-4;
    logP += ret;
    // keep the anchor travelling with the regime so trends exist, but let the pull above
    // erase them on a multi-day horizon — price stays within a few multiples of `start`
    anchor += drift * 0.5;
    // hard leash: never more than ±100% from where the anchor currently sits
    const leash = anchor + Math.log(2.1);
    if (logP > leash) logP = leash;
    if (logP < anchor - Math.log(2.1)) logP = anchor - Math.log(2.1);
    return { ret, sigma: sigma * season };
  }

  function newBar(index, ts) {
    const prevClose = count > 0 ? close[count - 1] : Math.exp(logP);
    const minuteOfDay = new Date(ts).getUTCHours() * 60 + new Date(ts).getUTCMinutes();
    const { ret, sigma } = returnsFor(index, minuteOfDay);
    const o = prevClose;
    const c = Math.exp(logP);
    // intra-bar extremes from a 3-substep path, scaled by realised sigma
    let hi = Math.max(o, c);
    let lo = Math.min(o, c);
    for (let s = 0; s < 3; s++) {
      const path = Math.exp(logP + (rng() - 0.5) * sigma * 2.1);
      hi = Math.max(hi, path);
      lo = Math.min(lo, path);
    }
    const rangePct = Math.abs(ret) + sigma * 1.4;
    const v = (meta.class === 'equity' ? 120000 : 42) * (0.35 + rangePct * 110) * (0.6 + rng() * 0.85);
    t[index] = ts;
    open[index] = o;
    high[index] = hi;
    low[index] = lo;
    close[index] = c;
    volume[index] = v;
    ret;
  }

  for (let i = 0; i < historyMinutes; i++) {
    newBar(i, startMinute + i * 60000);
    count = i + 1;
  }
  if (count > 0) anchor = Math.log(close[count - 1]) * 0.02 + anchor * 0.98;

  // Forming (unclosed) bar for the current minute.
  let forming = null;
  function openForming(ts) {
    const last = count > 0 ? close[count - 1] : Math.exp(logP);
    return { t: ts, open: last, high: last, low: last, close: last, volume: 0 };
  }
  forming = openForming(minuteFloor(SIM_EPOCH));

  const dataset = { t, open, high, low, close, volume, count: () => count, meta };

  /**
   * Advance simulated time by `elapsedMs` of real time at `speed` minutes/second.
   * Returns { closedBars, quote } — the feed turns that into events.
   */
  let minuteRemainder = 0; // accumulates sub-minute sim time so 1× closes on the real minute
  function step(secondsElapsed, speed) {
    const simulatedSeconds = secondsElapsed * speed * 60;
    minuteRemainder += simulatedSeconds;
    const extraMinutes = Math.floor(minuteRemainder / 60);
    minuteRemainder -= extraMinutes * 60;
    let closed = 0;
    for (let k = 0; k < extraMinutes; k++) {
      if (count >= cap - 4) {
        // history window is full: slide by dropping the oldest bars is overkill for
        // a demo, so we simply stop appending and keep the forming bar alive.
        break;
      }
      const ts = forming.t + 60000;
      // finalize the forming bar into the series
      t[count] = forming.t;
      open[count] = forming.open;
      high[count] = forming.high;
      low[count] = forming.low;
      close[count] = forming.close;
      volume[count] = forming.volume;
      count++;
      closed++;
      forming = openForming(ts);
      // roll forward one minute of micro-steps
      const minuteOfDay = new Date(ts).getUTCHours() * 60 + new Date(ts).getUTCMinutes();
      const { sigma } = returnsFor(count, minuteOfDay);
      forming.high = Math.max(forming.high, forming.close);
      forming.low = Math.min(forming.low, forming.close);
      forming.volume = (meta.class === 'equity' ? 120000 : 42) * (0.4 + sigma * 90) * (0.5 + rng());
    }
    // animate the forming bar within the minute
    const frac = minuteRemainder / 60;
    const lastClosed = count > 0 ? close[count - 1] : forming.close;
    const [g] = gaussPair(rng);
    const wiggle = lastClosed * baseSigma * 0.55 * g * (0.3 + frac);
    forming.close = Math.exp(logP) + wiggle;
    forming.high = Math.max(forming.high, forming.close);
    forming.low = Math.min(forming.low, forming.close);
    return { closed, forming, last: forming.close };
  }

  function quote() {
    const from = Math.max(0, count - 1440);
    let hi = -Infinity;
    let lo = Infinity;
    let vol = 0;
    for (let i = from; i < count; i++) {
      if (high[i] > hi) hi = high[i];
      if (low[i] < lo) lo = low[i];
      vol += volume[i];
    }
    const last = forming.close;
    const ref = count > 0 ? close[from] : last;
    return {
      symbol: meta.symbol,
      last,
      change: last - ref,
      changePct: ref === 0 ? 0 : last / ref - 1,
      high: Math.max(hi, forming.high),
      low: Math.min(lo, forming.low),
      volume: vol,
      spreadTicks: Math.max(1, Math.round(0.6 + Math.abs(gaussPair(rng)[0]) * 1.4)),
    };
  }

  /** Closed bars only — never expose the forming bar to the backtester. */
  function snapshot(tfMin) {
    if (tfMin <= 1) {
      return {
        t: t.subarray(0, count),
        open: open.subarray(0, count),
        high: high.subarray(0, count),
        low: low.subarray(0, count),
        close: close.subarray(0, count),
        volume: volume.subarray(0, count),
        len: count,
        meta,
      };
    }
    const stepMs = tfMin * 60000;
    const ot = [];
    const oo = [];
    const oh = [];
    const ol = [];
    const oc = [];
    const ov = [];
    let bucket = -1;
    for (let i = 0; i < count; i++) {
      const b = Math.floor(t[i] / stepMs);
      if (b !== bucket) {
        bucket = b;
        ot.push(b * stepMs);
        oo.push(open[i]);
        oh.push(high[i]);
        ol.push(low[i]);
        oc.push(close[i]);
        ov.push(volume[i]);
      } else {
        const j = ot.length - 1;
        if (high[i] > oh[j]) oh[j] = high[i];
        if (low[i] < ol[j]) ol[j] = low[i];
        oc[j] = close[i];
        ov[j] += volume[i];
      }
    }
    return {
      t: Float64Array.from(ot),
      open: Float64Array.from(oo),
      high: Float64Array.from(oh),
      low: Float64Array.from(ol),
      close: Float64Array.from(oc),
      volume: Float64Array.from(ov),
      len: ot.length,
      meta,
    };
  }

  return { meta, step, quote, snapshot, dataset, get forming() { return forming; }, get count() { return count; } };
}

/** Synthetic order book around a mid price — depth panel + slippage model source. */
export function buildDepth(meta, mid, levels = 14) {
  const rng = makeRng(((meta.seed ^ Math.round(mid * 100)) >>> 0) + 7);
  const spread = meta.tick * (1 + Math.floor(rng() * 2));
  const book = { bids: [], asks: [] };
  for (let i = 0; i < levels; i++) {
    const decay = Math.exp(-i / 7);
    book.bids.push({
      price: mid - spread / 2 - i * spread,
      qty: meta.qtyStep * (400 + rng() * 4200) * decay,
    });
    book.asks.push({
      price: mid + spread / 2 + i * spread,
      qty: meta.qtyStep * (400 + rng() * 4200) * decay,
    });
  }
  return book;
}
