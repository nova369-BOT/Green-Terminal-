/**
 * App state — one flat observable object, `useSyncExternalStore`-shaped.
 * Deliberately not a framework store: the terminal's hot path is the feed loop, and
 * the fewer re-render indirections between a tick and a pixel, the fewer stale frames.
 */
const listeners = new Set();

export const state = {
  symbol: 'BTC/USD',
  tf: '1h',
  barsBack: 170,
  offset: 0, // bars scrolled right of the newest bar (0 = live edge)
  overlays: { ema20: true, ema50: true, ema200: true, vwap: true, bb: false, donchian: false },
  panes: { volume: true, rsi: true, macd: false },
  showAutomation: true,
  activeTab: 'trade',
  consoleOpen: true,
  consoleFilter: 'all',
  watch: [],
  toast: null,
  builder: null, // strategy draft being edited in the automation tab
  lastResult: null, // most recent backtest result set
  hoveredBar: null,
  priceLines: [],
  barCount: 0,
  marks: {},
  quote: null,
  meta: null,
  startedAt: Date.now(),
  /** wall-clock boot time; pair with feed clock.simNow when labelling events */
};

export function get() {
  return state;
}

export function set(patch, { silent = false } = {}) {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] !== v) {
      state[k] = v;
      changed = true;
    }
  }
  if (changed && !silent) emit();
  return changed;
}

export function patchDeep(path, value) {
  const keys = path.split('.');
  let cur = state;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] ??= {};
  cur[keys[keys.length - 1]] = value;
  emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let queued = false;
export function emit() {
  if (queued) return;
  queued = true;
  // Coalesce bursts of state writes into one paint per frame.
  queueMicrotask(() => {
    queued = false;
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (err) {
        console.error('[store]', err);
      }
    }
  });
}

let toastSeq = 0;
export function toast(text, tone = 'info', ttl = 4200) {
  state.toast = { id: ++toastSeq, text, tone, at: Date.now() };
  emit();
  setTimeout(() => {
    if (state.toast?.id === toastSeq) {
      state.toast = null;
      emit();
    }
  }, ttl);
}
