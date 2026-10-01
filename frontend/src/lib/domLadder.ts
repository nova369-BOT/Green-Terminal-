/**
 * G-Flow DOM parity core, ported line-for-line from the original terminal:
 *   third_party/edgedepth-terminal/src/ui/dom_widget.cpp
 *   third_party/edgedepth-terminal/src/core/trade_at_price.h
 *
 * What this module owns (pure logic — no React, no network):
 *  - TradeAtPrice accumulator: per-tick buy/sell buckets with totals, cached
 *    maxima for bar normalisation, a monotonic revision counter so consumers
 *    rebuild only on real change, and Manual / Periodic(5m,15m,1h) / Session
 *    (UTC midnight) auto-reset — ResetPresets from trade_at_price.h.
 *  - Ladder grid: center-anchored price floor, band sums across grouped ticks
 *    (dom_band_size), per-side maxima over the visible window, row models with
 *    pre-formatted strings (fmt_value / fmt_signed), and the current-row model
 *    with cumulative session totals.
 *  - Formatting: "%.2fB/M/K" compact USD or coin quantities exactly like
 *    fmt_value; signed variants exactly like fmt_signed.
 *  - Grove ("OCEAN") depth ramp + relative-luminance ink choice, mirroring
 *    ocean_vec4 / luminance / depth_cell_text.
 *
 * Honesty conventions inherited from the C++:
 *  - The tick grid is DERIVED from the venue's own quoted precision (decimal
 *    places of price strings in book and prints). Nothing is invented: until a
 *    price has been observed there is no grid and the panel shows its pending
 *    state. When a finer precision appears the accumulator re-keys onto the new
 *    grid (set_tick_size semantics), flushing stale buckets.
 *  - Ladder chemistry is identical for COIN and USD display: sizes are summed
 *    in base units and formatted at render time — never converted upstream.
 */

/* ------------------------------- tokens ---------------------------------- */

export const OCEAN: ReadonlyArray<readonly [number, number, number]> = [
  [0x07, 0x10, 0x0a], [0x0e, 0x3a, 0x24], [0x1f, 0x6a, 0x44],
  [0x3f, 0x9d, 0x5c], [0xa8, 0xc6, 0x86], [0xe8, 0xd4, 0x8a],
];

export const UP = '#1f9d55';
export const DOWN = '#a83246';
export const BRAND = '#b08d57';
export const BRAND_INK = '#11150f';

/** ocean_vec4 → rgb css. t∈[0,1], 5 segments over 6 LUT stops. */
export function oceanRgb(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  const f = c * 5;
  const i = Math.min(4, Math.floor(f));
  const fr = f - i;
  const a = OCEAN[i];
  const b = OCEAN[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * fr);
  const g = Math.round(a[1] + (b[1] - a[1]) * fr);
  const bl = Math.round(a[2] + (b[2] - a[2]) * fr);
  return `rgb(${r},${g},${bl})`;
}

/** Relative luminance over the ramp — decides light vs dark ink on a bar. */
export function oceanLuminance(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  const f = c * 5;
  const i = Math.min(4, Math.floor(f));
  const fr = f - i;
  const a = OCEAN[i];
  const b = OCEAN[i + 1];
  const r = (a[0] + (b[0] - a[0]) * fr) / 255;
  const g = (a[1] + (b[1] - a[1]) * fr) / 255;
  const bl = (a[2] + (b[2] - a[2]) * fr) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

/* ------------------------------- formatting ------------------------------ */

/**
 * Decimals for a tick size — drives every price string in the ladder
 * (fmt_.price_fmt in the original). 1e-8 coins keep all 8 places.
 */
export function decimalsForTick(tick: number): number {
  if (!(tick > 0)) return 8;
  let d = 0;
  let t = tick;
  while (d < 12 && Math.abs(t - Math.round(t)) > 1e-9) { t *= 10; d += 1; }
  return d;
}

export function formatPrice(price: number | null, decimals: number): string {
  return price == null || !Number.isFinite(price) ? '' : price.toFixed(decimals);
}

/** fmt_value: COIN qty or compact USD notional. Coin display compacts 5–6
 * digit sizes too — the slim trade/Δ columns must not clip past the panel. */
export function fmtValue(qty: number, price: number, displayUsd: boolean): string {
  const v = displayUsd ? qty * price : qty;
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (displayUsd) return v.toFixed(0);
  return trimQty(v);
}

/** fmt_signed: ± prefix over fmt_value of the absolute magnitude. */
export function fmtSigned(value: number, price: number, displayUsd: boolean): string {
  return `${value >= 0 ? '+' : '-'}${fmtValue(Math.abs(value), price, displayUsd)}`;
}

/** "%g"-style coin text: fixed decimals without trailing-zero padding. */
function trimQty(v: number): string {
  const fixed = v.toFixed(8);
  return fixed.replace(/\.?0+$/, '') || '0';
}

/* ------------------------------ tick derivation -------------------------- */

/**
 * The honest grid: decimal places actually quoted by the venue, taken from the
 * book and the tape as strings. Prices never carry more precision than the
 * venue's tick, so `10^-maxDecimals` is the shared bucket size the original
 * terminal fetched from instrument metadata. Re-derived whenever a finer
 * price appears; 0 means "no grid yet" — render the pending state.
 */
export function deriveTickFromPrices(priceStrings: Iterable<string>): number {
  let maxDecimals = 0;
  for (const raw of priceStrings) {
    if (typeof raw !== 'string') continue;
    const dot = raw.indexOf('.');
    if (dot >= 0) {
      const digits = raw.length - dot - 1;
      if (digits > maxDecimals) maxDecimals = Math.min(digits, 12);
    }
  }
  return maxDecimals > 0 ? Math.pow(10, -maxDecimals) : 1;
}

/** Bucket key for a price on the tick grid (PriceHash semantics, as a string
 * of rounded integer ticks so float noise can never split one level). */
export function priceKey(price: number, tick: number): number {
  return Math.round(price / tick);
}

/* --------------------------- trade accumulator --------------------------- */

export type AccumulatorResetMode = 'manual' | 'periodic' | 'session';

export const RESET_PRESETS = {
  FIVE_MIN: 300,
  FIFTEEN_MIN: 900,
  ONE_HOUR: 3600,
} as const;

export interface TradeAtPriceLevel {
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
}

/**
 * Port of TradeAtPriceAccumulator (trade_at_price.h). Trades with non-positive
 * or non-finite price/qty are dropped exactly as on_trade() does; totals and
 * per-level counts mirror accumulate(); revision bumps on every accepted
 * trade AND on reset so row caches can skip rebuilds when nothing changed.
 */
export class TradeAtPriceAccumulator {
  private tick: number;
  private levels = new Map<number, TradeAtPriceLevel>();
  private maxBuy = 0;
  private maxSell = 0;
  private maxDeltaAbs = 0;
  private totalBuy = 0;
  private totalSell = 0;
  private totalTrades = 0;
  private revisionCount = 0;
  private resetMode: AccumulatorResetMode = 'periodic';
  private resetIntervalMs = RESET_PRESETS.FIVE_MIN * 1000;
  private lastResetMs = 0;

  constructor(tick: number) {
    this.tick = tick > 0 ? tick : 1e-9;
  }

  /** on_trade → accumulate. Returns false for malformed prints. */
  addTrade(price: number, qty: number, isBuy: boolean): boolean {
    if (!(price > 0) || !(qty > 0) || !Number.isFinite(price) || !Number.isFinite(qty)) return false;
    const key = priceKey(price, this.tick);
    let level = this.levels.get(key);
    if (!level) { level = { buyVolume: 0, sellVolume: 0, buyCount: 0, sellCount: 0 }; this.levels.set(key, level); }
    if (isBuy) { level.buyVolume += qty; level.buyCount += 1; this.totalBuy += qty; }
    else { level.sellVolume += qty; level.sellCount += 1; this.totalSell += qty; }
    this.totalTrades += 1;
    this.maxBuy = Math.max(this.maxBuy, level.buyVolume);
    this.maxSell = Math.max(this.maxSell, level.sellVolume);
    this.maxDeltaAbs = Math.max(this.maxDeltaAbs, Math.abs(level.buyVolume - level.sellVolume));
    this.revisionCount += 1;
    return true;
  }

  get(price: number): TradeAtPriceLevel | undefined {
    return this.levels.get(priceKey(price, this.tick));
  }

  /** Grouped-band lookup: sum over `mult` sub-ticks like the DOM's agg_buy/
   * agg_sell loop in build_row_models. Direction follows isAsk (band extends
   * upward for ask rows, downward for bid rows). */
  getBand(price: number, isAsk: boolean, mult: number): TradeAtPriceLevel {
    const out: TradeAtPriceLevel = { buyVolume: 0, sellVolume: 0, buyCount: 0, sellCount: 0 };
    const baseKey = priceKey(price, this.tick);
    for (let k = 0; k < mult; k += 1) {
      const level = this.levels.get(baseKey + (isAsk ? k : -k));
      if (level) {
        out.buyVolume += level.buyVolume;
        out.sellVolume += level.sellVolume;
        out.buyCount += level.buyCount;
        out.sellCount += level.sellCount;
      }
    }
    return out;
  }

  /** check_auto_reset: Periodic on elapsed wall time, Session on UTC day
   * boundary, Manual never. last_reset bootstrap mirrors init (epoch 0 ⇒ any
   * non-manual first check arms the window without wiping fresh data). */
  checkAutoReset(nowMs: number): void {
    if (this.resetMode === 'manual') return;
    if (this.lastResetMs === 0) { this.lastResetMs = nowMs; return; }
    if (this.resetMode === 'periodic') {
      if (this.resetIntervalMs > 0 && nowMs - this.lastResetMs >= this.resetIntervalMs) this.clearTotals(nowMs);
    } else if (Math.floor(nowMs / 86400000) > Math.floor(this.lastResetMs / 86400000)) {
      this.clearTotals(nowMs);
    }
  }

  reset(nowMs?: number): void { this.clearTotals(nowMs ?? Date.now()); }

  setResetMode(mode: AccumulatorResetMode, intervalSec: number = RESET_PRESETS.FIVE_MIN): void {
    this.resetMode = mode;
    this.resetIntervalMs = intervalSec * 1000;
    this.reset();
  }

  getResetMode(): { mode: AccumulatorResetMode; intervalSec: number } {
    return { mode: this.resetMode, intervalSec: this.resetIntervalMs / 1000 };
  }

  /** set_tick_size: re-key every bucket onto the new grid — hashed keys from
   * the old grid cannot be reinterpreted, so levels are rebuilt (and dropped:
   * the old grid's buckets are a lie on the new grid) and totals flush,
   * revision bumping so caches invalidate. Matches the C++ flush-on-rekey. */
  setTickSize(tick: number): void {
    const t = tick > 0 ? tick : 1e-9;
    if (t === this.tick) return;
    this.tick = t;
    this.levels = new Map();
    this.maxBuy = 0; this.maxSell = 0; this.maxDeltaAbs = 0;
    this.totalBuy = 0; this.totalSell = 0; this.totalTrades = 0;
    this.revisionCount += 1;
  }

  getTick(): number { return this.tick; }
  getMaxTotal(): number { return Math.max(this.maxBuy, this.maxSell); }
  getMaxDeltaAbs(): number { return this.maxDeltaAbs; }
  getTotalBuy(): number { return this.totalBuy; }
  getTotalSell(): number { return this.totalSell; }
  getTotalDelta(): number { return this.totalBuy - this.totalSell; }
  getTotalTrades(): number { return this.totalTrades; }
  revision(): number { return this.revisionCount; }

  private clearTotals(nowMs: number): void {
    this.levels = new Map();
    this.maxBuy = 0; this.maxSell = 0; this.maxDeltaAbs = 0;
    this.totalBuy = 0; this.totalSell = 0; this.totalTrades = 0;
    this.lastResetMs = nowMs;
    this.revisionCount += 1;
  }
}

/* ------------------------------- row models ------------------------------ */

export interface LadderBookSide {
  /** Integer tick key (priceKey) → aggregated size at that sub-tick. */
  byTick: ReadonlyMap<number, number>;
}

export interface LadderRowModel {
  price: number;
  priceText: string;
  hasSize: boolean;
  depthFrac: number;
  sizeText: string;
  hasBuy: boolean;
  buyText: string;
  hasSell: boolean;
  sellText: string;
  hasDelta: boolean;
  deltaPos: boolean;
  deltaText: string;
}

export interface LadderCurrentModel {
  priceText: string;
  hasBuy: boolean;
  buyText: string;
  hasSell: boolean;
  sellText: string;
  deltaPos: boolean;
  deltaText: string;
}

export interface LadderModel {
  /** Highest price first (rendered top→bottom). */
  asks: LadderRowModel[];
  current: LadderCurrentModel;
  /** Best bid first (rendered top→bottom). */
  bids: LadderRowModel[];
}

export interface LadderInputs {
  bids: LadderBookSide;
  asks: LadderBookSide;
  /** Venue last trade price used for the current row chip text. */
  lastPrice: number | null;
  /** Quantised ladder center (integer tick key). Zero ⇒ pending. */
  centerKey: number;
  /** scroll_offset_ in grouped ticks; positive scrolls prices UP. */
  scrollOffset: number;
  groupMult: 1 | 10 | 100;
  levelsPerSide: number;
  tick: number;
  decimals: number;
  displayUsd: boolean;
  showTradeColumns: boolean;
  accumulator: TradeAtPriceAccumulator;
}

/** dom_band_size port: sum book depth across a grouped band of `mult`
 * sub-ticks. With mult === 1 this is exactly the single-tick lookup. */
function bandSize(side: LadderBookSide, baseKey: number, isAsk: boolean, mult: number): number {
  let s = 0;
  for (let k = 0; k < mult; k += 1) {
    const v = side.byTick.get(baseKey + (isAsk ? k : -k));
    if (v !== undefined) s += v;
  }
  return s;
}

/**
 * build_row_models port: everything the render loop draws, computed in one
 * pass. update_max_sizes runs first (per-side maxima over the visible window
 * only, so bars scale to what you can see), then each row's model is filled —
 * price text, depth fraction against the visible max, banded trade totals and
 * per-level deltas. Render consumes the model verbatim.
 */
export function buildLadderModel(input: LadderInputs): LadderModel {
  const {
    bids, asks, lastPrice, centerKey, scrollOffset, groupMult, levelsPerSide,
    tick, decimals, displayUsd, showTradeColumns, accumulator,
  } = input;

  const et = groupMult;
  const adjustedCenter = centerKey + scrollOffset * et;

  const askRowAt = (i: number): number => adjustedCenter + (i + 1) * et;
  const bidRowAt = (i: number): number => adjustedCenter - (i + 1) * et;

  let maxAsk = 0;
  let maxBid = 0;
  for (let i = 0; i < levelsPerSide; i += 1) {
    maxAsk = Math.max(maxAsk, bandSize(asks, askRowAt(i), true, groupMult));
    maxBid = Math.max(maxBid, bandSize(bids, bidRowAt(i), false, groupMult));
  }
  const maxSize = Math.max(maxAsk, maxBid);

  const fill = (priceKeyValue: number, isAsk: boolean): LadderRowModel => {
    const price = priceKeyValue * tick;
    const row: LadderRowModel = {
      price,
      priceText: formatPrice(price, decimals),
      hasSize: false, depthFrac: 0, sizeText: '',
      hasBuy: false, buyText: '', hasSell: false, sellText: '',
      hasDelta: false, deltaPos: true, deltaText: '',
    };
    const size = bandSize(isAsk ? asks : bids, priceKeyValue, isAsk, groupMult);
    if (size > 0 && maxSize > 0) {
      row.hasSize = true;
      row.depthFrac = size / maxSize;
      row.sizeText = fmtValue(size, price, displayUsd);
    }
    if (showTradeColumns) {
      const agg = accumulator.getBand(price, isAsk, groupMult);
      const any = agg.buyVolume > 0 || agg.sellVolume > 0;
      if (agg.buyVolume > 0) { row.hasBuy = true; row.buyText = fmtValue(agg.buyVolume, price, displayUsd); }
      if (agg.sellVolume > 0) { row.hasSell = true; row.sellText = fmtValue(agg.sellVolume, price, displayUsd); }
      if (any) {
        row.hasDelta = true;
        const delta = agg.buyVolume - agg.sellVolume;
        row.deltaPos = delta >= 0;
        row.deltaText = fmtSigned(delta, price, displayUsd);
      }
    }
    return row;
  };

  const asksOut: LadderRowModel[] = [];
  for (let i = levelsPerSide - 1; i >= 0; i -= 1) asksOut.push(fill(askRowAt(i), true));
  const bidsOut: LadderRowModel[] = [];
  for (let i = 0; i < levelsPerSide; i += 1) bidsOut.push(fill(bidRowAt(i), false));

  const current: LadderCurrentModel = {
    priceText: formatPrice(lastPrice, decimals),
    hasBuy: false, buyText: '', hasSell: false, sellText: '', deltaPos: true, deltaText: '',
  };
  if (showTradeColumns && lastPrice != null) {
    if (accumulator.getTotalBuy() > 0) { current.hasBuy = true; current.buyText = fmtValue(accumulator.getTotalBuy(), lastPrice, displayUsd); }
    if (accumulator.getTotalSell() > 0) { current.hasSell = true; current.sellText = fmtValue(accumulator.getTotalSell(), lastPrice, displayUsd); }
    const totalDelta = accumulator.getTotalDelta();
    current.deltaPos = totalDelta >= 0;
    current.deltaText = fmtSigned(totalDelta, lastPrice, displayUsd);
  }

  return { asks: asksOut, current, bids: bidsOut };
}

/** update() centering port: last trade price wins, mid-book fallback for the
 * boot transient so the seeded depth is on-screen from frame one; manual
 * center honour (re-center target) otherwise. Returns an integer tick key, or
 * 0 when nothing honest to center on exists yet. */
export function resolveCenterKey(args: { lastPrice: number | null; bestBid: number | null; bestAsk: number | null; tick: number }): number {
  const { lastPrice, bestBid, bestAsk, tick } = args;
  if (!(tick > 0)) return 0;
  let center = lastPrice ?? 0;
  if (!(center > 0) && bestBid != null && bestAsk != null && bestBid > 0 && bestAsk > 0) {
    center = (bestBid + bestAsk) * 0.5;
  }
  return center > 0 ? Math.round(center / tick) : 0;
}
