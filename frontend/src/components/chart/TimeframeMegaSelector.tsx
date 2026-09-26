// ============================================================================
// TimeframeMegaSelector.tsx — cTrader-style timeframe / bar-type picker.
//
// A single trigger button opens a five-column popover: Standard · Tick · Renko
// · Range · Heikin Ashi (see engine/barTypes.ts). The active row carries an
// emerald check and a gold left-edge, matching the approved design mockup.
//
// Used on the main chart toolbar (via LSEChart.mountTimeframeSelector, mount.tsx)
// and on every panel of the multi-timeframe grid (TerminalMultiGrid), so the
// same control drives every chart surface.
// ============================================================================

import React, { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Clock, CalendarDays, ChevronDown, Check, Layers, Hash, Ban } from 'lucide-react';
import type { ChartType } from '@/components/chart/core/types';
import {
  BAR_COLUMNS,
  barTriggerLabel,
  isActiveRow,
  type BarColumn,
  type BarRow,
  type BarSelection,
} from '@/engine/barTypes';

// Emerald + gold accents from the approved palette.
const EMERALD = '#0f9d58';
const GOLD = '#d4af37';

interface Props {
  value: BarSelection;
  onChange: (sel: BarSelection) => void;
  /** Smaller trigger for grid-panel headers. */
  compact?: boolean;
  /** Optional side the popover opens toward (default 'bottom'). */
  side?: 'bottom' | 'top';
}

// A small left glyph per row, matching the mockup (clock for intraday, calendar
// for daily/weekly, distinct marks for the alternative bar types).
function rowIcon(col: BarColumn, row: BarRow): React.ReactNode {
  const size = 14;
  if (!col.enabled) return <Ban size={size} style={{ opacity: 0.7 }} />;
  if (col.kind === 'renko') return <Layers size={size} />;
  if (col.kind === 'tick') return <Hash size={size} />;
  const tf = row.tf || '';
  const coarse = /d|w|y$/i.test(tf);
  return coarse ? <CalendarDays size={size} /> : <Clock size={size} />;
}

export default function TimeframeMegaSelector({ value, onChange, compact, side = 'bottom' }: Props) {
  const [open, setOpen] = useState(false);

  const triggerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: compact ? 22 : 28,
    padding: compact ? '0 7px' : '0 10px',
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

  const commit = (col: BarColumn, row: BarRow) => {
    if (!col.enabled || !col.chartType || !row.tf) return;
    onChange({ timeframe: row.tf, chartType: col.chartType as ChartType });
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" style={triggerStyle} title="Timeframe & bar type">
          <span>{barTriggerLabel(value)}</span>
          <ChevronDown size={compact ? 12 : 14} style={{ opacity: 0.7 }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align="start"
          sideOffset={6}
          style={{
            zIndex: 400,
            background: 'var(--panel, #14181c)',
            border: `1px solid rgba(15, 157, 88, 0.35)`,
            borderRadius: 10,
            boxShadow: '0 14px 44px var(--shadow, rgba(0,0,0,0.55))',
            color: 'var(--text, #e6e6e6)',
            overflow: 'hidden',
            maxWidth: '96vw',
          }}
        >
          <div style={{ display: 'flex', maxHeight: '70vh' }}>
            {BAR_COLUMNS.map((col, ci) => (
              <div
                key={col.kind}
                title={col.enabled ? undefined : col.disabledReason}
                style={{
                  minWidth: compact ? 132 : 150,
                  borderRight:
                    ci < BAR_COLUMNS.length - 1 ? '1px solid var(--edge, #2a2e39)' : 'none',
                  opacity: col.enabled ? 1 : 0.45,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    padding: '11px 14px 8px',
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--dim, #8b8f98)',
                    borderBottom: '1px solid var(--edge, #2a2e39)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {col.title}
                </div>
                <div style={{ overflowY: 'auto', padding: '4px 0' }}>
                  {col.rows.map((row, ri) => {
                    const active = isActiveRow(col, row, value);
                    return (
                      <button
                        key={row.tf || `${col.kind}-${ri}`}
                        type="button"
                        disabled={!col.enabled}
                        onClick={() => commit(col, row)}
                        onMouseEnter={(e) => {
                          if (col.enabled && !active)
                            e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,0.06))';
                        }}
                        onMouseLeave={(e) => {
                          if (!active) e.currentTarget.style.background = 'transparent';
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 9,
                          width: '100%',
                          padding: '6px 14px',
                          border: 'none',
                          borderLeft: `2px solid ${active ? GOLD : 'transparent'}`,
                          background: active ? 'rgba(212, 175, 55, 0.10)' : 'transparent',
                          color: 'inherit',
                          font: 'inherit',
                          fontSize: 13,
                          textAlign: 'left',
                          cursor: col.enabled ? 'pointer' : 'not-allowed',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <span style={{ display: 'inline-flex', color: 'var(--dim, #8b8f98)' }}>
                          {rowIcon(col, row)}
                        </span>
                        <span style={{ flex: 1 }}>{row.label}</span>
                        {active && <Check size={14} style={{ color: EMERALD }} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
