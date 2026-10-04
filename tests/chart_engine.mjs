// Run: node tests/chart_engine.mjs
// Phase 2 primary engine: normalize / timeframes / transforms.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'frontend/package.json'));
const { build } = require('esbuild');

async function loadEngine() {
  const entry = join(root, 'frontend/src/engine/index.ts');
  const out = await build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'cjs', platform: 'node',
  });
  const mod = { exports: {} };
  new Function('module', 'exports', out.outputFiles[0].text)(mod, mod.exports);
  return mod.exports;
}

const E = await loadEngine();

// --- timeframes ---
assert.equal(E.timeframeSeconds('1m'), 60);
assert.equal(E.timeframeSeconds('5s'), 5);
assert.equal(E.timeframeSeconds('3m'), 180);
assert.equal(E.timeframeSeconds('tick'), 0);
assert.equal(E.timeframeMinutes('1h'), 60);
assert.equal(E.canServeTimeframe('1m', '1h'), false);
assert.equal(E.canServeTimeframe('1h', '1m'), true);
assert.equal(E.canServeTimeframe('5m', '15m'), false);
assert.equal(E.bucketStart(90, '1m'), 60);
assert.equal(E.bucketStart(91, '1s'), 91);

// --- normalize ---
const rows = [
  [1700000000, 10, 12, 9, 11, 100],
  [1700000060, 11, 13, 10, 12, 200],
];
const candles = E.normalizeCandles(rows);
assert.equal(candles.length, 2);
assert.equal(candles[0].time, 1700000000 * 1000); // seconds → ms
assert.equal(candles[0].open, 10);
assert.equal(candles[0].volume, 100);

// inverted high/low repaired
const bad = E.normalizeCandle({ time: 1e12 + 5, open: 5, high: 4, low: 6, close: 5 });
assert.ok(bad.high >= bad.low);

// quote
assert.deepEqual(E.normalizeQuote({ bid: 1, ask: 2 }), { bid: 1, ask: 2, synthetic: false, ts: undefined });

// merge tick new bucket
const t0 = 1700000000;
let series = E.normalizeCandles([[t0, 10, 11, 9, 10, 1]]);
const tick1 = { symbol: 'X', price: 10.5, ts: t0 * 1000 + 1000, volume: 2 };
series = E.mergeTickIntoCandles(series, tick1, '1m', { stepSeconds: 60 });
assert.equal(series.length, 1);
assert.equal(series[0].close, 10.5);
assert.equal(series[0].volume, 3); // 1 + 2
const tick2 = { symbol: 'X', price: 11, ts: (t0 + 60) * 1000, volume: 1 };
series = E.mergeTickIntoCandles(series, tick2, '1m', { stepSeconds: 60 });
assert.equal(series.length, 2);
assert.equal(series[1].open, 11);

// priceChange
assert.deepEqual(E.priceChange(110, 100), { change: 10, changePct: 10 });
assert.deepEqual(E.priceChange(null, 100), { change: null, changePct: null });

// --- transforms ---
const src = [];
for (let i = 0; i < 50; i++) {
  const base = 100 + Math.sin(i / 3) * 5;
  src.push({
    time: (1700000000 + i * 60) * 1000,
    open: base, high: base + 1, low: base - 1, close: base + (i % 2 ? 0.4 : -0.4),
    volume: 10,
  });
}
const ha = E.toHeikinAshi(src);
assert.equal(ha.length, src.length);
assert.equal(ha[0].time, src[0].time);
// HA close is average of OHLC
assert.equal(ha[0].close, (src[0].open + src[0].high + src[0].low + src[0].close) / 4);

const renko = E.toRenko(src, 0.5);
assert.ok(renko.length > 0);
for (const b of renko) {
  assert.ok(Math.abs(b.close - b.open) === 0.5 || Math.abs(b.close - b.open) - 0.5 < 1e-9);
}

assert.equal(E.transformSeries(src, 'candlestick').length, src.length);
assert.equal(E.transformSeries(src, 'heikinAshi')[0].close, ha[0].close);

// orderProviderTimeframes sorts catalog-first
assert.deepEqual(
  E.orderProviderTimeframes(['1h', '1s', 'bogus', '1m']),
  ['1s', '1m', '1h', 'bogus']
);

console.log('chart_engine: all assertions passed');
