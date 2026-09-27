// ============================================================================
// TimeframeMegaSelector.tsx — cTrader-style timeframe "⋮ more" menu.
//
// On the main chart the trigger is a ⋮ button sitting right after the timeframe
// rail (…1d 1w ⋮), exactly like cTrader. On a grid pane (compact) it shows the
// pane's current timeframe label + chevron, since the pane has no rail of its
// own. Either trigger opens the same popover:
//
//   ┌ Standard | Heikin Ashi | Renko ┐   ← bar-type toggle (Tick/Range removed)
//   │ Line · Area · OHLC              │   ← secondary render styles
//   │ Minutes   1m 5m 15m 30m 45m     │
//   │ Hours     1h 2h 4h 8h           │
//   │ Days·W·M  1d 1w 1M 3M 6M         │   ← extended past 1w
//   │ Custom    (your pinned ones)     │
//   │ [ 45 ][ minutes ▾ ][ Add ]       │   ← build a custom timeframe
//   └──────────────────────────────────┘
//
// The active timeframe carries a gold left edge + emerald fill (approved
// mockup). Custom / monthly rungs the provider can't serve natively are built
// server-side by resampling a finer native (engine/tf_aggregate.py), so no
// button here ever draws a fabricated bar.
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, MoreVertical, Plus, X } from 'lucide-react';
import type { ChartType } from '@/components/chart/core/types';
import {
  CHART_TYPES,
  TF_GROUPS,
  BUILTIN_TFS,
  CUSTOM_UNITS,
  makeCustomTf,
  loadCustomTfs,
  addCustomTf,
  removeCustomTf,
  barTriggerLabel,
  tfShort,
  type BarSelection,
  type CustomUnit,
} from '@/engine/barTypes';

const EMERALD = '#0f9d58';
const GOLD = '#d4af37';

// Minimal, crisp glyphs for the chart-type picker (stroke = currentColor so the
// active/inactive colour flows from the tile). One per ChartType we expose.
function ChartTypeGlyph({ type }: { type: ChartType }) {
  const s = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none' as const,
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const };
  switch (type) {
    case 'candlestick':
    case 'heikinAshi':
      return (
        <svg {...s}>
          <line x1="8" y1="3" x2="8" y2="21" />
          <rect x="5.5" y="7" width="5" height="9" rx="1" fill="currentColor" stroke="none" />
          <line x1="16" y1="4" x2="16" y2="20" />
          <rect x="13.5" y="9" width="5" height="7" rx="1" fill="none" />
        </svg>
      );
    case 'bars':
      return (
        <svg {...s}>
          <line x1="8" y1="4" x2="8" y2="20" />
          <line x1="4.5" y1="8" x2="8" y2="8" />
          <line x1="8" y1="15" x2="11.5" y2="15" />
          <line x1="16" y1="5" x2="16" y2="19" />
          <line x1="12.5" y1="10" x2="16" y2="10" />
          <line x1="16" y1="13" x2="19.5" y2="13" />
        </svg>
      );
    case 'line':
      return (
        <svg {...s}>
          <polyline points="3,16 8,10 12,13 16,6 21,9" />
        </svg>
      );
    case 'area':
      return (
        <svg {...s}>
          <polyline points="3,16 8,10 12,13 16,6 21,9" />
          <path d="M3 16 L8 10 L12 13 L16 6 L21 9 L21 20 L3 20 Z" fill="currentColor" stroke="none" opacity="0.22" />
        </svg>
      );
    case 'renko':
      return (
        <svg {...s}>
          <rect x="4" y="13" width="5" height="5" rx="0.5" fill="currentColor" stroke="none" />
          <rect x="9.5" y="9" width="5" height="5" rx="0.5" fill="currentColor" stroke="none" />
          <rect x="15" y="5" width="5" height="5" rx="0.5" fill="none" />
        </svg>
      );
    default:
      return <svg {...s} />;
  }
}

interface Props {
  value: BarSelection;
  onChange: (sel: BarSelection) => void;
  /** Smaller trigger for grid-panel headers (shows the TF label, not a ⋮). */
  compact?: boolean;
  /** Optional side the popover opens toward (default 'bottom'). */
  side?: 'bottom' | 'top';
}

export default function TimeframeMegaSelector({ value, onChange, compact, side = 'bottom' }: Props) {
  const [open, setOpen] = useState(false);
  const [customs, setCustoms] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<CustomUnit['id']>('m');

  useEffect(() => {
    if (open) setCustoms(loadCustomTfs());
  }, [open]);

  // The active timeframe might be a custom the user pinned in a past session
  // (loaded lazily on open); make sure it is always represented as a chip.
  const customList = useMemo(() => {
    const set = new Set(customs);
    if (value.timeframe && !BUILTIN_TFS.includes(value.timeframe)) set.add(value.timeframe);
    return Array.from(set);
  }, [customs, value.timeframe]);

  const selectTf = (tf: string) => {
    onChange({ timeframe: tf, chartType: value.chartType });
    setOpen(false);
  };
  const selectType = (chartType: ChartType) => {
    onChange({ timeframe: value.timeframe, chartType });
  };

  const commitCustom = () => {
    const tf = makeCustomTf(amount, unit);
    if (!tf) return;
    setCustoms(addCustomTf(tf));
    setAmount('');
    onChange({ timeframe: tf, chartType: value.chartType });
    setOpen(false);
  };

  const triggerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    height: compact ? 22 : 28,
    padding: compact ? '0 7px' : '0 8px',
    fontSize: compact ? 11 : 12,
    fontWeight: 600,
    lineHeight: 1,
    color: 'var(--text, #e6e6e6)',
    background: 'var(--panel, #1b1d22)',
    border: `1px solid ${open ? EMERALD : 'var(--edge, #2a2e39)'}`,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };

  const tfButton = (tf: string, onRemove?: () => void) => {
    const active = tf === value.timeframe;
    return (
      <span key={tf} style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          type="button"
          onClick={() => selectTf(tf)}
          title={tf}
          style={{
            minWidth: 42,
            padding: onRemove ? '5px 18px 5px 9px' : '5px 9px',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text, #e6e6e6)',
            background: active ? 'rgba(15, 157, 88, 0.22)' : 'var(--panel-2, rgba(255,255,255,0.03))',
            border: '1px solid var(--edge, #2a2e39)',
            borderLeft: active ? `3px solid ${GOLD}` : '1px solid var(--edge, #2a2e39)',
            borderRadius: 6,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => {
            if (!active) e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,0.08))';
          }}
          onMouseLeave={(e) => {
            if (!active) e.currentTarget.style.background = 'var(--panel-2, rgba(255,255,255,0.03))';
          }}
        >
          {tf}
        </button>
        {onRemove && (
          <button
            type="button"
            title="Remove custom timeframe"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            style={{
              position: 'absolute',
              right: 3,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'inline-flex',
              padding: 1,
              border: 'none',
              background: 'transparent',
              color: 'var(--dim, #8b8f98)',
              cursor: 'pointer',
              lineHeight: 0,
            }}
          >
            <X size={11} />
          </button>
        )}
      </span>
    );
  };

  const chartTypeTile = (label: string, chartType: ChartType) => {
    const active = value.chartType === chartType;
    return (
      <button
        key={chartType}
        type="button"
        onClick={() => selectType(chartType)}
        title={label}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 5,
          padding: '9px 4px 7px',
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1.1,
          textAlign: 'center',
          color: active ? EMERALD : 'var(--dim, #8b8f98)',
          background: active ? 'rgba(15,157,88,0.12)' : 'transparent',
          border: `1px solid ${active ? 'rgba(15,157,88,0.55)' : 'var(--edge, #2a2e39)'}`,
          borderRadius: 8,
          cursor: 'pointer',
          transition: 'background 120ms, border-color 120ms, color 120ms',
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,0.06))';
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = 'transparent';
        }}
      >
        <ChartTypeGlyph type={chartType} />
        <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      </button>
    );
  };

  const groupLabelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--dim, #8b8f98)',
    margin: '10px 0 6px',
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" style={triggerStyle} title="Timeframe & bar type">
          {compact ? (
            <>
              <span>{barTriggerLabel(value)}</span>
              <ChevronDown size={12} style={{ opacity: 0.7 }} />
            </>
          ) : (
            <MoreVertical size={16} />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align="end"
          sideOffset={6}
          style={{
            zIndex: 400,
            width: 304,
            background: 'var(--panel, #14181c)',
            border: `1px solid rgba(15, 157, 88, 0.4)`,
            borderRadius: 10,
            boxShadow: '0 14px 44px var(--shadow, rgba(0,0,0,0.55))',
            color: 'var(--text, #e6e6e6)',
            overflow: 'hidden',
            maxHeight: '78vh',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ overflowY: 'auto', padding: '10px 12px 12px' }}>
            {/* Chart type — one clean icon grid */}
            <div style={{ ...groupLabelStyle, marginTop: 0 }}>Chart type</div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 6,
              }}
            >
              {CHART_TYPES.map((b) => chartTypeTile(b.label, b.chartType))}
            </div>

            {/* Timeframe groups */}
            {TF_GROUPS.map((g) => (
              <div key={g.label}>
                <div style={groupLabelStyle}>{g.label}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {g.tfs.map((tf) => tfButton(tf))}
                </div>
              </div>
            ))}

            {/* Custom timeframes */}
            {customList.length > 0 && (
              <div>
                <div style={groupLabelStyle}>Custom</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {customList.map((tf) =>
                    tfButton(tf, () => setCustoms(removeCustomTf(tf))),
                  )}
                </div>
              </div>
            )}

            {/* Custom adder */}
            <div style={groupLabelStyle}>Custom timeframe</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                min={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCustom();
                }}
                placeholder="45"
                style={{
                  width: 56,
                  padding: '6px 8px',
                  fontSize: 13,
                  color: 'var(--text, #e6e6e6)',
                  background: 'var(--bg, #0f1216)',
                  border: '1px solid var(--edge, #2a2e39)',
                  borderRadius: 6,
                  outline: 'none',
                }}
              />
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as CustomUnit['id'])}
                style={{
                  flex: 1,
                  padding: '6px 8px',
                  fontSize: 13,
                  color: 'var(--text, #e6e6e6)',
                  background: 'var(--bg, #0f1216)',
                  border: '1px solid var(--edge, #2a2e39)',
                  borderRadius: 6,
                  outline: 'none',
                }}
              >
                {CUSTOM_UNITS.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={commitCustom}
                disabled={!makeCustomTf(amount, unit)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '6px 12px',
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: '#fff',
                  background: makeCustomTf(amount, unit) ? EMERALD : 'var(--edge, #2a2e39)',
                  border: 'none',
                  borderRadius: 6,
                  cursor: makeCustomTf(amount, unit) ? 'pointer' : 'default',
                }}
              >
                <Plus size={13} /> Add
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--dim, #8b8f98)', lineHeight: 1.4 }}>
              Selected: <b style={{ color: 'var(--text,#e6e6e6)' }}>{tfShort(value.timeframe)}</b>
              {' · '}built from real candles.
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
