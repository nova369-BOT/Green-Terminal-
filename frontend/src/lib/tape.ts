/**
 * tape.ts — TradeTape: a bounded ring of verified prints plus session stats.
 *
 * Contract (accuracy law — design/ORDERFLOW_STEPBYSTEP.md):
 *  - Prints enter only via add(); nothing is synthesized or backfilled.
 *  - Aggressor side is whatever the provider supplied ('buy' | 'sell');
 *    side-known volume splits use it verbatim, side-unknown prints are
 *    excluded from those splits (never inferred from price movement).
 *  - The ring is bounded (maxLen) so a never-ending session cannot grow
 *    memory without limit; eviction preserves newest-first order.
 *  - revision() bumps on every visible mutation so React can memo reads
 *    without re-walking the ring.
 */

export interface TapePrint {
  tsMs: number;
  price: number;
  size: number;
  side: 'buy' | 'sell' | null;
}

export interface TapeSession {
  /** accepted prints since clear() */
  count: number;
  /** Σ price·size / Σ size over SIDE-ANY prints (price·size known); null when no weight */
  vwap: number | null;
  /** Σ size of prints the provider marked 'buy' */
  buyVolume: number;
  /** Σ size of prints the provider marked 'sell' */
  sellVolume: number;
  /** first accepted print price (change anchor); null before any print */
  open: number | null;
  high: number | null;
  low: number | null;
  last: number | null;
}

const ZERO_SESSION: TapeSession = {
  count: 0, vwap: null, buyVolume: 0, sellVolume: 0,
  open: null, high: null, low: null, last: null,
};

export const TAPE_DEFAULT_MAX = 2000;

export class TradeTape {
  private ring: TapePrint[] = [];   /* index 0 = newest */
  private rev = 0;
  private readonly maxLen: number;

  constructor(maxLen: number = TAPE_DEFAULT_MAX) {
    this.maxLen = Math.max(1, Math.floor(maxLen));
  }

  /** Append a verified print. Returns true whenever it became visible —
   * i.e. the ring grew or the newest slot changed — so callers can bump UI
   * only on change. */
  add(tsMs: number, price: number, size: number, side: 'buy' | 'sell' | null): boolean {
    if (!Number.isFinite(tsMs) || !Number.isFinite(price) || !Number.isFinite(size)) return false;
    if (size < 0 || price <= 0) return false;
    this.ring.unshift({ tsMs, price, size, side: side === 'buy' || side === 'sell' ? side : null });

    const s = this.session;
    s.count += 1;
    const notional = price * size;
    this.priceWeight += notional;
    this.sizeWeight += size;
    s.vwap = this.sizeWeight > 0 ? this.priceWeight / this.sizeWeight : null;
    if (side === 'buy') this.session.buyVolume += size;
    else if (side === 'sell') this.session.sellVolume += size;
    if (s.open === null) s.open = price;
    s.high = s.high === null ? price : Math.max(s.high, price);
    s.low = s.low === null ? price : Math.min(s.low, price);
    s.last = price;

    if (this.ring.length > this.maxLen) {
      /* Drop the oldest. It still counts in session stats (they are
       * cumulative for the session lifetime, which survives ring eviction;
       * G-Flow semantics: session history retention is a separate control,
       * stats are not "window basis"). */
      this.ring.length = this.maxLen;
    }
    this.rev += 1;
    return true;
  }

  private priceWeight = 0;
  private sizeWeight = 0;
  private session: TapeSession = { ...ZERO_SESSION };

  /** Newest-first snapshot, capped at `limit` (default: all retained). */
  list(limit?: number): TapePrint[] {
    const n = limit == null ? this.ring.length : Math.max(0, Math.min(limit, this.ring.length));
    return this.ring.slice(0, n);
  }

  stats(): TapeSession {
    return { ...this.session };
  }

  revision(): number { return this.rev; }
  get length(): number { return this.ring.length; }
  get capacity(): number { return this.maxLen; }

  clear(): void {
    this.ring = [];
    this.session = { ...ZERO_SESSION };
    this.priceWeight = 0;
    this.sizeWeight = 0;
    this.rev += 1;
  }
}
