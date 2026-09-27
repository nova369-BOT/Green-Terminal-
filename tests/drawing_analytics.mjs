import assert from 'node:assert/strict';
import {
  calculateLinearRegression,
  calculateVolumeProfile,
} from '../frontend/src/components/chart/drawingAnalytics.ts';

const candles = [
  { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { time: 2, open: 11, high: 13, low: 10, close: 12, volume: 120 },
  { time: 3, open: 12, high: 14, low: 11, close: 13, volume: 140 },
  { time: 4, open: 13, high: 15, low: 12, close: 14, volume: 160 },
];

const profile = calculateVolumeProfile(candles, 1, 4, { rows: 12, valueAreaPercent: 70 });
assert.ok(profile, 'profile should be calculated when real volume exists');
assert.equal(profile.rows, 12);
assert.equal(profile.upVolume.length, 12);
assert.equal(profile.downVolume.length, 12);
assert.ok(profile.pocIndex >= 0 && profile.pocIndex < profile.rows);
assert.ok(profile.valueAreaLowIndex <= profile.pocIndex);
assert.ok(profile.valueAreaHighIndex >= profile.pocIndex);
assert.ok(Math.abs(profile.totalVolume - 520) < 1e-9, 'distributed volume must be conserved');

const clampedProfile = calculateVolumeProfile(candles, 4, 1, { rows: 2, valueAreaPercent: 500 });
assert.ok(clampedProfile);
assert.equal(clampedProfile.rows, 8, 'row count must respect the supported minimum');
assert.equal(clampedProfile.valueAreaLowIndex, 0, '100% value area must include the first row');
assert.equal(clampedProfile.valueAreaHighIndex, 7, '100% value area must include the final row');

assert.equal(
  calculateVolumeProfile(candles.map((candle) => ({ ...candle, volume: 0 })), 1, 4),
  null,
  'missing volume must not be replaced with fake profile data',
);
assert.equal(calculateVolumeProfile(candles, 20, 30), null, 'empty ranges must remain empty');

const regression = calculateLinearRegression(candles, 1, 4);
assert.ok(regression);
assert.ok(Math.abs(regression.slopePerBar - 1) < 1e-12);
assert.ok(Math.abs(regression.intercept - 11) < 1e-12);
assert.ok(Math.abs(regression.rSquared - 1) < 1e-12);
assert.ok(Math.abs(regression.standardDeviation) < 1e-12);
assert.deepEqual(regression.center.map((point) => point.value), [11, 12, 13, 14]);

const noisyRegression = calculateLinearRegression([
  { time: 1, open: 1, high: 2, low: 0, close: 1, volume: 1 },
  { time: 2, open: 3, high: 4, low: 2, close: 3, volume: 1 },
  { time: 3, open: 2, high: 3, low: 1, close: 2, volume: 1 },
], 1, 3);
assert.ok(noisyRegression);
assert.ok(noisyRegression.rSquared >= 0 && noisyRegression.rSquared <= 1);
assert.ok(noisyRegression.standardDeviation > 0);
assert.equal(calculateLinearRegression(candles, 1, 1), null, 'regression requires at least two bars');

console.log('drawing analytics assertions passed');
