/**
 * Unit tests for the per-channel venue health model (src/lib/venueHealth.ts).
 * Run with:  node --experimental-strip-types tests/venueHealth.test.mjs
 *
 * Motivating incident: trades streamed fine on Binance while the depth
 * snapshot never landed; because trades refreshed the shared keepalive the
 * DOM painted 'Syncing' forever instead of failing over to Hyperliquid.
 * Health is now keyed per channel; these tests lock that behaviour down.
 */
import assert from 'node:assert/strict';
import {
  recordVenueEvent,
  queryVenueDown,
  resetVenueHealthForTests,
  subscribeVenueHealth,
  getVenueHealthVersion,
  DATA_DOWN_MS,
  RESET_FRESH_MS,
  NEVER_DATA_GRACE_MS,
  NEVER_DOWN_PROBE_MS,
} from '../src/lib/venueHealth.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}`); console.error(e); process.exitCode = 1; }
}

test('fresh reset with no data marks the channel down', () => {
  resetVenueHealthForTests();
  const t0 = 1_000_000;
  recordVenueEvent('binance', 'reset', 'depth snapshot fetch hung', 'depth', t0);
  const v = queryVenueDown('binance', 'depth', t0 + 1);
  assert.equal(v.down, true);
  assert.match(v.reason, /hung/);
});

test('one channel alive paints the OTHER channel as down, not healthy', () => {
  resetVenueHealthForTests();
  /* The exact user-visible bug: trades keep landing so the shared clock
   * looked healthy and the DOM never failed over. */
  const t0 = 1_000_000;
  recordVenueEvent('binance', 'data', undefined, 'trades', t0);
  const depthVerdict = queryVenueDown('binance', 'depth', t0 + 1);
  assert.equal(depthVerdict.down, false, 'no health record at all yet → untouched verdict');
  recordVenueEvent('binance', 'subscribe', undefined, 'depth', t0);
  recordVenueEvent('binance', 'data', undefined, 'trades', t0 + 25_000);
  const v = queryVenueDown('binance', 'depth', t0 + 25_001);
  assert.equal(v.down, true, 'depth never delivered → down despite live trades');
  assert.match(v.reason, /ever delivered/);
  const t = queryVenueDown('binance', 'trades', t0 + 25_001);
  assert.equal(t.down, false, 'trades channel itself stays UP');
});

test('data arrival clears the down verdict', () => {
  resetVenueHealthForTests();
  const t0 = 1_000_000;
  recordVenueEvent('binance', 'reset', 'stale sequence', 'depth', t0);
  assert.equal(queryVenueDown('binance', 'depth', t0 + 5).down, true);
  recordVenueEvent('binance', 'data', undefined, 'depth', t0 + 6);
  assert.equal(queryVenueDown('binance', 'depth', t0 + 7).down, false);
});

test('stale reset outside the freshness window stops mattering', () => {
  resetVenueHealthForTests();
  const t0 = 1_000_000;
  recordVenueEvent('binance', 'data', undefined, 'depth', t0);
  recordVenueEvent('binance', 'reset', 'reconnect', 'depth', t0 + 1);
  // Go quiet: both reset AND data age out of their windows.
  const verdict = queryVenueDown('binance', 'depth', t0 + RESET_FRESH_MS + DATA_DOWN_MS + 10_000);
  assert.equal(verdict.down, false);
});

test('never-delivered verdict expires so the panel re-probes the venue', () => {
  resetVenueHealthForTests();
  const t0 = 1_000_000;
  recordVenueEvent('binance', 'subscribe', undefined, 'depth', t0);
  assert.equal(queryVenueDown('binance', 'depth', t0 + NEVER_DATA_GRACE_MS - 1).down, false, 'still inside grace');
  assert.equal(queryVenueDown('binance', 'depth', t0 + NEVER_DATA_GRACE_MS + 1).down, true, 'grace expired → down');
  assert.equal(
    queryVenueDown('binance', 'depth', t0 + NEVER_DATA_GRACE_MS + NEVER_DOWN_PROBE_MS + 1).down,
    false,
    'probe window elapsed → not-down so useAdaptiveFlowSource swaps back and re-subscribes',
  );
});

test('subscribe re-arms the grace clock only while undelivered', () => {
  resetVenueHealthForTests();
  const t0 = 1_000_000;
  recordVenueEvent('binance', 'subscribe', undefined, 'depth', t0);
  recordVenueEvent('binance', 'subscribe', undefined, 'depth', t0 + NEVER_DATA_GRACE_MS - 5);
  assert.equal(
    queryVenueDown('binance', 'depth', t0 + NEVER_DATA_GRACE_MS + 5).down,
    false,
    'second subscribe reset the grace — only 5ns past new subscribe',
  );
});

test('subscription to one channel never creates health for the other', () => {
  resetVenueHealthForTests();
  const t0 = 1_000_000;
  recordVenueEvent('hyperliquid', 'subscribe', undefined, 'trades', t0);
  assert.equal(queryVenueDown('hyperliquid', 'depth', t0 + NEVER_DATA_GRACE_MS + 1).down, false);
});

test('providers are isolated from each other', () => {
  resetVenueHealthForTests();
  const t0 = 1_000_000;
  recordVenueEvent('binance', 'reset', 'hung', 'depth', t0);
  assert.equal(queryVenueDown('hyperliquid', 'depth', t0 + 1).down, false);
});

test('listeners fire and version increments on every event', () => {
  resetVenueHealthForTests();
  let fired = 0;
  const off = subscribeVenueHealth(() => { fired += 1; });
  const v0 = getVenueHealthVersion();
  recordVenueEvent('binance', 'subscribe', undefined, 'trades');
  recordVenueEvent('binance', 'reset', 'x', 'trades');
  recordVenueEvent('binance', 'data', undefined, 'trades');
  assert.equal(fired, 3);
  assert.equal(getVenueHealthVersion(), v0 + 3);
  off();
  recordVenueEvent('binance', 'data', undefined, 'trades');
  assert.equal(fired, 3, 'listener removed');
});

console.log(`\nvenueHealth: ${passed} passed`);
