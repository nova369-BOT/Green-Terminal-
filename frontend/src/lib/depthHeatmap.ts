import type { BusDepth } from '@/market-data/bus';

export interface HeatmapLevel { price: string; quantity: number; }
export interface HeatmapFrame { receivedAt: number; eventAt?: number; bids: HeatmapLevel[]; asks: HeatmapLevel[]; }

/** A bounded, immutable depth history. It records resting liquidity snapshots
 * only; executed trades never enter this structure. */
export class DepthHeatmapHistory {
  private bids = new Map<string, number>();
  private asks = new Map<string, number>();
  private frames: HeatmapFrame[] = [];
  private ready = false;
  private resetReason: string | null = null;
  constructor(private readonly maxFrames = 240) {}

  apply(event: BusDepth): HeatmapFrame | null {
    if (event.type === 'DEPTH_RESET') {
      this.bids.clear(); this.asks.clear(); this.frames = [];
      this.ready = false; this.resetReason = String(event.reason || 'depth reset');
      return null;
    }
    const bids = this.levels(event.bids || event.b);
    const asks = this.levels(event.asks || event.a);
    if (event.type === 'ORDER_BOOK_SNAPSHOT') {
      this.bids = new Map(bids); this.asks = new Map(asks); this.ready = false;
    } else {
      if (!this.bids.size && !this.asks.size) return null;
      this.merge(this.bids, bids); this.merge(this.asks, asks); this.ready = true;
    }
    if (!this.ready) return null;
    const frame: HeatmapFrame = { receivedAt: Date.now(), eventAt: typeof event.E === 'number' ? event.E : undefined, bids: this.sorted(this.bids, true), asks: this.sorted(this.asks, false) };
    this.frames.push(frame);
    if (this.frames.length > this.maxFrames) this.frames.splice(0, this.frames.length - this.maxFrames);
    this.resetReason = null;
    return frame;
  }
  snapshot(): HeatmapFrame[] { return this.frames.slice(); }
  state(): { ready: boolean; resetReason: string | null } { return { ready: this.ready, resetReason: this.resetReason }; }
  private levels(raw: unknown): Array<[string, number]> {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(row => {
      if (!Array.isArray(row) || row.length < 2) return [];
      const qty = Number(row[1]);
      return Number.isFinite(qty) && qty >= 0 ? [[String(row[0]), qty] as [string, number]] : [];
    });
  }
  private merge(book: Map<string, number>, updates: Array<[string, number]>): void { for (const [price, qty] of updates) qty === 0 ? book.delete(price) : book.set(price, qty); }
  private sorted(book: Map<string, number>, descending: boolean): HeatmapLevel[] { return [...book].sort((a, b) => (Number(a[0]) - Number(b[0])) * (descending ? -1 : 1)).map(([price, quantity]) => ({ price, quantity })); }
}
