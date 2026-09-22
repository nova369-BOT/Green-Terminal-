/**
 * Backtest engine.
 *
 * Rules this engine obeys, because a strategy that survives here has a chance outside:
 *  1. Signals are evaluated on a CLOSED bar and filled on the NEXT bar's open. Any
 *     engine that fills on the signal bar's close is borrowing from the future.
 *  2. Protective stops are checked intra-bar against the bar's low/high. If both stop
 *     and target sit inside the same bar, the stop is assumed to fill first (pessimistic).
 *  3. Gaps worse than the stop fill at the open, never at the stop price.
 *  4. Fees and slippage are charged on every leg through the same shared sizing core the
 *     live broker uses.
 *  5. Metrics are annualised from the timeframe's real bar count, and robustness is
 *     reported beside performance: Monte Carlo drawdown distribution, anchored
 *     walk-forward, parameter sensitivity. A lone "total return" is marketing.
 */
import { compile, evalRule, warmupFor } from './rule.js';
import { computeSize } from './sizing.js';
import { atr } from './indicators.js';

export const DEFAULT_RISK = { feeBps: 4, slippageBps: 2.5, maxGrossPct: 1.6, maxRiskPct: 0.01 };

/** Bars per year for a timeframe — annualisation denominator (24/7 assumption). */
export function barsPerYear(tfMinutes) {
  return (365 * 24 * 60) / tfMinutes;
}

/**
 * @param {object} strategy  DSL strategy
 * @param {object} dataset   {t,open,high,low,close,volume,len,meta} of CLOSED bars
 * @param {object} opts      {risk, startingEquity, tfMinutes, leverage, range:{from,to}}
 */
export function runBacktest(strategy, dataset, opts = {}) {
  const risk = { ...DEFAULT_RISK, ...(opts.risk ?? {}) };
  const tfMin = opts.tfMinutes ?? dataset.minutes ?? 1;
  const startingEquity = opts.startingEquity ?? 100_000;
  const leverage = opts.leverage ?? 1;

  const n = dataset.len;
  const ctx = compile(dataset, strategy);
  const warm = Math.max(60, warmupFor(strategy.entry).bars, 210);
  const from = Math.max(opts.range?.from ?? warm, warm);
  const to = Math.min(opts.range?.to ?? n, n);
  if (to - from < 10) return { trades: [], curve: new Float64Array(0), curveT: new Float64Array(0), metrics: emptyMetrics(startingEquity), warmup: warm, bars: 0 };

  const entryRules = strategy.entry ?? { op: 'always' };
  const exitRules = strategy.exit ?? null;
  const shortRules = strategy.direction === 'both' ? strategy.entryShort ?? null : null;
  const dir = strategy.direction === 'short' ? 'short' : 'long';
  const exits = strategy.exits ?? {};
  const cooldown = Math.max(0, strategy.cooldownBars ?? 0);
  const stopPct = exits.stopPct ?? null;
  const takePct = exits.takePct ?? null;
  const trailCfg = exits.trail ?? null;
  const timeStop = exits.timeStopBars ?? 0;
  const atrSeries = ctx.series[`atr:${trailCfg?.period ?? 14}`] ?? ctx.series['atr:14'] ?? atr(dataset, 14);

  let equity = startingEquity;
  let peakEquity = startingEquity;
  let maxDD = 0;
  let maxDDLength = 0;
  let ddStart = 0;
  let pos = null;
  let lastExitBar = -Infinity;
  const trades = [];
  const size = to - from;
  const curve = new Float64Array(size);
  const curveT = new Float64Array(size);
  let feesPaid = 0;
  let exposureBars = 0;
  const feeRate = risk.feeBps / 1e4;

  for (let i = from; i < to; i++) {
    const bar = { open: dataset.open[i], high: dataset.high[i], low: dataset.low[i], close: ctx.close[i] };

    if (pos) {
      exposureBars++;
      const d = pos.side === 'long' ? 1 : -1;
      let exit = null;

      // 1) ratchet the volatility trail, then test protective levels intra-bar
      if (trailCfg?.type === 'atr') {
        const a = atrSeries[i];
        if (Number.isFinite(a)) {
          pos.peak = d === 1 ? Math.max(pos.peak, bar.high) : Math.min(pos.peak, bar.low);
          const next = d === 1 ? pos.peak - a * trailCfg.mult : pos.peak + a * trailCfg.mult;
          if (d === 1 ? next > pos.stop : next < pos.stop) pos.stop = next;
        }
      }
      if (pos.stop != null) {
        const hit = d === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
        if (hit) {
          const gapped = d === 1 ? bar.open < pos.stop : bar.open > pos.stop;
          exit = { price: gapped ? bar.open : pos.stop, why: 'stop' };
        }
      }
      if (!exit && pos.take != null) {
        const hit = d === 1 ? bar.high >= pos.take : bar.low <= pos.take;
        if (hit) exit = { price: d === 1 ? Math.max(Math.min(bar.open, bar.high), pos.take) : Math.min(Math.max(bar.open, bar.low), pos.take), why: 'target' };
      }
      // 2) rule exit: signalled on this close, filled at the next open
      if (!exit && exitRules) {
        ctx.varState.barsInPosition = i - pos.entryBar;
        ctx.varState.unrealisedPct = d * (ctx.close[i] / pos.entry - 1);
        if (evalRule(exitRules, ctx, i)) exit = { price: null, why: 'signal', atNextOpen: true };
      }
      // 3) time stop
      if (!exit && timeStop > 0 && i - pos.entryBar >= timeStop) exit = { price: bar.close, why: 'time' };

      if (exit) {
        if (exit.atNextOpen && i + 1 < to) {
          const fillBar = i + 1;
          // mark the SIGNAL bar with the position still open (unrealised included) —
          // skipping this write left a 0.0 hole in the curve, i.e. a phantom -100% bar
          // return, which silently destroyed every return-distribution metric built on it
          const dOpen = pos.side === 'long' ? 1 : -1;
          curve[i - from] = equity + dOpen * (ctx.close[i] - pos.entry) * pos.qty;
          curveT[i - from] = dataset.t[i];
          equity += closeTrade(trades, pos, dataset.open[fillBar], 'signal exit', fillBar, feeRate, dataset);
          feesPaid += pos.entryFee + dataset.open[fillBar] * pos.qty * feeRate;
          pos = null;
          lastExitBar = fillBar;
          i = fillBar;
          curve[i - from] = equity;
          curveT[i - from] = dataset.t[i];
          continue;
        }
        const px = Math.min(Math.max(exit.price, bar.low), bar.high);
        equity += closeTrade(trades, pos, px, exit.why, i, feeRate, dataset);
        feesPaid += pos.entryFee + px * pos.qty * feeRate;
        pos = null;
        lastExitBar = i;
      }
    }

    // mark bar i FIRST, using only state that exists as of this bar's close
    const markNow = pos ? equity + (pos.side === 'long' ? 1 : -1) * (ctx.close[i] - pos.entry) * pos.qty : equity;
    curve[i - from] = markNow;
    curveT[i - from] = dataset.t[i];
    if (markNow > peakEquity) {
      peakEquity = markNow;
      if (ddStart) maxDDLength = Math.max(maxDDLength, i - ddStart);
      ddStart = 0;
    } else if (peakEquity > 0) {
      const dd = 1 - markNow / peakEquity;
      if (dd > maxDD) maxDD = dd;
      if (!ddStart) ddStart = i;
    }

    // entry evaluation happens AFTER the mark: sizing/fee for a fill that occurs at
    // tomorrow's open must not appear on today's equity curve
    if (!pos && i - lastExitBar > cooldown && i + 1 < to) {
      const attempt = (rules, side) => {
        if (!rules || !evalRule(rules, ctx, i)) return false;
        const intended = dataset.open[i + 1];
        const stop = stopFor(strategy, dataset, i, side, atrSeries);
        const sized = computeSize({
          sizing: strategy.sizing,
          equity,
          entry: intended,
          stop,
          meta: dataset.meta,
          risk,
          grossNow: 0,
          leverage,
          side,
        });
        if (!sized.ok) return false;
        const d = side === 'long' ? 1 : -1;
        const fill = intended * (1 + d * (risk.slippageBps / 1e4));
        // RISK INTEGRITY: the stop we size against IS the stop we place. Overwriting an
        // explicit bracket with a wider ATR distance after sizing means the account risks
        // several multiples of the planned amount per trade — the silent killer of
        // otherwise-sound systems.
        const placedStop = stop == null ? null : fill + d * (stop - intended);
        pos = {
          side,
          qty: sized.qty,
          entry: fill,
          stop: placedStop,
          take: takePct ? fill + d * fill * takePct : null,
          peak: fill,
          entryBar: i + 1,
          signalBar: i,
          entryFee: sized.qty * fill * feeRate,
          // 1R is FROZEN at entry: measuring later against a ratcheted trail stop
          // inflates/deflates R and makes expectancy disagree with profit factor
          risk0: placedStop != null ? Math.abs(fill - placedStop) * sized.qty : null,
        };
        equity -= pos.entryFee;
        feesPaid += pos.entryFee;
        return true;
      };
      if (dir === 'short') attempt(shortRules ?? entryRules, 'short');
      else if (!attempt(entryRules, 'long') && shortRules) attempt(shortRules, 'short');
    }

  }

  if (pos) {
    const lastPx = ctx.close[to - 1];
    const open = (pos.side === 'long' ? 1 : -1) * (lastPx - pos.entry) * pos.qty - pos.entryFee - lastPx * pos.qty * feeRate;
    curve[size - 1] = equity + open;
    trades.push({
      side: pos.side,
      qty: pos.qty,
      entry: pos.entry,
      exit: lastPx,
      entryBar: pos.entryBar,
      exitBar: to - 1,
      entryT: dataset.t[pos.entryBar],
      exitT: dataset.t[to - 1],
      bars: to - 1 - pos.entryBar + 1,
      why: 'open at end of window',
      exitWhy: 'open at end of window',
      pnl: open,
      open: true,
      rMultiple: pos.risk0 ? open / Math.max(1e-9, pos.risk0) : 0,
    });
    equity += open;
  }

  const metrics = summarise({
    trades,
    curve,
    curveT,
    startingEquity,
    equity,
    maxDD,
    maxDDLength,
    feesPaid,
    exposureBars,
    bars: size,
    tfMin,
    from,
    to,
    dataset,
  });
  return { trades, curve, curveT, metrics, warmup: warm, bars: size };
}

/**
 * The single source of "where is the stop": explicit bracket wins when present; the ATR
 * trail distance is the fallback for trail-only configs; 2% is the last resort so no
 * position is ever naked. Used for BOTH sizing and placement — one function, one truth.
 */
function stopFor(strategy, dataset, i, side, atrSeries) {
  const px = dataset.close[i];
  const d = side === 'long' ? 1 : -1;
  const exits = strategy.exits ?? {};
  if (exits.stopPct != null && exits.stopPct > 0) return px - d * px * exits.stopPct;
  const a = atrSeries[i];
  if (exits.trail?.type === 'atr' && Number.isFinite(a)) return px - d * a * (exits.trail.mult ?? 2);
  return px - d * px * 0.02;
}

function closeTrade(trades, pos, price, why, bar, feeRate, dataset) {
  const d = pos.side === 'long' ? 1 : -1;
  const exitFee = pos.qty * price * feeRate;
  const gross = d * (price - pos.entry) * pos.qty;
  const pnl = gross - exitFee - pos.entryFee;
  const riskAmt = Math.max(1e-9, pos.risk0 ?? (pos.stop ? Math.abs(pos.entry - pos.stop) * pos.qty : Math.abs(gross)));
  trades.push({
    side: pos.side,
    qty: pos.qty,
    entry: pos.entry,
    exit: price,
    signalBar: pos.signalBar,
    entryBar: pos.entryBar,
    exitBar: bar,
    entryT: dataset.t[pos.entryBar],
    exitT: dataset.t[bar],
    bars: bar - pos.entryBar + 1,
    why,
    gross,
    fees: exitFee + pos.entryFee,
    pnl,
    rMultiple: pnl / riskAmt,
  });
  return pnl;
}

function emptyMetrics(startingEquity) {
  return {
    startingEquity,
    endingEquity: startingEquity,
    netPnl: 0,
    totalReturn: 0,
    cagr: 0,
    sharpe: 0,
    sortino: 0,
    maxDrawdown: 0,
    maxDrawdownBars: 0,
    trades: 0,
    winRate: 0,
    profitFactor: 0,
    expectancyR: 0,
    avgWin: 0,
    avgLoss: 0,
    best: 0,
    worst: 0,
    maxConsecutiveLosses: 0,
    feesPaid: 0,
    exposurePct: 0,
    avgBars: 0,
    buyHold: 0,
    alphaVsHold: 0,
    turnover: 0,
    fromBar: 0,
    toBar: 0,
    years: 0,
  };
}

function summarise({ trades, curve, curveT, startingEquity, equity, maxDD, maxDDLength, feesPaid, exposureBars, bars, tfMin, from, to, dataset }) {
  const bpy = barsPerYear(tfMin);
  const totalReturn = equity / startingEquity - 1;
  const years = Math.max(1e-6, bars / bpy);
  const cagr = years > 0.08 ? Math.pow(Math.max(1e-9, equity / startingEquity), 1 / years) - 1 : totalReturn;

  const rets = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1];
    if (prev > 0) rets.push(curve[i] / prev - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const downside = rets.filter((r) => r < 0);
  const dsd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / (downside.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(bpy) : 0;
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(bpy) : 0;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const expectancyR = trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0;
  const buyHold = dataset.close[from] ? dataset.close[to - 1] / dataset.close[from] - 1 : 0;
  const worst = trades.length ? Math.min(...trades.map((t) => t.pnl)) : 0;
  const best = trades.length ? Math.max(...trades.map((t) => t.pnl)) : 0;
  let streak = 0;
  let maxStreak = 0;
  for (const t of trades) {
    if (t.pnl <= 0) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else streak = 0;
  }
  return {
    startingEquity,
    endingEquity: equity,
    netPnl: equity - startingEquity,
    totalReturn,
    cagr,
    sharpe,
    sortino,
    maxDrawdown: maxDD,
    maxDrawdownBars: maxDDLength,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: pf,
    expectancyR,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    best,
    worst,
    maxConsecutiveLosses: maxStreak,
    feesPaid,
    exposurePct: bars ? exposureBars / bars : 0,
    avgBars: trades.length ? trades.reduce((a, t) => a + t.bars, 0) / trades.length : 0,
    buyHold,
    alphaVsHold: totalReturn - buyHold,
    turnover: trades.length ? trades.reduce((a, t) => a + Math.abs(t.qty * t.entry), 0) / startingEquity / Math.max(years, 0.1) : 0,
    fromBar: from,
    toBar: to,
    firstT: curveT[0],
    lastT: curveT[curveT.length - 1],
    years,
  };
}

/** Resample the trade sequence to expose drawdown luck. Deterministic seed = reproducible. */
export function monteCarlo(trades, { runs = 400, startingEquity = 100_000, seed = 0xba5ed } = {}) {
  if (!trades.length) return null;
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pnls = trades.map((t) => t.pnl);
  const finalEquity = [];
  const drawdowns = [];
  let worstCluster = 0;
  for (let r = 0; r < runs; r++) {
    let eq = startingEquity;
    let peak = eq;
    let dd = 0;
    let cumR = 0;
    let worstR = 0;
    for (let i = 0; i < pnls.length; i++) {
      const pick = pnls[Math.floor(rng() * pnls.length)];
      eq += pick;
      cumR += pick;
      worstR = Math.min(worstR, cumR);
      peak = Math.max(peak, eq);
      dd = Math.max(dd, 1 - eq / peak);
    }
    finalEquity.push(eq);
    drawdowns.push(dd);
    worstCluster = Math.min(worstCluster, worstR);
  }
  const q = (arr, p) => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  return {
    runs,
    medianReturn: q(finalEquity, 0.5) / startingEquity - 1,
    p05Return: q(finalEquity, 0.05) / startingEquity - 1,
    p95Return: q(finalEquity, 0.95) / startingEquity - 1,
    probLoss: finalEquity.filter((e) => e < startingEquity).length / runs,
    ddMedian: q(drawdowns, 0.5),
    ddP95: q(drawdowns, 0.95),
    ddP99: q(drawdowns, 0.99),
    worstClusterUsd: Math.abs(worstCluster),
  };
}

/**
 * Anchored walk-forward with a real (tiny) optimisation step: on each training segment we
 * pick the best value of the strategy's first indicator parameter by expectancy, then apply
 * it out-of-sample. IS→OOS degradation is the overfitting signal — a strategy that collapses
 * here was curve-fitted, whatever the headline return says.
 */
export function walkForward(strategy, dataset, { folds = 4, tfMinutes = 60, paramCandidates = null, risk = DEFAULT_RISK, startingEquity = 100_000 } = {}) {
  const n = dataset.len;
  const warm = Math.max(220, warmupFor(strategy.entry).bars);
  const usable = n - warm;
  if (usable < folds * 60) return { ok: false, msg: `only ${usable} usable bars — not enough history for ${folds} folds on this window` };
  const target = findFirstIndicatorNode(strategy.entry);
  const candidates = paramCandidates ?? (target ? [0.6, 0.8, 1, 1.25, 1.5].map((m) => Math.max(2, Math.round((target.args?.[0] ?? 14) * m))) : [null]);
  const foldSize = Math.floor(usable / (folds + 1));
  const out = [];
  for (let f = 0; f < folds; f++) {
    const trainTo = Math.min(n - 12, warm + foldSize * (f + 1));
    const testTo = Math.min(n, warm + foldSize * (f + 2));
    if (testTo - trainTo < 12 || trainTo - warm < 60) break;
    let best = null;
    for (const c of candidates) {
      const variant = withParam(strategy, target, c);
      const r = runBacktest(variant, dataset, { tfMinutes, risk, startingEquity, range: { from: warm, to: trainTo } });
      // expectancy shrunk by low sample size: an OOS-empty fold cannot win the grid
      const score = r.metrics.trades ? r.metrics.expectancyR * Math.sqrt(Math.min(1, r.metrics.trades / 12)) : -99;
      if (!best || score > best.score) best = { score, param: c, metrics: r.metrics };
    }
    const variant = withParam(strategy, target, best.param);
    const oos = runBacktest(variant, dataset, { tfMinutes, risk, startingEquity, range: { from: trainTo, to: testTo } });
    out.push({
      fold: f + 1,
      trainBars: trainTo - warm,
      testBars: testTo - trainTo,
      trainToT: dataset.t[trainTo],
      testToT: dataset.t[testTo - 1],
      chosenParam: best.param,
      isExpectancy: best.metrics.expectancyR,
      isReturn: best.metrics.totalReturn,
      oosReturn: oos.metrics.totalReturn,
      oosExpectancy: oos.metrics.expectancyR,
      oosTrades: oos.metrics.trades,
      oosMaxDD: oos.metrics.maxDrawdown,
    });
  }
  if (!out.length) return { ok: false, msg: 'no fold had enough bars on both sides of the split' };
  const profitable = out.filter((x) => x.oosReturn > 0).length;
  const isAvg = avg(out.map((x) => x.isExpectancy));
  const oosAvg = avg(out.map((x) => x.oosExpectancy));
  const degradation = isAvg > 1e-6 ? 1 - oosAvg / isAvg : 1;
  return {
    ok: true,
    folds: out,
    oosWinFolds: profitable,
    oosConsistency: profitable / out.length,
    avgOosReturn: avg(out.map((x) => x.oosReturn)),
    avgIsReturn: avg(out.map((x) => x.isReturn)),
    degradation,
    param: target ? `${IND_LABEL(target)} period` : 'none — no tunable parameter found in the entry rule',
    verdict: verdictOf({ oosConsistency: profitable / out.length, degradation }),
  };
}

const IND_LABEL = (t) => t.name.toUpperCase();

function verdictOf({ oosConsistency, degradation }) {
  if (oosConsistency >= 0.75 && degradation < 0.35) return { tone: 'ok', text: 'Stable — OOS expectancy survives the split. Size it small and trade it.' };
  if (oosConsistency >= 0.5) return { tone: 'warn', text: 'Mixed — profitable out-of-sample about half the time. More filters before capital.' };
  return { tone: 'bad', text: 'Overfit signature — in-sample edge does not survive OOS. Do not deploy armed.' };
}

/** Sensitivity of net return to the strategy's tunable parameter. Flat = robust, spiky = noise. */
export function sensitivity(strategy, dataset, { tfMinutes = 60, risk = DEFAULT_RISK, startingEquity = 100_000, multipliers = [0.5, 0.75, 0.9, 1, 1.15, 1.4, 1.8] } = {}) {
  const target = findFirstIndicatorNode(strategy.entry);
  if (!target) return { ok: false, msg: 'no indicator parameter to perturb in the entry rule' };
  const base = target.args?.[0] ?? 14;
  const rows = multipliers
    .map((m) => {
      const p = Math.max(2, Math.round(base * m));
      const r = runBacktest(withParam(strategy, target, p), dataset, { tfMinutes, risk, startingEquity });
      return { mult: m, param: p, trades: r.metrics.trades, returnPct: r.metrics.totalReturn, sharpe: r.metrics.sharpe, expectancyR: r.metrics.expectancyR };
    })
    .filter((x) => Number.isFinite(x.returnPct));
  if (!rows.length) return { ok: false, msg: 'every parameter variant errored' };
  const rets = rows.map((x) => x.returnPct);
  const mu = avg(rets);
  const sd = Math.sqrt(avg(rets.map((r) => (r - mu) ** 2)));
  return {
    ok: true,
    param: target.name,
    baseParam: base,
    rows,
    meanReturn: mu,
    dispersion: Math.abs(mu) < 1e-6 ? Infinity : sd / Math.abs(mu),
    positiveNeighbourhood: rows.filter((x) => x.returnPct > 0).length / rows.length,
  };
}

function findFirstIndicatorNode(node) {
  if (!node) return null;
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    for (const slot of ['left', 'right']) {
      const o = cur[slot];
      if (o?.kind === 'ind' && Array.isArray(o.args) && o.args.length) return o;
    }
    (cur.args ?? []).forEach((c) => stack.push(c));
  }
  return null;
}

function withParam(strategy, target, value) {
  if (!target || value == null) return strategy;
  const clone = structuredClone(strategy);
  const found = findFirstIndicatorNode(clone.entry);
  if (found) found.args = [value, ...(found.args ?? []).slice(1)];
  return clone;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
