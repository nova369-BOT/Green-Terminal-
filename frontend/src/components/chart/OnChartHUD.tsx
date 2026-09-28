// ── On-chart indicator HUD (Item 8) ──────────────────────────────────────────
//
// A minimal, flat legend that replaces the old gauge "instrument cluster".
// One tidy text row per active indicator — colour dot · name · latest value —
// with three ALWAYS-VISIBLE controls at the end of each row: edit, hide and a
// remove (×/cancel). A quiet "+ Add indicator" link opens the browser.
//
// Presentational only: it renders whatever `deriveHudItems()` produced and
// routes control clicks back through callbacks. Props interface is unchanged so
// ProChart needs no edits. Brass/gold accent (locked).
import React, { useState } from 'react';
import { Pencil, Eye, EyeOff, X, Plus } from 'lucide-react';
import type { HudIndicatorItem } from './onChartHudData';

export interface OnChartHUDProps {
  symbol: string;
  /** Small tag next to the symbol, e.g. a timeframe or market. Omit to hide. */
  symbolTag?: string;
  items: HudIndicatorItem[];
  /** Accent colour for the Add link. Default brass. */
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

const MONO = '"SF Mono", ui-monospace, Consolas, monospace';

const IconBtn: React.FC<{
  title: string; onClick: (e: React.MouseEvent) => void; danger?: boolean; children: React.ReactNode;
}> = ({ title, onClick, danger, children }) => (
  <button
    type="button"
    title={title}
    onClick={(e) => { e.stopPropagation(); onClick(e); }}
    style={{
      width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: 'none', borderRadius: 3, cursor: 'pointer', padding: 0,
      background: 'transparent', color: danger ? '#c04a5e' : 'rgba(244,241,232,0.72)',
    }}
    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(244,241,232,0.12)'; }}
    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
  >
    {children}
  </button>
);

const LegendRow: React.FC<{
  it: HudIndicatorItem; text: string; dim: string;
  onEdit: (i: HudIndicatorItem) => void;
  onHide: (i: HudIndicatorItem) => void;
  onDelete: (i: HudIndicatorItem) => void;
}> = ({ it, text, dim, onEdit, onHide, onDelete }) => {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto',
        padding: '2px 6px 2px 3px', borderRadius: 4,
        background: hover ? 'rgba(244,241,232,0.06)' : 'transparent',
        opacity: it.hidden ? 0.5 : 1,
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
        background: it.hidden ? 'rgba(244,241,232,0.3)' : it.color,
      }} />
      <span style={{
        fontSize: 12, fontWeight: 600, color: text, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220, letterSpacing: '0.01em',
      }}>
        {it.title}
      </span>
      {it.valueText && it.valueText !== '—' && (
        <span style={{
          fontSize: 11, color: dim, fontFamily: MONO, fontVariantNumeric: 'tabular-nums',
          marginLeft: 2, whiteSpace: 'nowrap',
        }}>
          {it.valueText}
        </span>
      )}
      {/* Controls: always visible (dimmed), brighten on row hover. */}
      <span style={{
        display: 'flex', gap: 2, marginLeft: 6, flex: '0 0 auto',
        opacity: hover ? 1 : 0.5, transition: 'opacity 120ms ease',
      }}>
        <IconBtn title={`Edit ${it.title}`} onClick={() => onEdit(it)}>
          <Pencil size={12} />
        </IconBtn>
        <IconBtn title={it.hidden ? `Show ${it.title}` : `Hide ${it.title}`} onClick={() => onHide(it)}>
          {it.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
        </IconBtn>
        <IconBtn title={`Remove ${it.title}`} danger onClick={() => onDelete(it)}>
          <X size={12} />
        </IconBtn>
      </span>
    </div>
  );
};

export const OnChartHUD: React.FC<OnChartHUDProps> = ({
  symbol, symbolTag, items, accent = '#b08d57',
  text = '#f4f1e8', dim = '#9aa79d',
  onEdit, onHide, onDelete, onAdd, style,
}) => {
  return (
    <div
      style={{
        position: 'absolute', top: 10, left: 12, zIndex: 14,
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
        pointerEvents: 'none', // wrapper transparent; rows opt back in
        maxWidth: 'calc(100% - 120px)',
        ...style,
      }}
    >
      {/* ── Symbol line ── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3, pointerEvents: 'auto' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: text, letterSpacing: '0.01em' }}>
          {symbol || '—'}
        </span>
        {symbolTag && (
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', color: dim,
            background: 'rgba(244,241,232,0.06)', padding: '1px 5px', borderRadius: 3,
            textTransform: 'uppercase',
          }}>
            {symbolTag}
          </span>
        )}
      </div>

      {/* ── One row per active indicator ── */}
      {items.map((it) => (
        <LegendRow
          key={it.key}
          it={it}
          text={text}
          dim={dim}
          onEdit={onEdit}
          onHide={onHide}
          onDelete={onDelete}
        />
      ))}

      {/* ── Add link ── */}
      <button
        type="button"
        title="Add indicator"
        onClick={onAdd}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, marginLeft: 1,
          background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px',
          color: accent, fontSize: 12, fontWeight: 600, letterSpacing: '0.02em',
          pointerEvents: 'auto', borderRadius: 4,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = `${accent}14`; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <Plus size={14} />
        <span>Add indicator</span>
      </button>
    </div>
  );
};

export default OnChartHUD;
