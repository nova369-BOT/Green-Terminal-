// TerminalMultiGrid - the site's MultiPanelChartGrid, terminal edition.
//
// Same behavior contract as the website's multi-chart layout:
// grid presets from MultiTimeframeLayoutSelector (2x1 .. 4x2),
// per-panel timeframe (staggered sensible defaults), per-panel symbol when
// symbol-sync is off, active-panel highlight, and the four sync modes:
//   syncSymbol   - every panel follows the shell's charted pair
//   syncInterval - panels share the primary timeframe
//   syncCrosshair- crosshair time mirrors across panels (ProChart's
//                  syncedCrosshairTime prop, same as the site)
//   syncTime     - viewport scroll position mirrors (syncedViewportTime)
//
// Each panel now carries its own header (cTrader-style): a symbol picker and a
// timeframe/bar-type mega-selector, so the pair AND the timeframe/bar type can
// be changed directly on the pane. Changing a pane's symbol or timeframe while
// the matching sync is on turns that sync off (you asked for independent panes),
// so the change is actually visible.
//
// Data: the site's panels fetch through ProCandlestickChart; here each panel
// fetches through the terminal's local engine (fetchLocalCandles) and
// refreshes its tail on a short timer, so panes stay live without the shell
// having to fan ticks into React.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ProChart from '@/components/chart/ProChart';
import { DEFAULT_INDICATOR_CONFIG } from '@/components/chart/IndicatorSettings';
import { getDefaultColors, type Candle, type ChartType } from '@/components/chart/core/types';
import { type LayoutType, type SyncSettings } from '@/components/chart/MultiTimeframeLayoutSelector';
import TimeframeMegaSelector from '@/components/chart/TimeframeMegaSelector';
import PaneSymbolBrowser from '@/components/chart/PaneSymbolBrowser';
import { type BarSelection } from '@/engine/barTypes';
import { transformSeries } from '@/engine/transforms';
import { fetchLocalCandles } from '@/lib/localEngine';
import { layoutStore, useLayoutState } from '@/lib/layoutStore';
import { useChartSettings } from '@/contexts/ChartSettingsContext';

const LAYOUTS: Record<LayoutType, { count: number; cols: number; rows: number }> = {
  '1x1': { count: 1, cols: 1, rows: 1 },
  '2x1': { count: 2, cols: 2, rows: 1 },
  '1x2': { count: 2, cols: 1, rows: 2 },
  '2x2': { count: 4, cols: 2, rows: 2 },
  '3x1': { count: 3, cols: 3, rows: 1 },
  '1x3': { count: 3, cols: 1, rows: 3 },
  '4x1': { count: 4, cols: 4, rows: 1 },
  '3x2': { count: 6, cols: 3, rows: 2 },
  '2x3': { count: 6, cols: 2, rows: 3 },
  '4x2': { count: 8, cols: 4, rows: 2 },
};

// The site staggers panel timeframes so a fresh multi-layout is instantly
// useful (same idea as createInitialPanelStates upstream).
const STAGGER = ['1h', '4h', '1d', '15m', '5m', '1w', '30m', '1m'];

function Panel({
  index,
  symbol, timeframe, chartType, colors, active, onActivate,
  onSymbolChange, onBarChange,
  syncedCrosshairTime, onCrosshairMove, syncedViewportTime, onViewportTimeChange,
  quote,
}: {
  index: number;
  symbol: string; timeframe: string; chartType: ChartType; colors: any; active: boolean;
  onActivate: () => void;
  onSymbolChange: (sym: string) => void;
  onBarChange: (sel: BarSelection) => void;
  syncedCrosshairTime: number | null;
  onCrosshairMove: (t: number | null) => void;
  syncedViewportTime: number | null;
  onViewportTimeChange: (t: number | null) => void;
  quote?: { bid: number; ask: number } | null;
}) {
  const [candles, setCandles] = useState<Candle[]>([]);
  // Explicit load state so an empty pane shows WHY it's empty instead of a
  // black box: 'loading' while fetching/retrying, 'empty' once retries are
  // exhausted with no data, 'ready' once bars arrive.
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'empty'>('loading');
  // Timezone must be forwarded to ProChart: its prop default is 'UTC', which
  // ignores the user's Timezone setting (data.timezone, default "local").
  const chartSettings = useChartSettings();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setCandles([]);
    setLoadState('loading');

    const toCandles = (rows: any[]): Candle[] => rows.map((r: any) => ({
      time: Date.parse(r.timestamp),
      open: r.open, high: r.high, low: r.low, close: r.close,
      volume: r.volume,
    }));
    const fetchRows = () => fetchLocalCandles('multi_panel', { symbol, timeframe, limit: 500 });

    // Steady live-tail refresh once a pane has data.
    const tick = async () => {
      try {
        const rows = await fetchRows();
        if (!cancelled && rows?.length) setCandles(toCandles(rows));
      } catch { /* keep last bars; try again next tick */ }
      if (!cancelled) timer = setTimeout(tick, 10_000);
    };

    // Initial load with retry + exponential backoff. Empty first responses are
    // common when eight panes hit the engine at once; we retry a few times
    // before declaring the pane genuinely empty.
    const load = async () => {
      let rows: any[] | undefined;
      try { rows = await fetchRows(); } catch { rows = undefined; }
      if (cancelled) return;
      if (rows?.length) {
        setCandles(toCandles(rows));
        setLoadState('ready');
        timer = setTimeout(tick, 10_000);
        return;
      }
      attempts += 1;
      if (attempts >= 4) { setLoadState('empty'); return; }
      const delay = Math.min(400 * 2 ** attempts, 8_000);
      timer = setTimeout(load, delay);
    };

    // Stagger the first fetch by pane index so all panes don't hammer the
    // engine on the same frame (a cause of the throttled blank panes).
    timer = setTimeout(load, Math.min(index * 120, 1_000));
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [symbol, timeframe, index]);

  // Display-only series transform (Heikin Ashi / Renko), exactly as the main
  // chart does it in mount.tsx: source candles stay raw, ProChart draws the
  // transformed series for its matching branch. Identity for candlestick.
  const displayCandles = useMemo(
    () => transformSeries(candles as any, chartType) as unknown as Candle[],
    [candles, chartType],
  );

  return (
    <div
      onMouseDown={onActivate}
      style={{
        position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        // Selected pane: the shell's own selected-element color (--accent-bar:
        // charcoal on light, light gray on dark), same as active tabs and rows.
        border: active ? '1px solid var(--accent-bar, #888)' : '1px solid var(--edge, #2a2e39)',
      }}
    >
      {/* Per-pane header: change the instrument and the timeframe/bar type
          right here, cTrader-style. */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 6, padding: '3px 6px', flex: '0 0 auto',
          background: 'var(--panel, #1b1d22)',
          borderBottom: '1px solid var(--edge, #2a2e39)',
        }}
      >
        <PaneSymbolBrowser value={symbol} onChange={onSymbolChange} compact />
        <TimeframeMegaSelector value={{ timeframe, chartType }} onChange={onBarChange} compact />
      </div>

      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}>
        {displayCandles.length > 0 ? (
          <ProChart
            candles={displayCandles}
            symbol={symbol}
            timeframe={timeframe}
            chartType={chartType}
            livePrice={candles[candles.length - 1]?.close ?? null}
            rightOffset={6}
            colors={colors}
            indicators={DEFAULT_INDICATOR_CONFIG}
            timezone={chartSettings?.data?.timezone || 'local'}
            syncedCrosshairTime={syncedCrosshairTime ?? undefined}
            onCrosshairMove={onCrosshairMove}
            syncedViewportTime={syncedViewportTime ?? undefined}
            onViewportTimeChange={onViewportTimeChange}
            showBidAskSpread={!!quote}
            brokerBid={quote?.bid ?? null}
            brokerAsk={quote?.ask ?? null}
          />
        ) : (
          // Honest empty/loading state — never a silent black pane.
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center', textAlign: 'center',
            padding: 12, color: 'var(--dim, #9aa79d)',
            font: '12px system-ui, sans-serif',
          }}>
            {loadState === 'empty' ? (
              <span>No data for <b style={{ color: 'var(--text, #f4f1e8)' }}>{symbol}</b> · {timeframe}</span>
            ) : (
              <span style={{ opacity: 0.85 }}>Loading {symbol} · {timeframe}…</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TerminalMultiGrid({
  layout, syncSettings, pair, timeframe, colors, quote,
}: {
  layout: LayoutType;
  syncSettings: SyncSettings;
  pair: string;
  timeframe: string;
  colors: any;
  quote?: { bid: number; ask: number } | null;
}) {
  const cfg = LAYOUTS[layout] || LAYOUTS['2x2'];
  // Selection and per-panel symbols live in layoutStore, not local state: the
  // shell reads them to name the window title and to retarget symbol picks.
  const { activePanel, panelSymbols, panelIntervals, panelChartTypes } = useLayoutState();
  const active = Math.min(activePanel, cfg.count - 1);
  const [panelTfs, setPanelTfs] = useState<string[]>([]);
  const [crossT, setCrossT] = useState<number | null>(null);
  const [viewT, setViewT] = useState<number | null>(null);
  const base = useMemo(() => colors || getDefaultColors(), [colors]);

  useEffect(() => {
    setPanelTfs((prev) => {
      const next = [...prev];
      for (let i = next.length; i < cfg.count; i++) {
        next.push(i === 0 ? timeframe : STAGGER[i % STAGGER.length]);
      }
      return next.slice(0, cfg.count);
    });
  }, [cfg.count, timeframe]);

  const onCross = useCallback((t: number | null) => {
    if (syncSettings.syncCrosshair) setCrossT(t);
  }, [syncSettings.syncCrosshair]);
  const onView = useCallback((t: number | null) => {
    if (syncSettings.syncTime) setViewT(t);
  }, [syncSettings.syncTime]);

  return (
    <div style={{
      display: 'grid', width: '100%', height: '100%', gap: 2,
      gridTemplateColumns: `repeat(${cfg.cols}, 1fr)`,
      gridTemplateRows: `repeat(${cfg.rows}, 1fr)`,
    }}>
      {Array.from({ length: cfg.count }, (_, i) => {
        const sym = syncSettings.syncSymbol ? pair : (panelSymbols[i] || pair);
        // Per-pane timeframe precedence (matches the shell's timeframe rail +
        // focusPanePair): interval-sync forces the global tf; otherwise an
        // explicit store override wins, then the staggered local default.
        const tf = syncSettings.syncInterval ? timeframe : (panelIntervals[i] || panelTfs[i] || timeframe);
        const ct = (panelChartTypes[i] as ChartType) || 'candlestick';
        return (
          <Panel
            key={i}
            index={i}
            symbol={sym}
            timeframe={tf}
            chartType={ct}
            colors={base}
            active={i === active}
            onActivate={() => layoutStore.setActivePanel(i)}
            onSymbolChange={(next) => {
              layoutStore.setActivePanel(i);
              layoutStore.setPanelSymbol(i, next);
              // A per-pane symbol edit means the panes are no longer locked to
              // one instrument — otherwise the change would be invisible.
              if (syncSettings.syncSymbol) {
                layoutStore.setSync({ ...syncSettings, syncSymbol: false });
              }
            }}
            onBarChange={(sel) => {
              layoutStore.setActivePanel(i);
              layoutStore.setPanelInterval(i, sel.timeframe);
              layoutStore.setPanelChartType(i, sel.chartType);
              if (syncSettings.syncInterval) {
                layoutStore.setSync({ ...syncSettings, syncInterval: false });
              }
            }}
            syncedCrosshairTime={syncSettings.syncCrosshair ? crossT : null}
            onCrosshairMove={onCross}
            syncedViewportTime={syncSettings.syncTime ? viewT : null}
            onViewportTimeChange={onView}
            quote={quote}
          />
        );
      })}
    </div>
  );
}
