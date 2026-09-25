// Chart drawing rail. A short set, icon only. Not the usual flyout of
// thirty tools. The overlay places the marks; this file only chooses one.

import type { CSSProperties } from 'react';
import type { DrawingTool, Drawing } from '@/components/chart/ChartDrawingOverlay';

interface DrawingToolsPanelProps {
  activeTool?: DrawingTool;
  onToolSelect?: (tool: DrawingTool) => void;
  drawings?: Drawing[];
  onClearAllDrawings?: () => void;
  selectedDrawingId?: string | null;
  onDeleteSelectedDrawing?: (id: string) => void;
  drawingsLocked?: boolean;
  onToggleLock?: () => void;
  drawingsHidden?: boolean;
  onToggleHide?: () => void;
  indicatorCount?: number;
  onClearIndicators?: () => void;
  onOpenShortcutsDialog?: () => void;
  mobileTradingOpen?: boolean;
  onToggleMobileTrading?: () => void;
  bottomPanelHidden?: boolean;
  onToggleBottomPanel?: () => void;
  onOpenSettings?: (tab?: string) => void;
  multiTimeframeLayout?: string;
  onLayoutChange?: (layout: string) => void;
  syncSettings?: unknown;
  onSyncSettingsChange?: (s: unknown) => void;
  layoutSymbol?: string;
  layoutTimeframe?: string;
  layoutDrawings?: unknown[];
  layoutIndicators?: unknown;
  onLoadLayout?: (layout: unknown) => void;
  onOpenSaveDialog?: () => void;
  onToggleCalendar?: () => void;
  calendarPanelActive?: boolean;
  onShowAlertDialog?: () => void;
  alertCount?: number;
}

const TOOLS: { id: DrawingTool; name: string; hint: string; d: string }[] = [
  { id: 'trend', name: 'Line', hint: 'Two clicks. A line between them.', d: 'M4 14 L14 4' },
  { id: 'swing', name: 'Swing', hint: 'Snaps to the nearest swing high or low.', d: 'M3 12h4M11 12h4M9 5v3M9 10v3' },
  { id: 'span', name: 'Span', hint: 'Two clicks. Bars, points, and ranges.', d: 'M3 5v8M15 5v8M3 9h12' },
  { id: 'band', name: 'Band', hint: 'One typical bar of range around this price.', d: 'M3 6h12M3 12h12' },
  { id: 'wound', name: 'Wound', hint: 'How long until that bar is traded back through its open.', d: 'M3 11h8M11 11l2-2M4 7v8' },
  { id: 'streak', name: 'Streak', hint: 'The run of closes this bar belongs to.', d: 'M3 13l3-3 3 2 4-5' },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const btn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  height: 32,
  margin: 0,
  padding: 0,
  border: 'none',
  borderLeft: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dim, #9aa79d)',
  cursor: 'pointer',
};

export default function DrawingToolsPanel({
  activeTool,
  onToolSelect,
  drawings = [],
  onClearAllDrawings,
  selectedDrawingId,
  onDeleteSelectedDrawing,
  drawingsLocked = false,
  onToggleLock,
  drawingsHidden = false,
  onToggleHide,
}: DrawingToolsPanelProps) {
  if (!onToolSelect) return null;

  const pick = (id: DrawingTool) => {
    onToolSelect(activeTool === id ? null : id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: 40, minHeight: 0 }}>
      {TOOLS.map((t) => {
        const on = activeTool === t.id;
        return (
          <button
            key={t.id}
            type="button"
            title={t.name + '. ' + t.hint}
            aria-label={t.name}
            aria-pressed={on}
            onClick={() => pick(t.id)}
            style={{
              ...btn,
              color: on ? 'var(--text, #f4f1e8)' : 'var(--dim, #9aa79d)',
              background: on ? 'var(--hover, transparent)' : 'transparent',
              borderLeftColor: on ? 'var(--accent-bar, #b08d57)' : 'transparent',
            }}
          >
            <Icon d={t.d} />
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      {onToggleHide && (
        <button type="button" title={drawingsHidden ? 'Show drawings' : 'Hide drawings'} aria-label={drawingsHidden ? 'Show drawings' : 'Hide drawings'} onClick={onToggleHide} style={{ ...btn, color: drawingsHidden ? 'var(--text)' : 'var(--dim)' }}>
          <Icon d={drawingsHidden ? 'M3 9h12M6 6l6 6' : 'M3 9c2-3 10-3 12 0-2 3-10 3-12 0z'} />
        </button>
      )}
      {onToggleLock && (
        <button type="button" title={drawingsLocked ? 'Unlock drawings' : 'Lock drawings'} aria-label={drawingsLocked ? 'Unlock drawings' : 'Lock drawings'} onClick={onToggleLock} style={{ ...btn, color: drawingsLocked ? 'var(--accent-bar, #b08d57)' : 'var(--dim)' }}>
          <Icon d="M6 8V6a3 3 0 0 1 6 0v2M5 8h8v7H5z" />
        </button>
      )}
      <button
        type="button"
        title={selectedDrawingId ? 'Remove the selected drawing' : 'Select a drawing first'}
        aria-label="Remove the selected drawing"
        disabled={!selectedDrawingId}
        onClick={() => { if (selectedDrawingId && onDeleteSelectedDrawing) onDeleteSelectedDrawing(selectedDrawingId); }}
        style={{ ...btn, opacity: selectedDrawingId ? 1 : 0.35, cursor: selectedDrawingId ? 'pointer' : 'default' }}
      >
        <Icon d="M5 6h8M7 6V5h4v1M6 6l.6 8h4.8L12 6" />
      </button>
      {drawings.length > 1 && onClearAllDrawings && (
        <button type="button" title={'Remove all ' + drawings.length + ' drawings'} aria-label="Remove all drawings" onClick={onClearAllDrawings} style={btn}>
          <Icon d="M4 9h10" />
        </button>
      )}
    </div>
  );
}
