// ============================================================================
// engine/index — PRIMARY CHART ENGINE facade (Phase 2).
//
//   DATA SOURCE (REST /api/candles, WS /api/ws, files, replay)
//        ↓  normalize.ts / timeframes.ts
//   NORMALIZED MARKET DATA (types.ts)
//        ↓  transforms.ts (display types)
//   CHART DATA ADAPTER (mount normalise + shell loadChart/onTick)
//        ↓
//   PRIMARY CHART ENGINE (ProChart canvas + overlays)
//        ↓
//   CHART UI / INTERACTION LAYER
//
// ProChart is the single primary renderer for Market → Price & Chart.
// Backtest / multi-grid reuse the same engine component. Do not introduce
// a second price-chart implementation for live vs replay vs workspace.
// ============================================================================

export * from './types';
export * from './timeframes';
export * from './normalize';
export * from './transforms';
