/**
 * Automation DSL — the language strategies are written in.
 *
 * Strategies are *declarative JSON*, not user-supplied code. That single decision buys
 * four things that matter at scale: the rule tree is validation-safe (no `eval`, so an
 * imported community strategy can't own your session), it is trivially serializable for
 * storage/sharing/versioning, it renders as human-readable text for the confirm dialog,
 * and it can be evaluated identically in JS (this file) and on a server (mirror this
 * module in Rust/Go) so a backtest and a live fill can never disagree about a signal.
 *
 * Grammar:
 *   rule    = {op:'and'|'or'|'not', args:rule[]} | {op:'>'|'>='|'<'|'<='|'cross_above'|'cross_below'|'between', ...operands}
 *   operand = {kind:'num',value} | {kind:'price',field} | {kind:'ind',name,args,part}
 *           | {kind:'var',name} | {kind:'lag',operand,n}
 */
import { buildIndicatorSet, crossUp, crossDown, INDICATOR_SPECS } from './indicators.js';

// re-exported for the builder UI: one registry, two consumers (engine + editor)
export { INDICATOR_SPECS };

/** Canonical cache key for an indicator series. */
export function indKey(name, args = [], part) {
  const base = part ? `${name}:${args.join(':')}:${part}` : `${name}:${args.join(':')}`;
  return base.replace(/:$/, '');
}

export const CONDITION_OPS = [
  { id: '>', label: '>' },
  { id: '>=', label: '≥' },
  { id: '<', label: '<' },
  { id: '<=', label: '≤' },
  { id: 'cross_above', label: 'crosses above' },
  { id: 'cross_below', label: 'crosses below' },
  { id: 'between', label: 'is between' },
];

export const PRICE_FIELDS = ['close', 'open', 'high', 'low', 'vwap', 'mid'];

export const VARS = [
  { id: 'atr', label: 'ATR (14)', kind: 'price' },
  { id: 'rangePct', label: 'bar range %', kind: 'pct' },
  { id: 'volumeRatio', label: 'volume / 20-bar avg', kind: 'ratio' },
  { id: 'ema200Slope', label: 'EMA200 slope (bps/bar)', kind: 'raw' },
  { id: 'barsInPosition', label: 'bars in position', kind: 'count' },
  { id: 'unrealisedPct', label: 'unrealised %', kind: 'pct' },
];

/** Walk the rule tree collecting every indicator that must be materialised. */
export function collectIndicators(node, acc = new Map()) {
  if (!node || typeof node !== 'object') return acc;
  if (node.op === 'and' || node.op === 'or' || node.op === 'not') {
    for (const child of node.args ?? []) collectIndicators(child, acc);
    return acc;
  }
  for (const slot of [node.left, node.right, node.a, node.b]) {
    if (slot?.kind === 'ind') acc.set(indKey(slot.name, slot.args, slot.part), slot);
    if (slot?.kind === 'lag' && slot.operand?.kind === 'ind') {
      acc.set(indKey(slot.operand.name, slot.operand.args, slot.operand.part), slot.operand);
    }
  }
  return acc;
}

/** Bars of history a rule needs before it produces a trustworthy value. */
export function warmupFor(node, tfMinutes = 1) {
  let maxPeriod = 0;
  for (const spec of collectIndicators(node).values()) {
    const p = Math.max(...(spec.args ?? [0]), 0);
    if (p > maxPeriod) maxPeriod = p;
  }
  // 3x the longest lookback is the standard seeding allowance for Wilder smoothing.
  const bars = Math.ceil(maxPeriod * 3) + 5;
  return { bars, minutes: bars * tfMinutes };
}

/**
 * Build the evaluation context for a dataset: raw OHLCV arrays plus a lazily
 * materialised indicator map. Shared verbatim by the backtester and the live engine.
 */
export function compile(dataset, strategy) {
  const len = dataset.len;
  const close = dataset.close.subarray(0, len);
  const specs = [...collectIndicators(strategy.entry, collectIndicators(strategy.exit)).values()];
  if (needsVwap(strategy)) specs.push({ name: 'vwap', args: [] });
  for (const k of ['200']) specs.push({ name: 'ema', args: [Number(k)] }); // slope var
  for (const k of ['14']) specs.push({ name: 'atr', args: [Number(k)] });
  if (strategy.exits?.trail?.type === 'atr') {
    specs.push({ name: 'atr', args: [strategy.exits.trail.period ?? 14] });
  }
  const series = buildIndicatorSet(
    { high: dataset.high.subarray(0, len), low: dataset.low.subarray(0, len), close, volume: dataset.volume.subarray(0, len), t: dataset.t.subarray(0, len) },
    close,
    specs
  );

  // rolling 20-bar average volume for the participation variable
  let volAvg = null;
  if (usesVar(strategy, 'volumeRatio')) {
    volAvg = new Float64Array(len).fill(NaN);
    for (let i = 20; i < len; i++) {
      let s = 0;
      for (let j = i - 20; j < i; j++) s += dataset.volume[j];
      volAvg[i] = s / 20;
    }
  }
  let ema200Slope = null;
  if (usesVar(strategy, 'ema200Slope')) {
    const e = series['ema:200'];
    ema200Slope = new Float64Array(len).fill(NaN);
    for (let i = 200; i < len; i++) {
      if (Number.isNaN(e[i]) || Number.isNaN(e[i - 5]) || e[i - 5] === 0) continue;
      ema200Slope[i] = ((e[i] / e[i - 5] - 1) * 10000) / 5;
    }
  }

  return {
    len,
    close,
    series,
    volAvg,
    ema200Slope,
    dataset,
    tick: dataset.meta?.tick ?? 0.01,
    varState: {},
    at(i) {
      return {
        close: close[i],
        open: dataset.open[i],
        high: dataset.high[i],
        low: dataset.low[i],
        vwap: series['vwap']?.[i] ?? close[i],
        mid: close[i],
      };
    },
  };
}

function usesVar(strategy, name) {
  const walk = (n) => {
    if (!n || typeof n !== 'object') return false;
    if (n.kind === 'var' && n.name === name) return true;
    if (n.args) for (const c of n.args) if (walk(c)) return true;
    for (const slot of ['left', 'right', 'a', 'b']) if (n[slot] && walk(n[slot])) return true;
    return false;
  };
  return walk(strategy.entry) || walk(strategy.exit);
}

function needsVwap(strategy) {
  const walk = (n) => {
    if (!n || typeof n !== 'object') return false;
    if (n.kind === 'price' && n.field === 'vwap') return true;
    if (n.args) for (const c of n.args) if (walk(c)) return true;
    for (const slot of ['left', 'right', 'a', 'b']) if (n[slot] && walk(n[slot])) return true;
    return false;
  };
  return walk(strategy.entry) || walk(strategy.exit);
}

/** Resolve one operand at bar i. NaN means "not evaluable yet" — callers treat it as false. */
export function operand(node, ctx, i, side = 'close') {
  if (!node) return NaN;
  if (node.kind === 'num') return node.value;
  if (node.kind === 'price') {
    if (node.field === 'vwap') return ctx.series['vwap']?.[i] ?? NaN;
    if (node.field === 'mid') return ctx.close[i];
    const arr = ctx.dataset[node.field] ?? ctx.close;
    return arr[i];
  }
  if (node.kind === 'ind') {
    const key = indKey(node.name, node.args, node.part);
    const s = ctx.series[key];
    if (!s) return NaN;
    const v = s[node.at === 'high' ? i : i];
    return v;
  }
  if (node.kind === 'lag') {
    const n = node.n ?? 1;
    if (i - n < 0) return NaN;
    return operand(node.operand, ctx, i - n, side);
  }
  if (node.kind === 'var') {
    switch (node.name) {
      case 'atr':
        return ctx.series['atr:14']?.[i] ?? NaN;
      case 'rangePct':
        return ctx.dataset.open[i] ? (ctx.dataset.high[i] - ctx.dataset.low[i]) / ctx.dataset.open[i] : NaN;
      case 'volumeRatio':
        return ctx.volAvg?.[i] ? ctx.dataset.volume[i] / ctx.volAvg[i] : NaN;
      case 'ema200Slope':
        return ctx.ema200Slope?.[i] ?? NaN;
      case 'barsInPosition':
        return ctx.varState.barsInPosition ?? 0;
      case 'unrealisedPct':
        return ctx.varState.unrealisedPct ?? 0;
      default:
        return NaN;
    }
  }
  return NaN;
}

/** Evaluate a rule node. `flip` inverts for exit-side semantics reuse. */
export function evalRule(node, ctx, i, opts = {}) {
  if (!node) return false;
  if (node.op === 'always') return true;
  if (node.op === 'never') return false;
  if (node.op === 'and') {
    const args = node.args ?? [];
    if (!args.length) return false;
    for (const c of args) if (!evalRule(c, ctx, i, opts)) return false;
    return true;
  }
  if (node.op === 'or') {
    const args = node.args ?? [];
    if (!args.length) return false;
    for (const c of args) if (evalRule(c, ctx, i, opts)) return true;
    return false;
  }
  if (node.op === 'not') return !evalRule(node.args[0], ctx, i, opts);

  const l = node.left;
  const r = node.right;
  switch (node.op) {
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const a = operand(l, ctx, i);
      const b = operand(r, ctx, i);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (node.op === '>') return a > b;
      if (node.op === '>=') return a >= b;
      if (node.op === '<') return a < b;
      return a <= b;
    }
    case 'cross_above':
    case 'cross_below': {
      if (i < 1) return false;
      const seriesA = (idx) => operand(l, ctx, idx);
      const seriesB = (idx) => operand(r, ctx, idx);
      const a1 = seriesA(i);
      const b1 = seriesB(i);
      const a0 = seriesA(i - 1);
      const b0 = seriesB(i - 1);
      if ([a0, a1, b0, b1].some(Number.isNaN)) return false;
      return node.op === 'cross_above' ? a0 <= b0 && a1 > b1 : a0 >= b0 && a1 < b1;
    }
    case 'between': {
      const v = operand(l, ctx, i);
      const lo = operand(r?.[0], ctx, i);
      const hi = operand(r?.[1], ctx, i);
      if ([v, lo, hi].some(Number.isNaN)) return false;
      return v >= lo && v <= hi;
    }
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * Human-readable rendering — used by strategy cards, the confirm
 * dialog and the audit log. Traders must be able to read what they
 * deployed in one line, or they will deploy the wrong thing.
 * ------------------------------------------------------------------ */

export function operandText(node) {
  if (!node) return '—';
  switch (node.kind) {
    case 'num':
      return String(Number(node.value).toLocaleString('en-US', { maximumFractionDigits: 6 }));
    case 'price':
      return { close: 'Close', open: 'Open', high: 'High', low: 'Low', vwap: 'VWAP', mid: 'Mid' }[node.field] ?? node.field;
    case 'ind': {
      const spec = INDICATOR_SPECS[node.name];
      const label = spec?.label ?? node.name.toUpperCase();
      const args = (node.args ?? []).length ? `(${node.args.join(', ')})` : '';
      const part = node.part ? ` ${node.part}` : '';
      return `${label}${args}${part}`;
    }
    case 'var':
      return VARS.find((v) => v.id === node.name)?.label ?? node.name;
    case 'lag':
      return `${operandText(node.operand)} [${node.n ?? 1} bar${node.n === 1 ? '' : 's'} ago]`;
    default:
      return '—';
  }
}

export function ruleText(node, depth = 0) {
  if (!node) return depth === 0 ? 'no rule' : '';
  if (node.op === 'and' || node.op === 'or') {
    const parts = (node.args ?? []).map((c) => ruleText(c, depth + 1)).filter(Boolean);
    if (!parts.length) return '(empty)';
    const joined = parts.join(depth === 0 ? '  AND  ' : ` ${node.op.toUpperCase()} `);
    return depth === 0 ? joined : `(${joined})`;
  }
  if (node.op === 'not') return `NOT (${ruleText(node.args[0], depth + 1)})`;
  if (node.op === 'between') {
    return `${operandText(node.left)} is between ${operandText(node.right?.[0])} and ${operandText(node.right?.[1])}`;
  }
  if (node.op === 'cross_above' || node.op === 'cross_below') {
    return `${operandText(node.left)} ${node.op === 'cross_above' ? 'crosses above' : 'crosses below'} ${operandText(node.right)}`;
  }
  const glyph = { '>': '>', '>=': '≥', '<': '<', '<=': '≤' }[node.op] ?? node.op;
  return `${operandText(node.left)} ${glyph} ${operandText(node.right)}`;
}

/** Structural validation. Errors are user-facing, so they read like sentences. */
export function validateStrategy(s) {
  const errors = [];
  if (!s.name?.trim()) errors.push('Strategy needs a name.');
  if (!s.symbol) errors.push('Pick an instrument.');
  if (!s.tf) errors.push('Pick a timeframe.');
  const checkNode = (n, where) => {
    if (!n) return;
    if (n.op === 'and' || n.op === 'or') {
      if (!Array.isArray(n.args) || !n.args.length) errors.push(`${where}: ${n.op.toUpperCase()} block has no conditions.`);
      (n.args ?? []).forEach((c) => checkNode(c, where));
      return;
    }
    if (n.op === 'not') {
      checkNode(n.args?.[0], where);
      return;
    }
    if (n.op === 'always' || n.op === 'never') return;
    if (!CONDITION_OPS.some((o) => o.id === n.op)) errors.push(`${where}: unknown operator "${n.op}".`);
    if (n.op === 'between') {
      if (!Array.isArray(n.right) || n.right.length !== 2) errors.push(`${where}: "is between" needs a low and a high.`);
    }
    for (const node of [n.left, n.right]) {
      if (!node) {
        errors.push(`${where}: incomplete comparison — both sides are required.`);
        continue;
      }
      if (node.kind === 'ind') {
        const spec = INDICATOR_SPECS[node.name];
        if (!spec) errors.push(`${where}: unknown indicator "${node.name}".`);
        else {
          const args = node.args ?? [];
          args.forEach((a, idx) => {
            if (!Number.isFinite(a) || a <= 0) errors.push(`${where}: ${spec.label} argument ${idx + 1} must be a positive number.`);
          });
        }
      }
    }
  };
  checkNode(s.entry, 'Entry');
  checkNode(s.exit, 'Exit');
  const e = s.exits ?? {};
  if (e.stopPct != null && (e.stopPct <= 0 || e.stopPct > 0.9)) errors.push('Stop loss must be between 0 and 90%.');
  if (e.takePct != null && (e.takePct <= 0 || e.takePct > 20)) errors.push('Take profit must be between 0 and 2000%.');
  if (e.stopPct && e.takePct && e.takePct / e.stopPct < 0.5) {
    errors.push('Take profit is less than half your stop — negative expectancy by construction.');
  }
  if (!s.sizing || !s.sizing.value || s.sizing.value <= 0) errors.push('Set a position size.');
  if (s.sizing?.mode === 'equityPct' && s.sizing.value > 1) errors.push('Position size as % of equity must be ≤ 100%.');
  if (s.sizing?.mode === 'riskBudget' && s.sizing.value > 0.25) errors.push('Risk per trade above 25% of equity is not risk management, it is gambling.');
  return errors;
}

export function serialize(s) {
  return JSON.stringify(s, null, 2);
}

export function deserialize(json) {
  const obj = JSON.parse(json);
  const errors = validateStrategy(obj);
  return { strategy: obj, errors };
}
