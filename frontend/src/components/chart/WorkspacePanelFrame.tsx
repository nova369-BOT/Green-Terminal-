import React, { useState } from 'react';
import { WORKSPACE_COLUMNS, WORKSPACE_ROWS, type WidgetRect } from '@/lib/workspaceLayout';
import { dragRect, resizeRect } from '@/lib/workspaceInteractions';
import { LINK_GROUP_COLORS, type WorkspaceWidget } from '@/lib/workspaceWidgets';

/**
 * The one panel chrome every workspace widget wears: a draggable header with
 * symbol/timeframe, link toggles, minimize, maximize, and close controls; a
 * content body; and a resize grip. Gestures never mutate the widget directly:
 * they report a ghost rect during the motion and commit once on release, so
 * the expensive chart canvas is not re-rendered on every pointer move.
 */
export default function WorkspacePanelFrame({
  widget,
  gridRef,
  symbol,
  timeframe,
  titleOverride,
  canClose,
  canMinimize = true,
  onGhost,
  onCommitRect,
  onToggleLink,
  onCycleLinkGroup,
  onSymbolCommit,
  onMinimize,
  onMaximize,
  onClose,
  children,
}: {
  widget: WorkspaceWidget;
  gridRef: React.RefObject<HTMLDivElement>;
  symbol: string;
  timeframe: string;
  /** Display title for panes whose role differs from the base widget title
   * (secondary chart panes show "Chart tile"). */
  titleOverride?: string;
  canClose: boolean;
  /** The chart widget cannot minimize: collapsing would unmount the heavy
   * chart engine and its session state. It still drags, resizes, maximizes. */
  canMinimize?: boolean;
  onGhost: (rect: WidgetRect | null) => void;
  onCommitRect: (rect: WidgetRect) => void;
  onToggleLink: (field: 'symbol' | 'timeframe') => void;
  onCycleLinkGroup: () => void;
  /** Double-click the header symbol to set a panel-specific symbol. */
  onSymbolCommit: (value: string) => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const begin = (event: React.PointerEvent, resize: boolean) => {
    if (widget.minimized && resize) return;
    event.preventDefault();
    event.stopPropagation();
    const host = gridRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    const cellWidth = box.width / WORKSPACE_COLUMNS;
    const cellHeight = box.height / WORKSPACE_ROWS;
    const origin = {
      clientX: event.clientX,
      clientY: event.clientY,
      rect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
    };
    let finalRect: WidgetRect = { ...origin.rect };
    const move = (next: PointerEvent) => {
      finalRect = (resize ? resizeRect : dragRect)(origin, {
        clientX: next.clientX,
        clientY: next.clientY,
        cellWidth,
        cellHeight,
      });
      onGhost(finalRect);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      onGhost(null);
      onCommitRect(finalRect);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const effSymbol = widget.symbol || symbol;
  const effTimeframe = widget.timeframe || timeframe;
  const [editingSymbol, setEditingSymbol] = useState(false);
  const [symbolDraft, setSymbolDraft] = useState('');
  const commitSymbol = () => {
    setEditingSymbol(false);
    if (symbolDraft.trim()) onSymbolCommit(symbolDraft);
  };
  const sectionStyle: React.CSSProperties = {
    gridColumn: `${widget.x + 1} / span ${widget.width}`,
    gridRow: widget.minimized ? `${widget.y + 1} / span 1` : `${widget.y + 1} / span ${widget.height}`,
    minWidth: 0,
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    background: '#10171d',
    border: `1px solid ${widget.maximized ? '#2f6f52' : '#2d3b44'}`,
    borderRadius: 6,
    boxShadow: '0 4px 18px #0007',
    zIndex: widget.maximized ? 40 : undefined,
  };

  const displayTitle = titleOverride || widget.title;

  return <section data-widget-id={widget.id} style={sectionStyle}>
    <header
      onPointerDown={(event) => begin(event, false)}
      title={`${displayTitle} · ${effSymbol || 'AUTO'} · ${effTimeframe}${widget.source ? ` · ${widget.source}` : ''}${widget.productType ? ` (${widget.productType})` : ''}`}
      style={headerStyle}
    >
      <strong style={titleStyle}>{displayTitle}</strong>
      {editingSymbol ? <input
        autoFocus
        value={symbolDraft}
        onChange={(event) => setSymbolDraft(event.target.value.toUpperCase())}
        onBlur={commitSymbol}
        onKeyDown={(event) => { if (event.key === 'Enter') commitSymbol(); if (event.key === 'Escape') setEditingSymbol(false); }}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label={`Set ${widget.title} symbol`}
        style={symbolInputStyle}
      /> : <span
        style={metaStyle}
        title={`${effSymbol || 'AUTO'} · ${effTimeframe} — double-click to set this panel's own symbol`}
        onDoubleClick={(event) => { event.stopPropagation(); setSymbolDraft(effSymbol); setEditingSymbol(true); }}
      >{effSymbol || 'AUTO'} · {effTimeframe}</span>}
      <div style={controlsStyle} onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" aria-label={`Link group for ${widget.title}: ${widget.linkGroup || 'none'}`} title={widget.linkGroup ? `Link group ${widget.linkGroup} — synced with other ${widget.linkGroup} panels. Click to cycle.` : 'No link group — follows the chart. Click to join a group.'} onClick={onCycleLinkGroup} style={{ ...controlStyle, color: widget.linkGroup ? LINK_GROUP_COLORS[widget.linkGroup] || '#84949d' : '#5f6e77', fontSize: 13 }}>{widget.linkGroup ? '●' : '○'}</button>
        <button type="button" aria-label={`Toggle symbol link for ${widget.title}`} title={widget.symbolLink === 'linked' ? 'Symbol linked to workspace — click to unlink' : 'Symbol independent — click to link'} onClick={() => onToggleLink('symbol')} style={{ ...controlStyle, color: widget.symbolLink === 'linked' ? '#58d797' : '#5f6e77' }}>S</button>
        <button type="button" aria-label={`Toggle timeframe link for ${widget.title}`} title={widget.timeframeLink === 'linked' ? 'Timeframe linked to workspace — click to unlink' : 'Timeframe independent — click to link'} onClick={() => onToggleLink('timeframe')} style={{ ...controlStyle, color: widget.timeframeLink === 'linked' ? '#58d797' : '#5f6e77' }}>T</button>
        {canMinimize && <button type="button" aria-label={widget.minimized ? `Restore ${widget.title}` : `Minimize ${widget.title}`} title={widget.minimized ? 'Restore panel' : 'Minimize panel'} onClick={onMinimize} style={controlStyle}>{widget.minimized ? '▴' : '—'}</button>}
        <button type="button" aria-label={widget.maximized ? `Restore ${widget.title} size` : `Maximize ${widget.title}`} title={widget.maximized ? 'Restore size' : 'Maximize panel'} onClick={onMaximize} style={controlStyle}>{widget.maximized ? '❐' : '□'}</button>
        {canClose && <button type="button" aria-label={`Close ${widget.title}`} title="Remove panel" onClick={onClose} style={{ ...controlStyle, color: '#84949d' }}>×</button>}
      </div>
    </header>
    {!widget.minimized && <div style={bodyStyle}>{children}</div>}
    {!widget.minimized && !widget.maximized && <button
      type="button"
      aria-label={`Resize ${widget.title}`}
      onPointerDown={(event) => begin(event, true)}
      style={resizeGripStyle}
    />}
  </section>;
}

const headerStyle: React.CSSProperties = {
  height: 28,
  flex: '0 0 28px',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 6px 0 9px',
  background: '#151f26',
  borderBottom: '1px solid #293740',
  cursor: 'grab',
  userSelect: 'none',
  touchAction: 'none',
};
const titleStyle: React.CSSProperties = { color: '#dbe4e9', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' };
const metaStyle: React.CSSProperties = { color: '#778891', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 };
const symbolInputStyle: React.CSSProperties = { flex: 1, minWidth: 40, maxWidth: 140, background: '#0d141a', border: '1px solid #1e9b68', borderRadius: 3, color: '#d8e3e8', fontSize: 10, padding: '2px 5px', textTransform: 'uppercase' };
const controlsStyle: React.CSSProperties = { display: 'flex', gap: 1, flex: '0 0 auto' };
const controlStyle: React.CSSProperties = { border: 0, background: 'transparent', color: '#84949d', cursor: 'pointer', padding: '2px 4px', fontSize: 11, lineHeight: 1 };
const bodyStyle: React.CSSProperties = { flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' };
const resizeGripStyle: React.CSSProperties = {
  position: 'absolute',
  right: 0,
  bottom: 0,
  width: 16,
  height: 16,
  border: 0,
  cursor: 'nwse-resize',
  background: 'linear-gradient(135deg, transparent 50%, #3a4b55 50%, #3a4b55 60%, transparent 60%, transparent 70%, #3a4b55 70%, #3a4b55 80%, transparent 80%)',
  touchAction: 'none',
};
