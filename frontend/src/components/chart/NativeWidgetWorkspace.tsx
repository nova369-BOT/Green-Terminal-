import React, { useEffect, useMemo, useRef, useState } from 'react';
import { applyWorkspacePreset, loadWorkspaceWidgets, saveWorkspaceWidgets, type WorkspaceWidget } from '@/lib/workspaceWidgets';
import { moveWidget, normalizeWorkspace, resizeWidget } from '@/lib/workspaceLayout';
import { dragRect, resizeRect } from '@/lib/workspaceInteractions';

export type WorkspacePreset = '1' | '2' | '4' | '16';

/** The actual persisted grid surface. Feed renderers are children/slots; this
 * component owns only geometry, ordering, visibility, and workspace chrome. */
export default function NativeWidgetWorkspace({ symbol, timeframe, children }: { symbol: string; timeframe: string; children: React.ReactNode }) {
  const [widgets, setWidgets] = useState<WorkspaceWidget[]>([]);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; rect: WorkspaceWidget } | null>(null);
  const dragRef = useRef<{ id: string; rect: WorkspaceWidget } | null>(null);
  useEffect(() => setWidgets(loadWorkspaceWidgets()), []);
  const update = (next: WorkspaceWidget[]) => { const normalized = normalizeWorkspace(next); setWidgets(normalized); saveWorkspaceWidgets(normalized); };
  const preset = (value: WorkspacePreset) => update(applyWorkspacePreset(widgets, value));
  const chart = widgets.find(widget => widget.type === 'chart') || { id: 'chart-1', type: 'chart', title: 'Chart', x: 0, y: 0, width: 12, height: 12, visible: true } as WorkspaceWidget;
  const panelStyle = useMemo(() => ({ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridTemplateRows: 'repeat(24, minmax(28px, 1fr))', gap: 3, position: 'relative' as const, width: '100%', height: '100%', minHeight: 0, background: '#0b1014' }), []);
  const begin = (event: React.PointerEvent, widget: WorkspaceWidget, resizing: boolean) => {
    event.preventDefault();
    const host = (event.currentTarget as HTMLElement).closest('[data-workspace-grid]') as HTMLElement | null;
    const box = host?.getBoundingClientRect();
    const cellWidth = (box?.width || 1200) / 12;
    const cellHeight = (box?.height || 720) / 24;
    const origin = { clientX: event.clientX, clientY: event.clientY, rect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height } };
    const move = (next: PointerEvent) => {
      const rect = (resizing ? resizeRect : dragRect)(origin, { clientX: next.clientX, clientY: next.clientY, cellWidth, cellHeight });
      const nextRect = { ...widget, ...rect };
      dragRef.current = { id: widget.id, rect: nextRect };
      setDrag({ id: widget.id, x: rect.x, y: rect.y, rect: nextRect });
    };
    const end = () => {
      const finalRect = dragRef.current?.rect;
      if (finalRect) update(resizing ? resizeWidget(widgets, widget.id, finalRect.width, finalRect.height) : moveWidget(widgets, widget.id, finalRect));
      dragRef.current = null;
      setDrag(null); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
  };
  return <div data-workspace-grid style={panelStyle}>
    <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 100, display: 'flex', gap: 4 }}>
      {(['1', '2', '4', '16'] as WorkspacePreset[]).map(value => <button key={value} type="button" onClick={() => preset(value)} style={presetStyle}>{value}</button>)}
      <span style={workspaceLabel}>{symbol || 'Active symbol'} · {timeframe}</span>
    </div>
    {widgets.filter(widget => widget.visible).map(widget => {
      const rect = drag?.id === widget.id ? drag.rect : widget;
      return <section key={widget.id} style={{ gridColumn: `${rect.x + 1} / span ${rect.width}`, gridRow: `${rect.y + 1} / span ${rect.height}`, minWidth: 0, minHeight: 0, overflow: 'hidden', position: 'relative', border: '1px solid #2d3b44', background: '#10171d' }}>
        <header onPointerDown={event => begin(event, widget, false)} style={headerStyle}><b>{widget.title}</b><span>{widget.symbol || symbol || 'AUTO'} · {widget.timeframe || timeframe}</span></header>
        <div style={{ height: 'calc(100% - 28px)', minHeight: 0, overflow: 'hidden' }}>{widget.id === chart.id ? children : <div style={emptyStyle}>Widget renderer slot<br /><small>Provider data state is controlled by the native widget.</small></div>}</div>
        <button type="button" aria-label={`Resize ${widget.title}`} onPointerDown={event => begin(event, widget, true)} style={resizeHandleStyle} />
      </section>;
    })}
  </div>;
}

const presetStyle: React.CSSProperties = { border: '1px solid #34434d', background: '#131c22e8', color: '#c5d0d6', borderRadius: 3, padding: '3px 7px', fontSize: 10, cursor: 'pointer' };
const workspaceLabel: React.CSSProperties = { color: '#84939c', background: '#10171dcc', padding: '4px 7px', fontSize: 10, borderRadius: 3 };
const headerStyle: React.CSSProperties = { height: 28, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 8px', color: '#d9e2e7', background: '#151f26', borderBottom: '1px solid #293740', fontSize: 11, cursor: 'grab', userSelect: 'none' };
const emptyStyle: React.CSSProperties = { height: '100%', display: 'grid', placeItems: 'center', textAlign: 'center', color: '#71808a', fontSize: 11 };
const resizeHandleStyle: React.CSSProperties = { position: 'absolute', right: 0, bottom: 0, width: 15, height: 15, border: 0, background: 'transparent', cursor: 'nwse-resize' };
