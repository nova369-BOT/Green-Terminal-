/**
 * Paper broker + risk overlay.
 *
 * The rule that keeps a trading system alive: the risk layer is *not* part of the
 * strategy. Stops, the daily loss limit, max concurrent positions and the kill switch
 * are enforced here, after every strategy decision, so a buggy or over-eager strategy
 * physically cannot exceed them. Same code path for backtests and live fills — that is
 * what makes backtest numbers mean something.
 */
import { UNIVERSE } from './sim.js';
import { computeSize } from './sizing.js';

export const metaFor = (symbol) => UNIVERSE.find((u) => u.symbol === symbol);

export const account = {
  name: 'GREEN-DEMO-01',
  baseCurrency: 'USD',
  startingEquity: 250000,
  cash: 250000,
  realisedToday: 0,
  feePaid: 0,
  dayStartEquity: 250000,
  peakEquity: 250000,
  positions: new Map(), // id -> position
  orders: [], // resting limit orders
  fills: [], // trade blotter (newest first)
  seq: 1,
  risk: {
    maxRiskPct: 0.01, // per-trade risk budget cap the sizing will honour
    maxPositions: 6,
    maxGrossPct: 1.6, // gross notional / equity
    dailyLossLimitPct: 0.035, // hard stop: flatten + halt at −3.5% on the day
    feeBps: 4,
    slippageBps: 2.5,
  },
  killSwitch: false,
  halted: null, // { reason, at } when the risk overlay stopped trading
};

const listeners = new Set();
export function onAccount(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn(account);
}

export function equity(marks) {
  let eq = account.cash;
  for (const p of account.positions.values()) {
    const mark = marks?.[p.symbol] ?? p.mark ?? p.entry;
    eq += (p.side === 'long' ? 1 : -1) * p.qty * mark;
  }
  return eq;
}

export function positionFor(symbol) {
  for (const p of account.positions.values()) if (p.symbol === symbol) return p;
  return null;
}

/** Net exposure per symbol — lets a second strategy reduce an existing position instead of doubling. */
export function netQty(symbol) {
  let q = 0;
  for (const p of account.positions.values()) if (p.symbol === symbol) q += (p.side === 'long' ? 1 : -1) * p.qty;
  return q;
}

export function roundToStep(value, step, mode = 'nearest') {
  if (!step) return value;
  const raw = value / step;
  const n = mode === 'down' ? Math.floor(raw) : mode === 'up' ? Math.ceil(raw) : Math.round(raw);
  return n * step;
}

export function roundPrice(price, tick, mode = 'nearest') {
  return roundToStep(price, tick, mode);
}

/**
 * Sizing delegates to the shared pure core so a backtest and a live fill can never
 * disagree about how big a trade is.
 */
export function sizePosition({ strategy, equityValue, entry, stop, meta, side = 'long', leverage = 1 }) {
  return computeSize({
    sizing: strategy?.sizing,
    equity: equityValue,
    entry,
    stop,
    meta,
    risk: account.risk,
    grossNow: [...account.positions.values()].reduce((s, p) => s + p.qty * (p.mark ?? p.entry), 0),
    leverage,
    side,
  });
}

function blot(f) {
  account.fills.unshift(f);
  if (account.fills.length > 400) account.fills.pop();
}

/**
 * Execute an entry. `type:'market'` fills at the touch plus slippage; `type:'limit'`
 * rests until price crosses (checked on every tick by the engine).
 */
export function openPosition({ symbol, side, qty, entry, strategy, type = 'market', limit, stop, take, trail, reason, marks }) {
  if (account.killSwitch) return { ok: false, code: 'killed', msg: 'Kill switch engaged — trading halted.' };
  if (account.halted) return { ok: false, code: 'halted', msg: `Halted: ${account.halted.reason}` };
  const meta = metaFor(symbol);
  if (!meta) return { ok: false, code: 'unknown', msg: `Unknown instrument ${symbol}` };
  if (type === 'market') {
    const px = roundPrice(entry, meta.tick, side === 'long' ? 'up' : 'down');
    const slip = account.risk.slippageBps / 1e4;
    const fill = roundPrice(px * (1 + slip * (side === 'long' ? 1 : -1)), meta.tick);
    const fee = Math.abs(qty * fill) * (account.risk.feeBps / 1e4);
    account.cash -= (side === 'long' ? 1 : -1) * qty * fill;
    account.cash -= fee;
    account.feePaid += fee;
    const id = `P${String(account.seq++).padStart(4, '0')}`;
    const pos = {
      id,
      symbol,
      side,
      qty,
      entry: fill,
      stop: stop ?? null,
      take: take ?? null,
      trail: trail ? { ...trail, active: false, distance: stop != null ? Math.abs(fill - stop) : fill * 0.02 } : null,
      peak: fill,
      trough: fill,
      openedAt: Date.now(),
      strategyId: strategy?.id ?? null,
      strategyName: strategy?.name ?? 'manual',
      reason: reason ?? 'manual order',
      mark: fill,
      unrealised: 0,
      // planned risk at entry — the denominator for every R multiple we ever show
      risk0: stop != null ? Math.abs(fill - stop) * qty : null,
      meta,
    };
    account.positions.set(id, pos);
    blot({
      id: `F${account.seq}R`,
      at: Date.now(),
      symbol,
      side,
      qty,
      price: fill,
      fee,
      kind: 'entry',
      strategy: pos.strategyName,
      note: `fills at ${fill} · ${pos.reason}`,
    });
    emit();
    return { ok: true, position: pos, fill };
  }
  // resting limit
  const px = roundPrice(limit ?? entry, meta.tick, side === 'long' ? 'down' : 'up');
  account.orders.push({
    id: `O${account.seq++}`,
    at: Date.now(),
    symbol,
    side,
    qty,
    limit: px,
    strategy,
    stop,
    take,
    trail,
    reason,
    status: 'working',
  });
  emit();
  return { ok: true, resting: true, limit: px };
}

export function closePosition(id, { price, qty = null, reason = 'exit', kind = 'exit', marks } = {}) {
  const pos = account.positions.get(id);
  if (!pos) return { ok: false, code: 'not_found', msg: 'Position already closed.' };
  const meta = pos.meta ?? metaFor(pos.symbol);
  const fill = roundPrice(price ?? pos.mark ?? pos.entry, meta.tick);
  const closeQty = qty == null ? pos.qty : Math.min(qty, pos.qty);
  const dir = pos.side === 'long' ? 1 : -1; // long exit returns cash, short exit pays cash back out
  const feeRate = account.risk.feeBps / 1e4;
  const exitFee = closeQty * fill * feeRate;
  const entryFee = closeQty * pos.entry * feeRate * (closeQty / (pos.qty || closeQty));
  account.cash += dir * closeQty * fill;
  account.cash -= exitFee;
  account.feePaid += exitFee;
  const pnl = dir * (fill - pos.entry) * closeQty - exitFee - entryFee;
  account.realisedToday += pnl;
  pos.qty -= closeQty;
  blot({
    id: `F${account.seq}X`,
    at: Date.now(),
    symbol: pos.symbol,
    side: pos.side,
    qty: closeQty,
    price: fill,
    fee: exitFee,
    kind,
    strategy: pos.strategyName,
    note: `${reason} · P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
    pnl,
  });
  if (pos.qty <= (meta.qtyStep ?? 0.0001) * 0.999) account.positions.delete(id);
  emit();
  return { ok: true, pnl, fill };
}

/** Mark-to-market + the hard risk overlay (stops, targets, trailing, daily limit). */
export function mark(marks) {
  const events = [];
  for (const p of account.positions.values()) {
    const px = marks[p.symbol];
    if (!Number.isFinite(px)) continue;
    p.mark = px;
    p.peak = Math.max(p.peak, px);
    p.trough = Math.min(p.trough, px);
    const dir = p.side === 'long' ? 1 : -1;
    p.unrealised = dir * (px - p.entry) * p.qty;
    p.unrealisedPct = dir * (px / p.entry - 1);
    p.rMultiple = p.risk0 ? p.unrealised / p.risk0 : null;
    // Trail lifecycle: arms only after the position has paid for the room it needs,
    // then ratchets the visible stop (so the chart shows the live trailing level and
    // a trail hit is still just a stop hit with a better label).
    if (p.trail) {
      const dist = p.trail.distance ?? Math.abs(p.entry - (p.stop ?? p.entry));
      const favourable = dir * (px - p.entry);
      if (!p.trail.active && favourable >= dist * 0.5) p.trail.active = true;
      if (p.trail.active) {
        const anchor2 = dir === 1 ? p.peak : p.trough;
        const next = dir === 1 ? anchor2 - dist : anchor2 + dist;
        if (dir === 1 ? next > (p.stop ?? -Infinity) : next < (p.stop ?? Infinity)) {
          if (p.stop != null && !p.trailRatcheted) p.trail.originalStop = p.stop;
          p.trailRatcheted = true;
          p.stop = next;
        }
      }
    }
  }
  // resting limit fills
  for (const o of [...account.orders]) {
    const px = marks[o.symbol];
    if (!Number.isFinite(px)) continue;
    const crossed = o.side === 'long' ? px <= o.limit : px >= o.limit;
    if (crossed) {
      account.orders = account.orders.filter((x) => x !== o);
      const res = openPosition({
        symbol: o.symbol,
        side: o.side,
        qty: o.qty,
        entry: o.limit,
        strategy: o.strategy,
        type: 'market',
        stop: o.stop,
        take: o.take,
        trail: o.trail,
        reason: `limit ${o.limit} filled`,
        marks,
      });
      if (res.ok) events.push({ level: 'exec', text: `${o.id} filled → ${o.side.toUpperCase()} ${o.qty} ${o.symbol} @ ${res.fill}` });
    }
  }
  // stops / targets / trailing — evaluated on live price, not bar close, because a
  // stop that only checks at the close is a suggestion.
  for (const p of [...account.positions.values()]) {
    const px = marks[p.symbol];
    if (!Number.isFinite(px)) continue;
    let hit = null;
    if (p.stop != null && (p.side === 'long' ? px <= p.stop : px >= p.stop)) {
      // a ratcheted trail level IS the stop — one code path, two honest labels
      hit = { why: p.trailRatcheted ? 'trailing stop' : 'hard stop', price: p.stop };
    }
    if (!hit && p.take != null) {
      if (p.side === 'long' ? px >= p.take : px <= p.take) hit = { why: 'take profit', price: p.take };
    }
    if (hit) {
      const r = closePosition(p.id, { price: Math.max(hit.price, px) === px ? px : hit.price, reason: hit.why, kind: hit.why });
      events.push({
        level: 'risk',
        text: `${p.symbol} ${p.side} stopped on ${hit.why} · P&L ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}`,
      });
    }
  }
  const eq = equity(marks);
  account.peakEquity = Math.max(account.peakEquity, eq);
  const dayPnl = eq - account.dayStartEquity;
  const limit = -account.risk.dailyLossLimitPct * account.dayStartEquity;
  if (!account.halted && dayPnl <= limit) {
    account.halted = { reason: `daily loss limit ${(account.risk.dailyLossLimitPct * 100).toFixed(1)}% breached`, at: Date.now() };
    for (const p of [...account.positions.values()]) closePosition(p.id, { price: marks[p.symbol], reason: 'risk halt', kind: 'flatten' });
    events.push({ level: 'alert', text: `RISK HALT — ${account.halted.reason}. Positions flattened, automation suspended.` });
  }
  if (events.length || account.positions.size) emit();
  return { equity: eq, dayPnl, positions: [...account.positions.values()] };
}

export function engageKillSwitch(f = 'manual') {
  account.killSwitch = true;
  account.orders = [];
  emit();
  return { ok: true, reason: f };
}

export function releaseKillSwitch() {
  account.killSwitch = false;
  account.halted = null;
  account.dayStartEquity = account.cash;
  emit();
}

export function resetAccount(startingEquity = 250000) {
  account.startingEquity = startingEquity;
  account.cash = startingEquity;
  account.dayStartEquity = startingEquity;
  account.peakEquity = startingEquity;
  account.realisedToday = 0;
  account.feePaid = 0;
  account.positions.clear();
  account.orders = [];
  account.fills = [];
  account.seq = 1;
  account.killSwitch = false;
  account.halted = null;
  emit();
}
