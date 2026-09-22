/**
 * Market feed + provider abstraction.
 *
 * `startFeed()` is the only place in the app that owns a timer. Everything else —
 * chart, automation engine, backtester, P&L — reacts to the events it emits. That
 * keeps a single source of truth for "what bar just closed", which is the property
 * an automation engine must have or strategies double-fire.
 *
 * The demo provider is the in-house simulator. `rest` targets your own gateway and
 * emits the identical payloads, so nothing above this file changes when you switch.
 */
import { UNIVERSE, createSimulatedInstrument, minuteFloor, tfMinutes, SIM_EPOCH } from './sim.js';
import { buildDepth } from './sim.js';

const listeners = new Map(); // event -> Set<fn>

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(payload);
    } catch (err) {
      // A broken UI subscriber must never take the data path down.
      console.error(`[feed:${event}]`, err);
    }
  }
}

export const clock = {
  speed: 1, // 1 = realtime; 60 = one simulated minute per second (time compression)
  simNow: SIM_EPOCH, // advances with the market loop; starts pinned for reproducibility
  running: false,
  setSpeed(s) {
    this.speed = Math.max(0.1, s);
    emit('clock', this);
  },
  toggle() {
    this.running = !this.running;
    emit('clock', this);
    emit('status', { feed: this.running ? 'connected' : 'paused' });
  },
};

const instruments = new Map();
/** last closed bar timestamp per `${symbol}:${tf}` — dedupe key for bar events. */
const lastClosed = new Map();

export function instrumentFor(symbol) {
  if (!instruments.has(symbol)) {
    const meta = UNIVERSE.find((u) => u.symbol === symbol);
    if (!meta) throw new Error(`unknown symbol: ${symbol}`);
    instruments.set(symbol, createSimulatedInstrument(meta));
  }
  return instruments.get(symbol);
}

export function universe() {
  return UNIVERSE;
}

export function quotes() {
  const out = [];
  for (const [symbol, inst] of instruments) {
    const q = inst.quote();
    q.forming = inst.forming;
    q.meta = inst.meta;
    out.push(q);
  }
  return out;
}

export function depth(symbol) {
  const inst = instrumentFor(symbol);
  return buildDepth(inst.meta, inst.forming.close);
}

/** Closed bars only — the forming bar is never exposed to strategies or backtests. */
export function bars(symbol, tf) {
  const inst = instrumentFor(symbol);
  const snap = inst.snapshot(tfMinutes(tf));
  return { ...snap, symbol, tf, minutes: tfMinutes(tf) };
}

let timer = null;
let lastReal = Date.now();

/** Start the market loop. `provider:'rest'` defers to your gateway instead. */
export function startFeed({ provider = 'sim', intervalMs = 420, onRest } = {}) {
  if (timer) return;
  clock.running = true;
  if (provider === 'rest') {
    emit('status', { feed: 'connecting', provider });
    if (typeof onRest === 'function') onRest({ emit, clock, bars });
    return;
  }

  // Warm the whole universe so the watchlist is populated on first paint.
  for (const meta of UNIVERSE) {
    const inst = instrumentFor(meta.symbol);
    lastClosed.set(
      `${meta.symbol}:base`,
      inst.forming.t - 60000
    );
  }

  lastReal = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(4, (now - lastReal) / 1000); // clamp after tab-backgrounding
    lastReal = now;
    clock.simNow += dt * 1000 * clock.speed;

    for (const [symbol, inst] of instruments) {
      inst.step(dt, clock.speed);
      emit('tick', {
        symbol,
        price: inst.forming.close,
        forming: inst.forming,
        quote: inst.quote(),
        meta: inst.meta,
      });

      // A bar on timeframe `tf` is closed once the forming bar's start has moved
      // past the tf boundary. Deriving from the simulator's own clock (not wall
      // time) is what keeps 1m/5m/1h/1D event ordering exact under compression.
      const formingT = inst.forming.t;
      for (const tf of ['1m', '5m', '15m', '1h', '4h', '1D']) {
        const tfMs = tfMinutes(tf) * 60000;
        const closed = Math.floor(formingT / tfMs) * tfMs - tfMs;
        const key = `${symbol}:${tf}`;
        if (closed > (lastClosed.get(key) ?? -1)) {
          lastClosed.set(key, closed);
          emit('bar', { symbol, tf, t: closed, price: inst.forming.close });
        }
      }
      // keep the legacy base marker fresh (used by nothing but useful in tests)
      lastClosed.set(`${symbol}:base`, minuteFloor(inst.forming.t) - 60000);
    }
    emit('clock', clock);
  }, intervalMs);

  emit('status', { feed: 'connected', provider: 'sim' });
}

export function stopFeed() {
  if (timer) clearInterval(timer);
  timer = null;
  clock.running = false;
  emit('status', { feed: 'stopped', provider: 'sim' });
}
