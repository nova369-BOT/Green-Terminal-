/**
 * Dev-only: calibrate preset parameters against the bundled simulator.
 * Not shipped logic — a scratch harness so the library presets land in a plausible
 * performance band on the demo data instead of looking broken to a first-time user.
 *
 * Guardrails against degenerate overfitting:
 *  - require ≥ (15|25) trades and maxDD ≤ 35%
 *  - score = expectancy(R) shrunk by sqrt(min(1, trades/30)) — rewards sample size
 *  - modest grids: only knobs a trader would actually touch
 * Run: node scripts/calibrate.js
 */
import { bars } from '../src/modules/feed.js';
import { PRESETS, fromPreset } from '../src/modules/presets.js';
import { runBacktest } from '../src/modules/backtest.js';

const risk = { feeBps: 4, slippageBps: 2.5, maxGrossPct: 1.6, maxRiskPct: 0.01 };
const tfm = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1D': 1440 };
const dsCache = new Map();
function dsFor(sym, tf) {
  const k = `${sym}:${tf}`;
  if (!dsCache.has(k)) dsCache.set(k, bars(sym, tf));
  return dsCache.get(k);
}

function score(m, trades) {
  if (trades < 15) return -99;
  if (m.maxDrawdown > 0.35) return -99;
  return m.expectancyR * Math.sqrt(Math.min(1, trades / 30));
}

function evalVariant(presetKey, mutate, label) {
  const base = PRESETS.find((p) => p.key === presetKey);
  const s = fromPreset(base);
  mutate(s);
  const errs = [];
  if (!(s.exits?.stopPct > 0) && !(s.exits?.trail?.mult > 0)) errs.push('no stop');
  if (errs.length) return null;
  const ds = dsFor(s.symbol, s.tf);
  const r = runBacktest(s, ds, { tfMinutes: tfm[s.tf], startingEquity: 100000, risk });
  const m = r.metrics;
  return { label, m, trades: m.trades, score: score(m, m.trades), exits: structuredClone(s.exits), cooldown: s.cooldownBars, entryLogic: s.entry, exitRule: s.exit };
}

const GRIDS = {
  'trend-rider': () => {
    const out = [];
    for (const stopPct of [0.02, 0.028, 0.036, 0.045, 0.055])
      for (const trailMult of [0, 2.2, 3.0, 3.8])
        for (const rsiLo of [48, 54, 58])
          for (const rsiHi of [68, 74])
            for (const cooldown of [2, 6])
              out.push([
                `stop ${(stopPct * 100).toFixed(1)} trail ${trailMult || 'off'} rsi(${rsiLo},${rsiHi}) cd${cooldown}`,
                (s) => {
                  s.exits = { stopPct, takePct: s.exits.takePct, trail: trailMult ? { type: 'atr', period: 14, mult: trailMult } : null };
                  s.cooldownBars = cooldown;
                  // rewrite rsi window inside the entry rule (it's args[2] and args[3])
                  const args = s.entry.args;
                  args[2] = { op: '>', left: args[2].left, right: { kind: 'num', value: rsiLo } };
                  args[3] = { op: '<', left: args[3].left, right: { kind: 'num', value: rsiHi } };
                },
              ]);
    return out;
  },
  'fade-stretch': () => {
    const out = [];
    for (const stopPct of [0.015, 0.022, 0.03, 0.04])
      for (const takePct of [0.02, 0.03, 0.045, 0.06])
        for (const rsiTh of [26, 30, 34])
          for (const vol of [1.0, 1.1, 1.3])
            out.push([
              `stop ${(stopPct * 100).toFixed(1)} take ${(takePct * 100).toFixed(1)} rsi<${rsiTh} vol>${vol}`,
              (s) => {
                s.exits = { stopPct, takePct, timeStopBars: s.exits.timeStopBars };
                s.entry.args[0] = { op: '<', left: s.entry.args[0].left, right: { kind: 'num', value: rsiTh } };
                s.entry.args[2] = { op: '>', left: s.entry.args[2].left, right: { kind: 'num', value: vol } };
              },
            ]);
    return out;
  },
  'box-breakout': () => {
    const out = [];
    for (const stopPct of [0.02, 0.03, 0.04])
      for (const trailMult of [2.4, 3.2, 4.0])
        for (const vol of [1.1, 1.3, 1.6])
          for (const rangeMin of [0.0015, 0.0025])
            out.push([
              `stop ${(stopPct * 100).toFixed(1)} trail ${trailMult} vol>${vol} rng>${rangeMin}`,
              (s) => {
                s.exits = { stopPct, takePct: null, trail: { type: 'atr', period: 14, mult: trailMult } };
                s.entry.args[1] = { op: '>', left: s.entry.args[1].left, right: { kind: 'num', value: vol } };
                s.entry.args[2] = { op: '>', left: s.entry.args[2].left, right: { kind: 'num', value: rangeMin } };
                if (s.entryShort?.args?.[1]) s.entryShort.args[1] = { op: '>', left: s.entryShort.args[1].left, right: { kind: 'num', value: vol } };
              },
            ]);
    return out;
  },
  'macd-pulse': () => {
    const out = [];
    for (const stopPct of [0.006, 0.009, 0.013, 0.018])
      for (const takePct of [0.012, 0.02, 0.03, 0.045])
      for (const rsiGate of [62, 68, 75])
        for (const needVwap of [true, false])
          for (const cooldown of [1, 4])
            out.push([
              `stop ${(stopPct * 100).toFixed(1)} take ${(takePct * 100).toFixed(1)} rsi<${rsiGate} vwapGate=${needVwap} cd${cooldown}`,
              (s) => {
                s.exits = { stopPct, takePct, timeStopBars: s.exits.timeStopBars };
                s.cooldownBars = cooldown;
                s.entry.args[1] = needVwap ? s.entry.args[1] : { op: 'always' };
                s.entry.args[2] = { op: '<', left: s.entry.args[2].left, right: { kind: 'num', value: rsiGate } };
              },
            ]);
    return out;
  },
  'dip-accum': () => {
    const out = [];
    for (const stopPct of [0.05, 0.07, 0.1])
      for (const takePct of [0.08, 0.12, 0.18])
        for (const rsiTh of [30, 35, 40])
          out.push([
            `stop ${(stopPct * 100).toFixed(0)} take ${(takePct * 100).toFixed(0)} rsi<${rsiTh}`,
            (s) => {
              s.exits = { stopPct, takePct };
              s.entry.args[0] = { op: '<', left: s.entry.args[0].left, right: { kind: 'num', value: rsiTh } };
            },
          ]);
    return out;
  },
  'opening-range': () => {
    const out = [];
    for (const stopPct of [0.008, 0.012, 0.018, 0.026])
      for (const takePct of [0.018, 0.03, 0.045])
        for (const slopeMin of [0.5, 1.5, 3])
          for (const rocMin of [0.0, 0.05, 0.15])
            out.push([
              `stop ${(stopPct * 100).toFixed(1)} take ${(takePct * 100).toFixed(1)} slope>${slopeMin} roc>${rocMin}`,
              (s) => {
                s.exits = { stopPct, takePct, timeStopBars: s.exits.timeStopBars };
                s.entry.args[1] = { op: '>', left: s.entry.args[1].left, right: { kind: 'num', value: slopeMin } };
                s.entry.args[2] = { op: '>=', left: s.entry.args[2].left, right: { kind: 'num', value: rocMin } };
              },
            ]);
    return out;
  },
};

for (const [key, gridFn] of Object.entries(GRIDS)) {
  const grid = gridFn();
  let best = null;
  let n = 0;
  for (const [label, mutate] of grid) {
    const r = evalVariant(key, mutate, label);
    if (!r) continue;
    n++;
    if (!best || r.score > best.score) best = r;
  }
  if (!best) {
    console.log(`\n${key}: NO VALID VARIANT among ${n}`);
    continue;
  }
  const m = best.m;
  console.log(
    `\n${key}  (tried ${n})\n  best: ${best.label}\n  → ret ${(m.totalReturn * 100).toFixed(1)}%  trades ${m.trades}  pf ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}  expR ${m.expectancyR.toFixed(3)}  dd ${(m.maxDrawdown * 100).toFixed(1)}%  sharpe ${m.sharpe.toFixed(2)}  score ${best.score.toFixed(4)}`
  );
  console.log(`  exits: ${JSON.stringify(best.exits)}  cooldown: ${best.cooldown}`);
}
