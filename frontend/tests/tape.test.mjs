/**
 * Parity tests for tape.ts against contract points taken directly from
 * third_party/edgedepth-terminal/src/ui/trades_widget.cpp.
 * Run with:  node --experimental-strip-types tests/tape.test.mjs
 */
import assert from 'node:assert/strict';
import {
  BIG_PRINT_FACTOR,
  MAX_TRADES,
  TradeTape,
  fmtQty,
  fmtTimeSeconds,
} from '../src/lib/tape.ts';

let passed = 0;
function nearly(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`); }
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; }
}

test('MAX_TRADES is 64 like the original ring', () => assert.equal(MAX_TRADES, 64));

test('fmtQty strips trailing zeros ("%g"-style venue precision)', () => {
  assert.equal(fmtQty(0.004), '0.004');
  assert.equal(fmtQty(12), '12');
  assert.equal(fmtQty(1.5), '1.5');
  assert.equal(fmtQty(0.00000100), '0.000001');
});

test('fmtTimeSeconds renders HH:MM:SS local wall clock', () => {
  const d = new Date(2026, 9, 1, 13, 5, 9);
  assert.equal(fmtTimeSeconds(d.getTime()), '13:05:09');
});

test('malformed prints are dropped (on_trade guard)', () => {
  const tape = new TradeTape();
  assert.equal(tape.add(1000, 0, 1, true), null);
  assert.equal(tape.add(1000, 100, 0, true), null);
  assert.equal(tape.add(0, 100, 1, true), null);
  assert.equal(tape.add(1000, NaN, 1, true), null);
  assert.equal(tape.add(1000, 100, Infinity, true), null);
  assert.equal(tape.size(), 0);
});

test('rows are formatted ONCE at insert (immutable RowText)', () => {
  const tape = new TradeTape();
  tape.setPriceDecimals(2);
  const a = tape.add(1000, 67451.2, 0.5, true);
  assert.equal(a.priceText, '67451.20');
  // Later change of instrument precision must NOT reformat earlier rows.
  tape.setPriceDecimals(8);
  const b = tape.add(2000, 0.00000012, 3, false);
  assert.equal(b.priceText, '0.00000012');
  assert.equal(tape.list()[1].priceText, '67451.20');
});

test('list is newest-first, ring caps at 64 with oldest evicted', () => {
  const tape = new TradeTape();
  for (let i = 1; i <= 70; i += 1) tape.add(i * 1000, 100 + i, 1, true);
  const list = tape.list();
  assert.equal(list.length, MAX_TRADES);
  assert.equal(list[0].price, 170);   // newest first
  assert.equal(list.at(-1).price, 107); // 64th newest; prints 100..106 evicted
  assert.equal(tape.totalSeen(), 70);
});

test('big-print flag: first print seeds the EMA, >8× EMA flags (slow alpha)', () => {
  const tape = new TradeTape();
  // Feed a stable baseline of 1.0 prints so the EMA settles near 1.0.
  for (let i = 1; i <= 40; i += 1) {
    const p = tape.add(i * 1000, 100, 1, true);
    assert.equal(p.big, i <= 1 ? false : tape.getQtyEma() * BIG_PRINT_FACTOR < 1);
  }
  const spike = tape.add(99_000, 100, 20, true); // 20 ≫ ema≈1 × 8
  assert.equal(spike.big, true);
  const after = tape.add(100_000, 100, 1, false);
  assert.equal(after.big, false);
});

test('statistics: 60s window buy/sell volumes, pressure, prints/sec', () => {
  const tape = new TradeTape();
  const now = 600_000;
  tape.add(now - 70_000, 100, 5, true);   // outside window — excluded
  tape.add(now - 40_000, 100, 3, true);
  tape.add(now - 10_000, 100, 1, false);
  tape.add(now - 5_000, 100, 1, false);
  const s = tape.statistics(now);
  assert.equal(s.volumeBuy1m, 3);
  assert.equal(s.volumeSell1m, 2);
  nearly(s.buyPressure, 3 / 5, 1e-9);
  nearly(s.tradesPerSecond, 3 / 60, 1e-9);
  const empty = new TradeTape().statistics(now);
  assert.equal(empty.buyPressure, 0.5);   // neutral on silence
});

test('session(): open/high/low since attach, VWAP, CVD, printed counts', () => {
  const tape = new TradeTape();
  tape.add(1000, 100, 2, true);
  tape.add(2000, 102, 1, true);
  tape.add(3000, 99, 3, false);
  const s = tape.session();
  assert.equal(s.open, 100);
  assert.equal(s.high, 102);
  assert.equal(s.low, 99);
  assert.equal(s.lastPrice, 99);
  assert.equal(s.volume, 6);
  assert.equal(s.volumeBuy, 3);
  assert.equal(s.volumeSell, 3);
  assert.equal(s.cvd, 0);
  // VWAP = (100·2 + 102·1 + 99·3) / 6
  const expected = (100 * 2 + 102 + 99 * 3) / 6;
  nearly(s.vwap, expected);
  assert.equal(s.prints, 3);
  const fresh = new TradeTape().session();
  assert.equal(fresh.vwap, null);
  assert.equal(fresh.high, null);
  assert.equal(fresh.open, null);
});

test('indicators(): returns nulls until the window is FULL — no partials', () => {
  const tape = new TradeTape();
  assert.equal(tape.indicators(20).sma, null);
  assert.equal(tape.indicators(20).rsi, null);
  for (let i = 1; i <= 20; i += 1) tape.add(i * 1000, 100 + i, 1, true);
  const ind = tape.indicators(20);
  // Prices 101..120: SMA = (101+120)/2 = 110.5
  nearly(ind.sma, 110.5);
  assert.ok(ind.ema != null && ind.ema > 109 && ind.ema < 112);
  // Monotone up: RSI = 100 (no down moves → avgLoss 0)
  assert.equal(ind.rsi, 100);
  assert.equal(ind.window, 20);
});

test('indicators(): RSI flat market = 50, alternating = balanced', () => {
  const flat = new TradeTape();
  for (let i = 1; i <= 20; i += 1) flat.add(i * 1000, 100, 1, true);
  assert.equal(flat.indicators(20).rsi, 50);
  const alt = new TradeTape();
  for (let i = 1; i <= 20; i += 1) alt.add(i * 1000, i % 2 === 0 ? 101 : 100, 1, true);
  const rsi = alt.indicators(20).rsi;
  assert.ok(rsi > 45 && rsi < 55, `expected balanced RSI, got ${rsi}`);
});

test('clear() also flushes session aggregates', () => {
  const tape = new TradeTape();
  tape.add(1000, 100, 2, true);
  tape.clear();
  const s = tape.session();
  assert.equal(s.open, null);
  assert.equal(s.volume, 0);
  assert.equal(s.vwap, null);
});

test('revision bumps per accepted print and on clear', () => {
  const tape = new TradeTape();
  const r0 = tape.revision();
  tape.add(1000, 100, 1, true);
  assert.equal(tape.revision(), r0 + 1);
  tape.clear();
  assert.equal(tape.revision(), r0 + 2);
  assert.equal(tape.size(), 0);
});

console.log(`\n${passed} tests passed`);
