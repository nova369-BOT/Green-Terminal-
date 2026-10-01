/**
 * Trades tape parity core, ported from the original terminal:
 *   third_party/edgedepth-terminal/src/ui/trades_widget.cpp / .h
 *
 * What this module owns (pure logic — no React, no network):
 *  - TradeTape: the 64-print ring buffer of raw trades with format-once
 *    row text (price/qty/time are formatted ONCE at insert — trades are
 *    immutable, so the tape never reformats a row in the render loop).
 *  - Rolling qty EMA (alpha 0.02, slow baseline) for "big print" detection:
 *    a print outsizes when qty > ema * 8, exactly render_trade_row()'s rule.
 *  - calculate_statistics(): 60-second buy/sell volumes, buy pressure
 *    (0.0 = all sells … 1.0 = all buys, 0.5 on an empty window) and
 *    trades-per-second over the same window.
 *
 * Honesty conventions inherited from the C++:
 *  - Only venue prints with a verified aggressor side enter the tape;
 *    nothing is synthesized from book moves or candle edges.
 *  - Malformed prints (non-positive or non-finite price/qty) are dropped —
 *    the same guard as TradeAtPriceAccumulator::on_trade.
 */

export const MAX_TRADES = 64;

/** A print that was accepted into the tape, with its immutable row text. */
export interface TapePrint {
  tsMs: number;
  price: number;
  qty: number;
  isBuy: boolean;
  priceText: string;
  qtyText: string;
  timeText: string;
  /** qty > ema*8 at insert time — the .tape-row.big brand-soft wash. */
  big: boolean;
}

export interface TapeStatistics {
  volumeBuy1m: number;
  volumeSell1m: number;
  /** buy / (buy + sell) over the window; 0.5 when silent. */
  buyPressure: number;
  tradesPerSecond: number;
}

/** Trade volume outside the statistics window is not counted. */
const WINDOW_MS = 60_000;
/** qty_ema update alpha — trades_widget.cpp: `ema*0.98 + qty*0.02`. */
const EMA_ALPHA = 0.02;
/** render_trade_row(): `trade.qty > qty_ema_ * 8.0`. */
export const BIG_PRINT_FACTOR = 8;

/** "%g"-style qty text: full venue precision without trailing zero spam. */
export function fmtQty(qty: number): string {
  return qty.toFixed(8).replace(/\.?0+$/, '') || '0';
}

/** DisplayTimeZone::TimeSeconds parity — HH:MM:SS, 24-hour, wall clock. */
export function fmtTimeSeconds(tsMs: number): string {
  const d = new Date(tsMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export class TradeTape {
  /** Ring buffer, one slot per print (trades_ / row_text_ parity). */
  private readonly ring: (TapePrint | undefined)[] = new Array(MAX_TRADES);
  private count = 0;
  private qtyEma = 0;
  private revisionCount = 0;

  /** Price decimals for new rows (fmt_.price_fmt). Rises when a finer print
   * arrives from a finer instrument — earlier rows stay at their insert
   * precision (they are immutable by design). */
  private priceDecimals = 4;

  setPriceDecimals(decimals: number): void {
    if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 12) {
      this.priceDecimals = decimals;
    }
  }

  /** handle_trade() parity. Returns the accepted print or null for malformed
   * input (on_trade's guard). side must be known — never invent an aggressor. */
  add(tsMs: number, price: number, qty: number, isBuy: boolean): TapePrint | null {
    if (!(price > 0) || !(qty > 0) || !(tsMs > 0)) return null;
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(tsMs)) return null;

    const big = this.qtyEma > 0 && qty > this.qtyEma * BIG_PRINT_FACTOR;
    this.qtyEma = this.qtyEma <= 0 ? qty : this.qtyEma * (1 - EMA_ALPHA) + qty * EMA_ALPHA;

    const print: TapePrint = {
      tsMs, price, qty, isBuy,
      priceText: price.toFixed(this.priceDecimals),
      qtyText: fmtQty(qty),
      timeText: fmtTimeSeconds(tsMs),
      big,
    };
    this.ring[this.count % MAX_TRADES] = print;
    this.count += 1;
    this.revisionCount += 1;
    return print;
  }

  /** Newest-first view of up to MAX_TRADES prints (render_table parity:
   * `idx = (trade_count_ - 1 - i) % MAX_TRADES`). Returns same ring objects
   * every call — callers must not mutate. */
  list(): readonly TapePrint[] {
    const out: TapePrint[] = [];
    const n = Math.min(this.count, MAX_TRADES);
    for (let i = 0; i < n; i += 1) {
      const print = this.ring[(this.count - 1 - i) % MAX_TRADES];
      if (print) out.push(print);
    }
    return out;
  }

  size(): number { return Math.min(this.count, MAX_TRADES); }
  totalSeen(): number { return this.count; }
  getQtyEma(): number { return this.qtyEma; }
  revision(): number { return this.revisionCount; }

  clear(): void {
    this.ring.fill(undefined);
    this.count = 0;
    this.qtyEma = 0;
    this.revisionCount += 1;
  }

  /** calculate_statistics() parity: buy/sell volumes against the wall clock
   * (ImGui::GetTime in the original — both are "age relative to now"). The
   * loop breaks at the first print older than the window, like the original. */
  statistics(nowMs: number): TapeStatistics {
    let volumeBuy = 0;
    let volumeSell = 0;
    let recent = 0;
    const n = Math.min(this.count, MAX_TRADES);
    for (let i = 0; i < n; i += 1) {
      const print = this.ring[(this.count - 1 - i) % MAX_TRADES];
      if (!print) continue;
      if (nowMs - print.tsMs > WINDOW_MS) break;
      recent += 1;
      if (print.isBuy) volumeBuy += print.qty;
      else volumeSell += print.qty;
    }
    const total = volumeBuy + volumeSell;
    return {
      volumeBuy1m: volumeBuy,
      volumeSell1m: volumeSell,
      buyPressure: total > 0 ? volumeBuy / total : 0.5,
      tradesPerSecond: recent / (WINDOW_MS / 1000),
    };
  }
}
