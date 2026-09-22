/**
 * Automation runtime — the thing that makes this a terminal instead of a chart.
 *
 * Responsibilities:
 *  - evaluate every deployed strategy exactly once per closed bar of its timeframe
 *    (keyed on bar timestamp, so a restart or a burst of ticks cannot double-fire)
 *  - route approved signals through the paper broker, which owns the risk overlay
 *  - keep an append-only decision log (why a trade happened, and why one was refused)
 *
 * Modes per strategy: `shadow` (evaluate + log, never trade — the correct first move
 * for any new idea), `armed` (trade the paper account), `paused`.
 */
import { on as onFeed, bars, clock, quotes } from './feed.js';
import { evalRule, compile, ruleText, validateStrategy } from './rule.js';
import { account, openPosition, closePosition, sizePosition, mark, equity, positionFor, metaFor } from './broker.js';

const LS_KEY = 'green-terminal:strategies';

export const engine = {
  deployed: new Map(), // id -> { strategy, rt }
  log: [], // {at, level, symbol, text, strategyId}
  prices: new Map(),
  running: false,
  evaluations: 0,
  signals: 0,
  rejections: 0,
  lastEvalT: new Map(),
};

let listeners = new Set();
export function onEngine(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const notify = () => {
  for (const fn of listeners) fn(engine);
};

export function log(level, text, { symbol = '', strategyId = null } = {}) {
  engine.log.unshift({ at: Date.now(), level, text, symbol, strategyId, sim: clock.simNow });
  if (engine.log.length > 500) engine.log.pop();
  notify();
}

/* ------------------------------------------------------------------ strategies */

export function deploy(rawStrategy, { persist = true } = {}) {
  const errors = validateStrategy(rawStrategy);
  if (errors.length) return { ok: false, errors };
  const strategy = {
    ...structuredClone(rawStrategy),
    id: rawStrategy.id ?? `S${String(Date.now()).slice(-6)}`,
    createdAt: Date.now(),
    mode: rawStrategy.mode ?? 'shadow',
  };
  const rt = {
    status: strategy.mode === 'off' ? 'paused' : 'armed',
    positionId: null,
    barsEvaluated: 0,
    hits: 0,
    errors: 0,
    lastSignal: null,
    lastBarT: 0,
    startedAt: Date.now(),
    realised: 0,
    trades: [],
    ctxCache: null,
    ctxKey: '',
  };
  engine.deployed.set(strategy.id, { strategy, rt });
  if (persist) save();
  log('ok', `deployed "${strategy.name}" on ${strategy.symbol} ${strategy.tf} [${strategy.mode}]`, { symbol: strategy.symbol, strategyId: strategy.id });
  notify();
  return { ok: true, strategy, rt };
}

export function undeploy(id, { persist = true } = {}) {
  const entry = engine.deployed.get(id);
  if (!entry) return { ok: false, msg: 'not deployed' };
  if (entry.rt.positionId) closePosition(entry.rt.positionId, { price: engine.prices.get(entry.strategy.symbol), reason: 'strategy undeployed', kind: 'exit' });
  engine.deployed.delete(id);
  if (persist) save();
  log('warn', `undeployed "${entry.strategy.name}"${entry.rt.positionId ? ' (position flattened)' : ''}`, { symbol: entry.strategy.symbol });
  notify();
  return { ok: true };
}

export function setMode(id, mode) {
  const entry = engine.deployed.get(id);
  if (!entry) return;
  entry.strategy.mode = mode;
  entry.rt.status = mode === 'off' ? 'paused' : mode === 'shadow' ? 'watching' : 'armed';
  if (mode === 'off' && entry.rt.positionId) {
    closePosition(entry.rt.positionId, { price: engine.prices.get(entry.strategy.symbol), reason: 'manual flatten', kind: 'exit' });
    entry.rt.positionId = null;
  }
  save();
  log(mode === 'off' ? 'warn' : 'ok', `"${entry.strategy.name}" → ${mode}`, { symbol: entry.strategy.symbol, strategyId: id });
  notify();
}

export function setAllHalted(halted) {
  for (const [, { strategy }] of engine.deployed) if (halted) setMode(strategy.id, 'off');
  log(halted ? 'alert' : 'ok', halted ? 'KILL SWITCH — all automation halted and positions flattened' : 'automation released');
  notify();
}

/* ------------------------------------------------------------------ evaluation */

function contextFor(strategy, dataset) {
  const key = `${strategy.id}:${strategy.tf}:${dataset.len}:${dataset.t[dataset.len - 1]}`;
  const entry = engine.deployed.get(strategy.id);
  if (entry?.rt.ctxKey === key) return entry.rt.ctxCache;
  const ctx = compile(dataset, strategy);
  if (entry) {
    entry.rt.ctxKey = key;
    entry.rt.ctxCache = ctx;
  }
  return ctx;
}

/** Evaluate one closed bar for one strategy. Pure decision + side effects via broker. */
export function evaluateStrategy(entry, dataset) {
  const { strategy, rt } = entry;
  const i = dataset.len - 1;
  if (i < 1) return null;
  const ctx = contextFor(strategy, dataset);
  ctx.varState = ctx.varState ?? {};
  engine.evaluations++;
  rt.barsEvaluated++;

  const held = positionFor(strategy.symbol);
  if (held && rt.positionId !== held.id) rt.positionId = held.id;
  ctx.varState.barsInPosition = held ? i - (held.entryBar ?? i) : 0;
  ctx.varState.unrealisedPct = held ? held.unrealisedPct ?? 0 : 0;

  const barT = dataset.t[i];
  const heldOpen = held && strategy.holdThroughExit;

  // exit first: risk-reducing actions always take precedence over new exposure
  if (held && strategy.exit && !heldOpen && evalRule(strategy.exit, ctx, i)) {
    if (strategy.mode === 'armed') {
      const r = closePosition(held.id, { price: engine.prices.get(strategy.symbol), reason: 'exit signal', kind: 'exit' });
      rt.positionId = null;
      rt.realised += r.pnl ?? 0;
      log('exec', `${strategy.name}: EXIT signal on ${strategy.symbol} @ ${dataset.close[i].toFixed(2)} → ${r.ok ? `closed (${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(2)})` : r.msg}`, { symbol: strategy.symbol, strategyId: strategy.id });
    } else if (strategy.mode === 'shadow') {
      log('shadow', `${strategy.name}: would EXIT ${strategy.symbol} (shadow mode)`, { symbol: strategy.symbol, strategyId: strategy.id });
    }
    rt.lastSignal = { at: barT, side: 'exit', price: dataset.close[i] };
    rt.hits++;
    engine.signals++;
    return { fired: 'exit', price: dataset.close[i] };
  }

  if (held) return null; // one position per strategy: no silent pyramiding

  const fired = evalRule(strategy.entry, ctx, i);
  if (!fired) return null;
  rt.hits++;
  engine.signals++;
  const side = strategy.direction === 'short' ? 'short' : 'long';
  const entryPrice = dataset.close[i];
  const meta = metaFor(strategy.symbol) ?? dataset.meta;
  const stopPct = strategy.exits?.stopPct ?? null;
  const takePct = strategy.exits?.takePct ?? null;
  const d = side === 'long' ? 1 : -1;
  const stop = stopPct ? entryPrice - d * entryPrice * stopPct : null;
  const take = takePct ? entryPrice + d * entryPrice * takePct : null;
  const eq = equity(Object.fromEntries(engine.prices));

  if (strategy.mode !== 'armed') {
    log('shadow', `${strategy.name}: ${side.toUpperCase()} signal @ ${entryPrice.toFixed(2)} — shadow mode, no order sent`, { symbol: strategy.symbol, strategyId: strategy.id });
    rt.lastSignal = { at: barT, side, price: entryPrice };
    return { fired: 'signal', price: entryPrice, shadow: true };
  }

  const size = sizePosition({ strategy, equityValue: eq, entry: entryPrice, stop, meta, side });
  if (!size.ok) {
    engine.rejections++;
    rt.errors++;
    log('reject', `${strategy.name}: refused — ${size.msg}`, { symbol: strategy.symbol, strategyId: strategy.id });
    return { fired: 'rejected', msg: size.msg };
  }
  const res = openPosition({
    symbol: strategy.symbol,
    side,
    qty: size.qty,
    entry: entryPrice,
    strategy,
    type: 'market',
    stop,
    take,
    trail: strategy.exits?.trail,
    reason: ruleText(strategy.entry),
    marks: Object.fromEntries(engine.prices),
  });
  if (!res.ok) {
    engine.rejections++;
    log('reject', `${strategy.name}: broker refused — ${res.msg}`, { symbol: strategy.symbol, strategyId: strategy.id });
    return { fired: 'rejected', msg: res.msg };
  }
  rt.positionId = res.position.id;
  rt.trades.push(res.position.id);
  rt.lastSignal = { at: barT, side, price: res.fill };
  log('exec', `${strategy.name}: ${side.toUpperCase()} ${size.qty} ${strategy.symbol} @ ${res.fill} · ${size.basis}${stop ? ` · stop ${stop.toFixed(2)}` : ''}${take ? ` · target ${take.toFixed(2)}` : ''}`, {
    symbol: strategy.symbol,
    strategyId: strategy.id,
  });
  return { fired: 'entry', price: res.fill, qty: size.qty, positionId: res.position.id };
}

let started = false;
export function startEngine() {
  if (started) return;
  started = true;
  engine.running = true;

  onFeed('tick', ({ symbol, price }) => {
    engine.prices.set(symbol, price);
  });

  // Risk overlay runs on every tick: a stop that only checks at the close is a suggestion.
  onFeed('tick', () => {
    if (engine.deployed.size === 0 && account.positions.size === 0) return;
    mark(Object.fromEntries(engine.prices));
  });

  onFeed('bar', ({ symbol, tf }) => {
    if (account.killSwitch) return;
    for (const entry of engine.deployed.values()) {
      const s = entry.strategy;
      if (s.symbol !== symbol || s.tf !== tf) continue;
      if (entry.rt.status === 'paused') continue;
      if (account.halted && s.mode === 'armed') continue;
      const dataset = bars(symbol, tf);
      evaluateStrategy(entry, dataset);
    }
    notify();
  });
}

/* ------------------------------------------------------------------ persistence */

export function save() {
  try {
    const list = [...engine.deployed.values()].map(({ strategy, rt }) => ({ ...strategy, _rt: { realised: rt.realised, hits: rt.hits } }));
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* private mode / no storage: terminal still works, just doesn't remember */
  }
}

export function restore() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) return [];
  const restored = [];
  for (const s of list) {
    if (validateStrategy(s).length) continue;
    const entry = {
      strategy: { ...s, mode: s.mode ?? 'shadow' },
      rt: {
        status: s.mode === 'off' ? 'paused' : s.mode === 'shadow' ? 'watching' : 'armed',
        positionId: null,
        barsEvaluated: 0,
        hits: s._rt?.hits ?? 0,
        errors: 0,
        lastSignal: null,
        lastBarT: 0,
        startedAt: Date.now(),
        realised: s._rt?.realised ?? 0,
        trades: [],
        ctxCache: null,
        ctxKey: '',
      },
    };
    engine.deployed.set(s.id, entry);
    restored.push(s.name);
  }
  if (restored.length) log('ok', `restored ${restored.length} strategy${restored.length > 1 ? 'ies' : 'ies'}: ${restored.join(', ')}`);
  return restored;
}

export function engineSnapshot() {
  return {
    running: engine.running,
    evaluations: engine.evaluations,
    signals: engine.signals,
    rejections: engine.rejections,
    count: engine.deployed.size,
    log: engine.log.slice(0, 120),
  };
}
