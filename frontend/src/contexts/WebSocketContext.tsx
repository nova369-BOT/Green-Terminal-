// ============================================================================
// WebSocketContext.tsx — live tick context for the ported chart.
//
// Phase 3: replaces the historical "no feed" stub. useLiveTick now reads the
// shared market-data connection (refcounted per symbol). When the socket is
// down, or `enabled` is false (manual backtest / replay startDate), it keeps
// the original contract: { tick: null, isConnected: false } so the chart
// takes its historical-only code path.
//
// Ticks are normalized to epoch SECONDS (central-feed convention the chart
// already expects) without inventing prices — only real bus events surface.
// ============================================================================

import { useMarketFeed } from '@/market-data/hooks';

export interface TickData {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  // Epoch seconds, matching the central feed convention the chart expects.
  ts: number;
}

function toEpochSec(tsMs: number | undefined, recvMs: number): number {
  const ms = tsMs && tsMs > 1e11 ? tsMs : recvMs;
  return Math.floor(ms / 1000);
}

export const useLiveTick = (
  symbol: string | null,
  enabled: boolean = true
): { tick: TickData | null; isConnected: boolean } => {
  const { tick, isConnected, quote } = useMarketFeed(symbol, undefined, enabled && !!symbol);

  if (!enabled || !symbol || !tick || !isConnected) {
    return { tick: null, isConnected: false };
  }
  if (tick.symbol && tick.symbol !== symbol) {
    return { tick: null, isConnected };
  }
  const price =
    typeof tick.price === 'number' && Number.isFinite(tick.price)
      ? tick.price
      : typeof quote?.price === 'number'
        ? quote.price
        : null;
  if (price == null) {
    // Connected but this frame had no price — do not fabricate one.
    return { tick: null, isConnected };
  }

  const tsMs =
    typeof tick.ts_ms === 'number'
      ? tick.ts_ms
      : typeof tick.ts === 'number'
        ? tick.ts > 1e11
          ? tick.ts
          : tick.ts * 1000
        : tick.recv_ms;

  return {
    tick: {
      symbol: tick.symbol || symbol,
      price,
      bid: typeof tick.bid === 'number' ? tick.bid : quote?.bid,
      ask: typeof tick.ask === 'number' ? tick.ask : quote?.ask,
      ts: toEpochSec(tsMs, tick.recv_ms),
    },
    isConnected,
  };
};
