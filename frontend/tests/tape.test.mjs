/**
 * Tests for src/lib/tape.ts — TradeTape ring + session stats.
 * Run with:  node --experimental-strip-types tests/tape.test.mjs
 */
import assert from 'node:assert/strict';
import { TradeTape } from '../src/lib/tape.ts';

let passed = 0;
function nearly(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`); }
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; }
}

test('accepts verified prints newest-first, revision bumps', () => {
  const tape = new TradeTape();
  assert.equal(tape.add(1000, 100, 1, 'buy'), true);
  assert.equal(tape.add(2000, 101, 2, 'sell'), true);
  const rows = tape.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].price, 101, 'newest first');
  assert.equal(rows[1].price, 100);
  assert.equal(tape.revision(), 2);
});

test('rejects malformed prints without growing or bumping', () => {
  const tape = new TradeTape();
  assert.equal(tape.add(NaN, 100, 1, 'buy'), false);
  assert.equal(tape.add(1, 0, 1, 'buy'), false, 'price must be > 0');
  assert.equal(tape.add(1, 100, -1, 'buy'), false, 'size must be >= 0');
  assert.equal(tape.add(1, Infinity, 1, 'buy'), false);
  assert.equal(tape.length, 0);
  assert.equal(tape.revision(), 0);
});

test('session stats: open/high/low/last, count, VWAP, side splits', () => {
  const tape = new TradeTape();
  tape.add(1000, 100, 1, 'buy');   // notional 100
  tape.add(2000, 120, 3, 'sell');  // notional 360
  tape.add(3000, 90, 1, null);     // notional 90 (size still counts)
  const s = tape.stats();
  assert.equal(s.count, 3);
  assert.equal(s.open, 100, 'open anchors to the FIRST print');
  assert.equal(s.high, 120);
  assert.equal(s.low, 90);
  assert.equal(s.last, 90);
  nearly(s.vwap, 550 / 5);         // 110
  assert.equal(s.buyVolume, 1);
  assert.equal(s.sellVolume, 3);
});

test('side IS NOT inferred: null side counts in VWAP but not buy/sell splits', () => {
  const tape = new TradeTape();
  tape.add(1000, 100, 2, null);
  const s = tape.stats();
  assert.equal(s.buyVolume, 0);
  assert.equal(s.sellVolume, 0);
  nearly(s.vwap, 100);
});

test('ring eviction at capacity keeps newest; session stats are cumulative', () => {
  const tape = new TradeTape(3);
  for (let i = 1; i <= 5; i += 1) tape.add(i * 1000, i, 1, 'buy');
  assert.equal(tape.length, 3);
  const rows = tape.list();
  assert.deepEqual(rows.map(r => r.price), [5, 4, 3], 'only the 3 newest retained');
  const s = tape.stats();
  assert.equal(s.count, 5, 'stats survive eviction');
  assert.equal(s.open, 1);
  nearly(s.vwap, (1 + 2 + 3 + 4 + 5) / 5);
  assert.equal(s.buyVolume, 5);
});

test('list(limit) clamps to retained rows', () => {
  const tape = new TradeTape();
  for (let i = 1; i <= 4; i += 1) tape.add(i * 1000, i, 1, 'buy');
  assert.equal(tape.list(2).length, 2);
  assert.equal(tape.list(99).length, 4);
  assert.equal(tape.list(0).length, 0);
});

test('clear() resets ring AND stats, bumps revision once', () => {
  const tape = new TradeTape();
  tape.add(1000, 100, 1, 'buy');
  tape.add(2000, 101, 1, 'sell');
  const before = tape.revision();
  tape.clear();
  assert.equal(tape.length, 0);
  assert.deepEqual(tape.stats(), {
    count: 0, vwap: null, buyVolume: 0, sellVolume: 0,
    open: null, high: null, low: null, last: null,
  });
  assert.equal(tape.revision(), before + 1);
});

console.log(`\ntape: ${passed} passed`);
