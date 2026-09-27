// Standalone preview harness for the Item-8 on-chart HUD. Renders the REAL
// OnChartHUD component (not a mockup) with representative sample modules over a
// faux candlestick backdrop, so the design can be reviewed live. Not part of
// the production bundle.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { OnChartHUD } from '../src/components/chart/OnChartHUD';
import type { HudIndicatorItem } from '../src/components/chart/onChartHudData';

const sample: HudIndicatorItem[] = [
  { key: 'movingAverages__0', configKey: 'movingAverages', lineIndex: 0, title: 'EMA 20', valueText: '4271.4', color: '#4c9be8', gaugePct: 0.72, display: 'overlay' },
  { key: 'movingAverages__1', configKey: 'movingAverages', lineIndex: 1, title: 'SMA 50', valueText: '4258.9', color: '#2fbf9e', gaugePct: 0.44, display: 'overlay' },
  { key: 'bollinger', configKey: 'bollinger', lineIndex: null, title: 'BB', valueText: '4264.0', color: '#b08d57', gaugePct: 0.58, display: 'overlay' },
  { key: 'rsi', configKey: 'rsi', lineIndex: null, title: 'RSI 14', valueText: '61.3', color: '#a884f0', gaugePct: 0.613, display: 'subplot' },
  { key: 'atr', configKey: 'atr', lineIndex: null, title: 'ATR', valueText: '3.42', color: '#e2a03f', gaugePct: 0.35, display: 'subplot', hidden: true },
];

function FauxChart() {
  // A cheap candle backdrop so the HUD is judged against a real-ish chart.
  const bars = Array.from({ length: 60 }, (_, i) => {
    const up = Math.sin(i / 4) + (Math.random() - 0.5);
    return { up: up >= 0, h: 20 + Math.abs(Math.sin(i / 3)) * 120, y: 120 + Math.cos(i / 5) * 90 };
  });
  return (
    <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }}>
      {[...Array(8)].map((_, r) => (
        <line key={r} x1={0} x2="100%" y1={r * 90} y2={r * 90} stroke="rgba(244,241,232,0.05)" />
      ))}
      {bars.map((b, i) => (
        <g key={i} transform={`translate(${40 + i * 22}, 0)`}>
          <line x1={5} x2={5} y1={b.y - 20} y2={b.y + b.h + 20} stroke={b.up ? '#1f9d55' : '#c04a5e'} strokeWidth={1} />
          <rect x={0} y={b.y} width={10} height={b.h} fill={b.up ? '#1f9d55' : '#c04a5e'} rx={1} />
        </g>
      ))}
    </svg>
  );
}

function App() {
  const [items, setItems] = React.useState(sample);
  const log = (m: string) => console.log(m);
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <FauxChart />
      <OnChartHUD
        symbol="XAU/USD"
        symbolTag="GOLD"
        items={items}
        onEdit={(it) => log(`edit ${it.title}`)}
        onHide={(it) => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, hidden: !x.hidden } : x)))}
        onDelete={(it) => setItems((xs) => xs.filter((x) => x.key !== it.key))}
        onAdd={() => log('add indicator')}
      />
      <div style={{
        position: 'absolute', bottom: 12, left: 12, color: '#9aa79d',
        font: '11px system-ui', letterSpacing: '0.04em',
      }}>
        Item 8 — live component preview. Hover a module for edit / hide / delete.
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
