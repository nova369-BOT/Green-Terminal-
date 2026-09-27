export type AnalyticsCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type VolumeProfileOptions = {
  rows?: number;
  valueAreaPercent?: number;
};

export type VolumeProfileResult = {
  rows: number;
  rowHeight: number;
  upVolume: number[];
  downVolume: number[];
  totalByRow: number[];
  priceLow: number;
  priceHigh: number;
  maxVolume: number;
  totalVolume: number;
  pocIndex: number;
  valueAreaLowIndex: number;
  valueAreaHighIndex: number;
};

export type RegressionPoint = {
  time: number;
  value: number;
};

export type RegressionResult = {
  center: RegressionPoint[];
  upperOne: RegressionPoint[];
  lowerOne: RegressionPoint[];
  upperTwo: RegressionPoint[];
  lowerTwo: RegressionPoint[];
  slopePerBar: number;
  intercept: number;
  standardDeviation: number;
  rSquared: number;
};

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value as number)));
};

const clampNumber = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value as number));
};

const candlesInRange = (candles: AnalyticsCandle[], firstTime: number, secondTime: number): AnalyticsCandle[] => {
  const lowTime = Math.min(firstTime, secondTime);
  const highTime = Math.max(firstTime, secondTime);
  return candles.filter((candle) => (
    Number.isFinite(candle.time)
    && Number.isFinite(candle.open)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close)
    && candle.time >= lowTime
    && candle.time <= highTime
  ));
};

/**
 * Builds a candle-based volume profile for a selected time range.
 *
 * Each candle's volume is distributed uniformly across every price row touched
 * by its high-low range. Up/down attribution follows candle direction. This is
 * deterministic and honest about the available OHLCV resolution; it does not
 * pretend candle data contains tick-level volume-at-price information.
 */
export const calculateVolumeProfile = (
  candles: AnalyticsCandle[],
  firstTime: number,
  secondTime: number,
  options: VolumeProfileOptions = {},
): VolumeProfileResult | null => {
  const window = candlesInRange(candles, firstTime, secondTime);
  if (window.length === 0) return null;

  const rows = clampInteger(options.rows, 24, 8, 200);
  const valueAreaPercent = clampNumber(options.valueAreaPercent, 70, 1, 100);
  let priceLow = Infinity;
  let priceHigh = -Infinity;

  for (const candle of window) {
    priceLow = Math.min(priceLow, candle.low);
    priceHigh = Math.max(priceHigh, candle.high);
  }
  if (!Number.isFinite(priceLow) || !Number.isFinite(priceHigh) || priceHigh <= priceLow) return null;

  const rowHeight = (priceHigh - priceLow) / rows;
  const upVolume = new Array<number>(rows).fill(0);
  const downVolume = new Array<number>(rows).fill(0);

  for (const candle of window) {
    const volume = candle.volume ?? 0;
    if (!Number.isFinite(volume) || volume <= 0) continue;

    const firstRow = Math.max(0, Math.min(rows - 1, Math.floor((candle.low - priceLow) / rowHeight)));
    const lastRow = Math.max(0, Math.min(rows - 1, Math.floor((candle.high - priceLow) / rowHeight)));
    const touchedRows = Math.max(1, lastRow - firstRow + 1);
    const volumePerRow = volume / touchedRows;
    const target = candle.close >= candle.open ? upVolume : downVolume;

    for (let row = firstRow; row <= lastRow; row += 1) target[row] += volumePerRow;
  }

  const totalByRow = upVolume.map((up, index) => up + downVolume[index]);
  const totalVolume = totalByRow.reduce((sum, volume) => sum + volume, 0);
  if (totalVolume <= 0) return null;

  const maxVolume = Math.max(...totalByRow);
  let pocIndex = 0;
  for (let row = 1; row < rows; row += 1) {
    if (totalByRow[row] > totalByRow[pocIndex]) pocIndex = row;
  }

  let valueAreaLowIndex = pocIndex;
  let valueAreaHighIndex = pocIndex;
  let accumulatedVolume = totalByRow[pocIndex];
  const targetVolume = totalVolume * (valueAreaPercent / 100);

  while (accumulatedVolume < targetVolume && (valueAreaLowIndex > 0 || valueAreaHighIndex < rows - 1)) {
    const below = valueAreaLowIndex > 0 ? totalByRow[valueAreaLowIndex - 1] : -1;
    const above = valueAreaHighIndex < rows - 1 ? totalByRow[valueAreaHighIndex + 1] : -1;
    if (above >= below) {
      valueAreaHighIndex += 1;
      accumulatedVolume += totalByRow[valueAreaHighIndex];
    } else {
      valueAreaLowIndex -= 1;
      accumulatedVolume += totalByRow[valueAreaLowIndex];
    }
  }

  return {
    rows,
    rowHeight,
    upVolume,
    downVolume,
    totalByRow,
    priceLow,
    priceHigh,
    maxVolume,
    totalVolume,
    pocIndex,
    valueAreaLowIndex,
    valueAreaHighIndex,
  };
};

/** Calculates an ordinary least-squares regression of candle closes by bar index. */
export const calculateLinearRegression = (
  candles: AnalyticsCandle[],
  firstTime: number,
  secondTime: number,
): RegressionResult | null => {
  const window = candlesInRange(candles, firstTime, secondTime);
  if (window.length < 2) return null;

  const count = window.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;

  for (let index = 0; index < count; index += 1) {
    const close = window[index].close;
    sumX += index;
    sumY += close;
    sumXY += index * close;
    sumXX += index * index;
    sumYY += close * close;
  }

  const denominator = count * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const slopePerBar = (count * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slopePerBar * sumX) / count;
  let squaredResiduals = 0;

  for (let index = 0; index < count; index += 1) {
    const predicted = intercept + slopePerBar * index;
    squaredResiduals += (window[index].close - predicted) ** 2;
  }

  const standardDeviation = Math.sqrt(squaredResiduals / count);
  const correlationDenominator = Math.sqrt(
    (count * sumXX - sumX * sumX) * (count * sumYY - sumY * sumY),
  );
  const correlation = correlationDenominator === 0
    ? 0
    : (count * sumXY - sumX * sumY) / correlationDenominator;

  const center: RegressionPoint[] = [];
  const upperOne: RegressionPoint[] = [];
  const lowerOne: RegressionPoint[] = [];
  const upperTwo: RegressionPoint[] = [];
  const lowerTwo: RegressionPoint[] = [];

  for (let index = 0; index < count; index += 1) {
    const time = window[index].time;
    const value = intercept + slopePerBar * index;
    center.push({ time, value });
    upperOne.push({ time, value: value + standardDeviation });
    lowerOne.push({ time, value: value - standardDeviation });
    upperTwo.push({ time, value: value + 2 * standardDeviation });
    lowerTwo.push({ time, value: value - 2 * standardDeviation });
  }

  return {
    center,
    upperOne,
    lowerOne,
    upperTwo,
    lowerTwo,
    slopePerBar,
    intercept,
    standardDeviation,
    rSquared: correlation * correlation,
  };
};
