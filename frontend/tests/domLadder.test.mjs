/**
 * Parity tests for domLadder.ts against contract points taken directly from
 * third_party/edgedepth-terminal/src/ui/dom_widget.cpp and trade_at_price.h.
 * Run with:  node --experimental-strip-types tests/domLadder.test.mjs
 * (node ≥ 22; no npm test runner exists in this repo, so this file is plain
 * node with a tiny assert harness).
 */
import assert from 'node:assert/strict';
import {
  TradeAtPriceAccumulator,
  RESET_PRESETS,
  buildLadderModel,
  decimalsForTick,
  deriveTickFromPrices,
  fmtSigned,
  fmtValue,
  formatPrice,
  oceanLuminance,
  oceanRgb,
  priceKey,
  resolveCenterKey,
} from '../src/lib/domLadder.ts';

let passed = 0;
function nearly(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`); }
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; }
}

/* ----------------------------- formatting ----------------------------- */

test('decimalsForTick: 0.01 → 2, 1e-8 → 8, 0.5 → 1, unknown → 8', () => {
  assert.equal(decimalsForTick(0.01), 2);
  assert.equal(decimalsForTick(1e-8), 8);
  assert.equal(decimalsForTick(0.5), 1);
  assert.equal(decimalsForTick(0), 8);
});

test('formatPrice uses tick decimals; null renders empty', () => {
  assert.equal(formatPrice(67451.2, 2), '67451.20');
  assert.equal(formatPrice(null, 2), '');
});

test('fmtValue COIN: K/M/B compaction, small values stay plain', () => {
  assert.equal(fmtValue(0.5, 100, false), '0.5');
  assert.equal(fmtValue(1500, 100, false), '1.5K');
  assert.equal(fmtValue(2_500_000, 100, false), '2.50M');
  assert.equal(fmtValue(1_200_000_000, 1, false), '1.20B');
});

test('fmtValue USD: qty*price then compact, sub-1k whole dollars', () => {
  assert.equal(fmtValue(1, 67450, true), '67.5K');
  assert.equal(fmtValue(0.01, 67450, true), '675');
  assert.equal(fmtValue(30, 40000, true), '1.20M');
});

test('fmtSigned: ± prefix, sign carried by the delta value', () => {
  assert.equal(fmtSigned(500, 100, false), '+500');
  assert.equal(fmtSigned(-1500, 100, false), '-1.5K');
});

/* ---------------------------- tick derivation ---------------------------- */

test('deriveTickFromPrices: venue quoted precision becomes the grid', () => {
  assert.equal(deriveTickFromPrices(['67451.20', '67450.00', '67449.80']), 0.01);
  assert.equal(deriveTickFromPrices(['0.00000012', '0.00000015']), 1e-8);
  assert.equal(deriveTickFromPrices(['12', '13']), 1);
});

test('priceKey: one bucket per tick, float noise cannot split a level', () => {
  assert.equal(priceKey(67451.20, 0.01), priceKey(67451.20 + 1e-12, 0.01));
  assert.notEqual(priceKey(67451.20, 0.01), priceKey(67451.21, 0.01));
});

/* ----------------------------- accumulator ------------------------------ */

test('accumulator: per-level buy/sell, totals, counts, malformed dropped', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  assert.equal(acc.addTrade(100, 1, true), true);
  assert.equal(acc.addTrade(100, 2, false), true);
  assert.equal(acc.addTrade(100, 3, true), true);
  assert.equal(acc.addTrade(-1, 1, true), false);
  assert.equal(acc.addTrade(100, 0, true), false);
  assert.equal(acc.addTrade(NaN, 1, true), false);
  const lvl = acc.get(100);
  assert.equal(lvl.buyVolume, 4);
  assert.equal(lvl.sellVolume, 2);
  assert.equal(lvl.buyCount, 2);
  assert.equal(lvl.sellCount, 1);
  assert.equal(acc.getTotalBuy(), 4);
  assert.equal(acc.getTotalSell(), 2);
  assert.equal(acc.getTotalDelta(), 2);
  assert.equal(acc.getTotalTrades(), 3);
});

test('accumulator revision bumps on trade AND reset (cache invalidation)', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  const r0 = acc.revision();
  acc.addTrade(100, 1, true);
  assert.equal(acc.revision(), r0 + 1);
  acc.reset();
  assert.equal(acc.revision(), r0 + 2);
  assert.equal(acc.getTotalTrades(), 0);
});

test('getBand sums `mult` sub-ticks upward for asks, downward for bids', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  acc.addTrade(100.00, 1, true);
  acc.addTrade(100.01, 2, true);
  acc.addTrade(100.02, 4, false);
  acc.addTrade(99.99, 8, false);
  // Ask band at 100.00 with mult 3 → 100.00 + 100.01 + 100.02
  const askBand = acc.getBand(100.00, true, 3);
  assert.equal(askBand.buyVolume, 3);
  assert.equal(askBand.sellVolume, 4);
  // Bid band at 100.00 with mult 2 → 100.00 + 99.99
  const bidBand = acc.getBand(100.00, false, 2);
  assert.equal(bidBand.buyVolume, 1);
  assert.equal(bidBand.sellVolume, 8);
  // mult 1 is exactly the single-tick lookup (dom_band_size comment)
  const single = acc.getBand(100.01, true, 1);
  assert.equal(single.buyVolume, 2);
});

test('setResetMode periodic wipes and arms the interval; manual never auto-wipes', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  acc.setResetMode('periodic', RESET_PRESETS.FIVE_MIN);
  acc.checkAutoReset(1_000);           // arms window at t=1s
  acc.addTrade(100, 1, true);
  acc.checkAutoReset(1_000 + 100_000); // +100s < 300s
  assert.equal(acc.getTotalBuy(), 1);
  acc.checkAutoReset(1_000 + 300_100); // ≥ 300s elapsed → wipe
  assert.equal(acc.getTotalBuy(), 0);
  acc.setResetMode('manual');
  acc.addTrade(100, 5, true);
  acc.checkAutoReset(1_000 + 900_000_000);
  assert.equal(acc.getTotalBuy(), 5);
});

test('session mode wipes on UTC day boundary only', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  acc.setResetMode('session');
  const day1 = 23 * 3600 * 1000;         // 1970-01-01T23:00Z
  acc.checkAutoReset(day1);
  acc.addTrade(100, 2, true);
  acc.checkAutoReset(day1 + 30 * 60_000); // same day → keep
  assert.equal(acc.getTotalBuy(), 2);
  acc.checkAutoReset(25 * 3600 * 1000);   // next UTC day → wipe
  assert.equal(acc.getTotalBuy(), 0);
});

test('setTickSize re-keys: stale buckets flush, grid changes stick', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  acc.addTrade(100.001, 1, true);
  acc.setTickSize(0.001);
  assert.equal(acc.getTotalTrades(), 0);
  assert.equal(acc.getTick(), 0.001);
  acc.addTrade(100.001, 1, true);
  assert.equal(acc.get(100.001).buyVolume, 1);
});

/* ----------------------------- ladder model ----------------------------- */

function book(entries) {
  const byTick = new Map();
  for (const [price, size] of entries) byTick.set(priceKey(price, 0.01), size);
  return { byTick };
}

test('buildLadderModel: asks high→low, current between, bids best→worst', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  acc.addTrade(100.00, 1, true);
  const model = buildLadderModel({
    bids: book([[99.99, 2], [99.98, 4]]),
    asks: book([[100.01, 1], [100.02, 3]]),
    lastPrice: 100.00,
    centerKey: priceKey(100.00, 0.01),
    scrollOffset: 0,
    groupMult: 1,
    levelsPerSide: 2,
    tick: 0.01,
    decimals: 2,
    displayUsd: false,
    showTradeColumns: true,
    accumulator: acc,
  });
  assert.equal(model.asks.length, 2);
  assert.equal(model.bids.length, 2);
  assert.equal(model.asks[0].priceText, '100.02'); // highest ask on top
  assert.equal(model.asks[1].priceText, '100.01');
  assert.equal(model.bids[0].priceText, '99.99');  // best bid first
  assert.equal(model.current.priceText, '100.00');
  assert.equal(model.asks[0].hasSize, true);
  assert.equal(model.asks[0].depthFrac, 1);        // 3 is the visible max
  nearly(model.bids[0].depthFrac, 2 / 4);
  assert.equal(model.bids[1].depthFrac, 1);
  assert.equal(model.current.hasBuy, true);
  assert.equal(model.current.buyText, '1');
});

test('buildLadderModel: depthFrac normalises against VISIBLE maxima only', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  const model = buildLadderModel({
    bids: book([[99.99, 10], [99.98, 5]]),
    asks: book([[100.01, 20], [100.02, 0]]),
    lastPrice: 100.00,
    centerKey: priceKey(100.00, 0.01),
    scrollOffset: 0, groupMult: 1, levelsPerSide: 2,
    tick: 0.01, decimals: 2, displayUsd: false,
    showTradeColumns: false, accumulator: acc,
  });
  assert.equal(model.asks[1].depthFrac, 1);        // 20 of max 20
  nearly(model.bids[0].depthFrac, 0.5); // 10 of max 20
});

test('grouping ×10 bands sub-ticks into one row (dom_band_size)', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  const asksEntries = [];
  // C++ parity: the band is ANCHORED at its base price (center + n·et with
  // et = tick·mult) and extends upward — first ask band above center 100.00
  // with mult 10 covers 100.10 … 100.19 and is labelled 100.10.
  for (let k = 10; k <= 19; k += 1) asksEntries.push([100 + k * 0.01, 1]);
  const model = buildLadderModel({
    bids: book([]), asks: book(asksEntries),
    lastPrice: 100.00,
    centerKey: priceKey(100.00, 0.01),
    scrollOffset: 0, groupMult: 10, levelsPerSide: 1,
    tick: 0.01, decimals: 2, displayUsd: false,
    showTradeColumns: false, accumulator: acc,
  });
  assert.equal(model.asks.length, 1);
  assert.equal(model.asks[0].hasSize, true);
  assert.equal(model.asks[0].sizeText, '10');
  assert.equal(model.asks[0].priceText, '100.10'); // band base price
});

test('scrollOffset shifts the whole grid quantised to grouped ticks', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  const model = buildLadderModel({
    bids: book([]), asks: book([]),
    lastPrice: 100.00,
    centerKey: priceKey(100.00, 0.01),
    scrollOffset: 3, groupMult: 1, levelsPerSide: 1,
    tick: 0.01, decimals: 2, displayUsd: false,
    showTradeColumns: false, accumulator: acc,
  });
  // C++ parity: adjusted_center = center + scroll·et, so the ENTIRE window
  // translates 3 ticks up — asks[0] = +4 ticks, bids[0] = +2 ticks.
  assert.equal(model.asks[0].priceText, '100.04');
  assert.equal(model.bids[0].priceText, '100.02');
});

test('per-level delta text uses buys−sells with sign color flag', () => {
  const acc = new TradeAtPriceAccumulator(0.01);
  acc.addTrade(100.01, 5, false);
  acc.addTrade(100.01, 2, true);
  const model = buildLadderModel({
    bids: book([]), asks: book([[100.01, 1]]),
    lastPrice: 100.00,
    centerKey: priceKey(100.00, 0.01),
    scrollOffset: 0, groupMult: 1, levelsPerSide: 1,
    tick: 0.01, decimals: 2, displayUsd: false,
    showTradeColumns: true, accumulator: acc,
  });
  assert.equal(model.asks[0].hasDelta, true);
  assert.equal(model.asks[0].deltaPos, false);
  assert.equal(model.asks[0].deltaText, '-3');
});

test('resolveCenterKey: last trade wins; mid-book is the boot fallback', () => {
  assert.equal(resolveCenterKey({ lastPrice: 100.00, bestBid: 99, bestAsk: 101, tick: 0.01 }), 10000);
  assert.equal(resolveCenterKey({ lastPrice: null, bestBid: 99, bestAsk: 101, tick: 0.01 }), 10000);
  assert.equal(resolveCenterKey({ lastPrice: null, bestBid: null, bestAsk: null, tick: 0.01 }), 0);
});

/* ------------------------------ ramp colors ------------------------------ */

test('ocean ramp endpoints match the grove LUT exactly', () => {
  assert.equal(oceanRgb(0), 'rgb(7,16,10)');
  assert.equal(oceanRgb(1), 'rgb(232,212,138)');
});

test('luminance rises monotonically across the ramp (ink-flip threshold 0.45)', () => {
  const stops = [0, 0.2, 0.4, 0.6, 0.8, 1].map(oceanLuminance);
  for (let i = 1; i < stops.length; i += 1) assert.ok(stops[i] > stops[i - 1]);
  assert.ok(oceanLuminance(0) < 0.45 && oceanLuminance(1) > 0.45);
});

console.log(`\n${passed} tests passed`);
