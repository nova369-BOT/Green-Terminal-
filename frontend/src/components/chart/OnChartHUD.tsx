// ── On-chart indicator HUD (Item 8) ──────────────────────────────────────────
//
// A flat, professional "instrument cluster" that replaces the plain top-left
// text legend. One module per active indicator: a thin radial gauge showing
// where the latest value sits in its range, the value, a colour-coded name
// chip, and — on hover — edit / hide / delete controls. A trailing dashed
// "+ Add" tile opens the indicator browser. No OHLC (removed per spec).
//
// Presentational only: it renders whatever `deriveHudItems()` produced and
// routes control clicks back through callbacks. Brass/gold accent (locked).
import React, { useState } from 'react';
import { Pencil, Eye, EyeOff, X, Plus } from 'lucide-react';
import type { HudIndicatorItem } from './onChartHudData';

export interface OnChartHUDProps {
  symbol: string;
  /** Small tag under the symbol, e.g. "GOLD". Omit to hide. */
  symbolTag?: string;
  items: HudIndicatorItem[];
  /** Accent colour for active edges + gauges' brand tint. Default brass. */
  accent?: string;
  /** Palette overrides (defaults track the racing-green terminal theme). */
  panelBg?: string;
  edge?: string;
  text?: string;
  dim?: string;
  onEdit: (item: HudIndicatorItem) => void;
  onHide: (item: HudIndicatorItem) => void;
  onDelete: (item: HudIndicatorItem) => void;
  onAdd: () => void;
  style?: React.CSSProperties;
}

const GAUGE_TRACK = 'rgba(244,241,232,0.12)';

/** A 270° radial gauge. pathLength=100 normalises the arc math. */
const RadialGauge: React.FC<{ pct: number | null; color: string; value: string; hidden?: boolean }> = ({
  pct, color, value, hidden,
}) => {
  const shown = pct === null ? 0 : Math.max(0, Math.min(1, pct));
  const arc = 75; // 270° of a 360° circle, in pathLength units
  return (
    <div style={{ position: 'relative', width: 46, height: 46 }}>
      <svg width={46} height={46} viewBox="0 0 46 46" style={{ transform: 'rotate(135deg)' }}>
        {/* Track */}
        <circle
          cx={23} cy={23} r={18} fill="none"
          stroke={GAUGE_TRACK} strokeWidth={3} strokeLinecap="round"
          pathLength={100} strokeDasharray={`${arc} 100`}
        />
        {/* Value arc (hidden when no range is known) */}
        {pct !== null && (
          <circle
            cx={23} cy={23} r={18} fill="none"
            stroke={hidden ? GAUGE_TRACK : color} strokeWidth={3} strokeLinecap="round"
            pathLength={100} strokeDasharray={`${arc * shown} 100`}
            style={{ transition: 'stroke-dasharray 180ms ease' }}
          />
        )}
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.01em',
        fontFamily: '"SF Mono", ui-monospace, Consolas, monospace',
        color: hidden ? 'rgba(244,241,232,0.4)' : '#f4f1e8',
      }}>
        {value}
      </div>
    </div>
  );
};

const CtrlBtn: React.FC<{
  title: string; onClick: (e: React.MouseEvent) => void; danger?: boolean; children: React.ReactNode;
}> = ({ title, onClick, danger, children }) => (
  <button
    type="button"
    title={title}
    onClick={(e) => { e.stopPropagation(); onClick(e); }}
    style={{
      width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: 'none', borderRadius: 3, cursor: 'pointer', padding: 0,
      background: 'transparent', color: danger ? '#c04a5e' : 'rgba(244,241,232,0.7)',
    }}
    onMouseEnter={(e) => { (e.currentTarget.style.background = 'rgba(244,241,232,0.10)'); }}
    onMouseLeave={(e) => { (e.currentTarget.style.background = 'transparent'); }}
  >
    {children}
  </button>
);

export const OnChartHUD: React.FC<OnChartHUDProps> = ({
  symbol, symbolTag, items, accent = '#b08d57',
  panelBg = '#0a0f0c', edge = '#1d2b23', text = '#f4f1e8', dim = '#9aa79d',
  onEdit, onHide, onDelete, onAdd, style,
}) => {
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const moduleBase: React.CSSProperties = {
    position: 'relative',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
    padding: '8px 10px 7px',
    minWidth: 78,
    background: panelBg,
    border: `1px solid ${edge}`,
    borderRadius: 7,
    pointerEvents: 'auto',
  };

  return (
    <div
      style={{
        position: 'absolute', top: 10, left: 12, zIndex: 14,
        display: 'flex', alignItems: 'stretch', gap: 7,
        pointerEvents: 'none', // wrapper transparent; modules opt back in
        maxWidth: 'calc(100% - 120px)', flexWrap: 'wrap',
        ...style,
      }}
    >
      {/* ── Symbol module (slim, no OHLC) ── */}
      <div style={{
        ...moduleBase,
        alignItems: 'flex-start', justifyContent: 'center', gap: 2,
        minWidth: 0, padding: '8px 12px',
        borderLeft: `2px solid ${accent}`,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: text, letterSpacing: '0.01em', lineHeight: 1.1 }}>
          {symbol || '—'}
        </div>
        {symbolTag && (
          <div style={{
            fontSize: 8.5, fontWeight: 600, letterSpacing: '0.14em',
            color: accent, textTransform: 'uppercase',
          }}>
            {symbolTag}
          </div>
        )}
      </div>

      {/* ── One module per active indicator ── */}
      {items.map((it) => {
        const isHover = hoverKey === it.key;
        return (
          <div
            key={it.key}
            style={{
              ...moduleBase,
              borderColor: isHover ? accent : edge,
              boxShadow: isHover ? `0 0 0 1px ${accent}55, 0 4px 14px rgba(0,0,0,0.35)` : 'none',
              opacity: it.hidden ? 0.55 : 1,
              transition: 'border-color 120ms ease, box-shadow 120ms ease',
            }}
            onMouseEnter={() => setHoverKey(it.key)}
            onMouseLeave={() => setHoverKey((k) => (k === it.key ? null : k))}
          >
            {/* Hover control cluster */}
            {isHover && (
              <div style={{
                position: 'absolute', top: 3, right: 3, display: 'flex', gap: 1,
                background: 'rgba(5,8,10,0.85)', borderRadius: 4, padding: 1,
              }}>
                <CtrlBtn title={`Edit ${it.title}`} onClick={() => onEdit(it)}>
                  <Pencil size={12} />
                </CtrlBtn>
                <CtrlBtn title={it.hidden ? `Show ${it.title}` : `Hide ${it.title}`} onClick={() => onHide(it)}>
                  {it.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </CtrlBtn>
                <CtrlBtn title={`Remove ${it.title}`} danger onClick={() => onDelete(it)}>
                  <X size={12} />
                </CtrlBtn>
              </div>
            )}

            <RadialGauge pct={it.gaugePct} color={it.color} value={it.valueText} hidden={it.hidden} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 5, maxWidth: 96 }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto',
                background: it.hidden ? 'rgba(244,241,232,0.3)' : it.color,
              }} />
              <span style={{
                fontSize: 10, fontWeight: 600, color: it.hidden ? dim : text,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                letterSpacing: '0.02em',
              }}>
                {it.title}
              </span>
            </div>
          </div>
        );
      })}

      {/* ── Add tile ── */}
      <button
        type="button"
        title="Add indicator"
        onClick={onAdd}
        style={{
          ...moduleBase,
          justifyContent: 'center',
          minWidth: 62, cursor: 'pointer',
          background: 'transparent',
          border: `1px dashed ${accent}88`,
          color: accent,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = `${accent}14`; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <Plus size={18} />
        <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Add
        </span>
      </button>
    </div>
  );
};

export default OnChartHUD;
