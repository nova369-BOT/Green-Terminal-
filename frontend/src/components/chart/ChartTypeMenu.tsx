// ============================================================================
// ChartTypeMenu.tsx — the main chart's dedicated advanced "Bar style" picker.
//
// A single trigger (icon + current type label) opens a popover with:
//   • a search box that filters across all 15 types,
//   • the 4 grouped sections (Bar / Line / Area / Japanese) as an icon-tile
//     grid, the active tile carrying a gold edge + emerald fill,
//   • a gold live-description strip that explains whatever the pointer is on
//     (or the current selection).
// Approved design: design/mockups/bar-style-advanced.png. Every type here is a
// real render mode (ProChart.drawChart + engine/priceCharts).
// ============================================================================

import React, { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Search } from 'lucide-react';
import type { ChartType } from '@/components/chart/core/types';
import { ChartTypeGlyph } from '@/components/chart/ChartTypeIcons';
import {
  CHART_TYPE_GROUPS,
  chartTypeLabel,
  chartTypeDesc,
  type ChartTypeInfo,
} from '@/engine/barTypes';

const EMERALD = '#0f9d58';
const GOLD = '#d4af37';

interface Props {
  value: ChartType;
  onChange: (ct: ChartType) => void;
}

export default function ChartTypeMenu({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Which type's description is showing in the gold strip (hover, else current).
  const [hover, setHover] = useState<ChartType | null>(null);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!q) return CHART_TYPE_GROUPS;
    return CHART_TYPE_GROUPS
      .map((g) => ({
        ...g,
        types: g.types.filter(
          (t) =>
            t.label.toLowerCase().includes(q) ||
            t.chartType.toLowerCase().includes(q) ||
            t.desc.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.types.length > 0);
  }, [q]);

  const descType: ChartType = hover ?? value;

  const select = (ct: ChartType) => {
    onChange(ct);
    setOpen(false);
    setQuery('');
  };

  const tile = (t: ChartTypeInfo) => {
    const active = t.chartType === value;
    return (
      <button
        key={t.chartType}
        type="button"
        onClick={() => select(t.chartType)}
        onMouseEnter={(e) => {
          setHover(t.chartType);
          if (!active) e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,0.06))';
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.background = 'transparent';
        }}
        title={t.label}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '10px 4px 8px',
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1.15,
          textAlign: 'center',
          color: active ? EMERALD : 'var(--dim, #8b8f98)',
          background: active ? 'rgba(15,157,88,0.12)' : 'transparent',
          border: `1px solid ${active ? 'rgba(15,157,88,0.55)' : 'var(--edge, #2a2e39)'}`,
          borderLeft: active ? `3px solid ${GOLD}` : `1px solid ${'var(--edge, #2a2e39)'}`,
          borderRadius: 8,
          cursor: 'pointer',
          transition: 'background 120ms, border-color 120ms, color 120ms',
        }}
      >
        <ChartTypeGlyph type={t.chartType} size={20} />
        <span>{t.label}</span>
      </button>
    );
  };

  const groupLabelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--dim, #8b8f98)',
    margin: '12px 0 6px',
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery('');
          setHover(null);
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Chart / bar style"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 28,
            padding: '0 9px',
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1,
            color: 'var(--text, #e6e6e6)',
            background: 'var(--panel, #1b1d22)',
            border: `1px solid ${open ? EMERALD : 'var(--edge, #2a2e39)'}`,
            borderRadius: 6,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          <span style={{ display: 'inline-flex', color: EMERALD }}>
            <ChartTypeGlyph type={value} size={16} />
          </span>
          <span>{chartTypeLabel(value)}</span>
          <ChevronDown size={12} style={{ opacity: 0.7 }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          style={{
            zIndex: 400,
            width: 320,
            background: 'var(--panel, #14181c)',
            border: `1px solid rgba(15, 157, 88, 0.4)`,
            borderRadius: 10,
            boxShadow: '0 14px 44px var(--shadow, rgba(0,0,0,0.55))',
            color: 'var(--text, #e6e6e6)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '80vh',
          }}
        >
          {/* Search */}
          <div style={{ padding: '10px 12px 4px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 9px',
                background: 'var(--bg, #0f1216)',
                border: '1px solid var(--edge, #2a2e39)',
                borderRadius: 6,
              }}
            >
              <Search size={13} style={{ opacity: 0.6, flexShrink: 0 }} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chart types…"
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: 'var(--text, #e6e6e6)',
                  fontSize: 13,
                }}
              />
            </div>
          </div>

          {/* Grouped tiles */}
          <div style={{ overflowY: 'auto', padding: '0 12px 8px' }}>
            {groups.length === 0 && (
              <div style={{ padding: '18px 4px', fontSize: 12, color: 'var(--dim, #8b8f98)' }}>
                No chart types match “{query}”.
              </div>
            )}
            {groups.map((g, gi) => (
              <div key={g.label}>
                <div style={gi === 0 ? { ...groupLabelStyle, marginTop: 8 } : groupLabelStyle}>
                  {g.label}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                  {g.types.map((t) => tile(t))}
                </div>
              </div>
            ))}
          </div>

          {/* Gold live description strip */}
          <div
            style={{
              borderTop: '1px solid var(--edge, #2a2e39)',
              padding: '9px 12px',
              background: 'rgba(212,175,55,0.06)',
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 700, color: GOLD, marginBottom: 2 }}>
              {chartTypeLabel(descType)}
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--dim, #b9bdc6)' }}>
              {chartTypeDesc(descType)}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
