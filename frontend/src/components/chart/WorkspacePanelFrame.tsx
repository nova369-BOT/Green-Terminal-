import React, { useRef } from 'react';
import type { WidgetRect } from '@/lib/workspaceLayout';
import { dragRect, resizeRect } from '@/lib/workspaceInteractions';

export default function WorkspacePanelFrame({ rect, onRectChange, title, children }: { rect: WidgetRect; onRectChange: (rect: WidgetRect) => void; title: string; children: React.ReactNode }) {
  const start = useRef<{ clientX: number; clientY: number; rect: WidgetRect } | null>(null);
  const begin = (event: React.PointerEvent, resize: boolean) => {
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    start.current = { clientX: event.clientX, clientY: event.clientY, rect: { ...rect } };
    const move = (next: PointerEvent) => {
      if (!start.current) return;
      const host = (event.currentTarget as HTMLElement).parentElement?.parentElement;
      const box = host?.getBoundingClientRect();
      const cellWidth = (box?.width || 1200) / 12;
      const cellHeight = (box?.height || 720) / 24;
      onRectChange((resize ? resizeRect : dragRect)(start.current, { clientX: next.clientX, clientY: next.clientY, cellWidth, cellHeight }));
    };
    const end = () => { start.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
  };
  return <section style={{ gridColumn: `${rect.x + 1} / span ${rect.width}`, gridRow: `${rect.y + 1} / span ${rect.height}`, minWidth: 0, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
    <header onPointerDown={event => begin(event, false)} style={{ cursor: 'grab', userSelect: 'none', height: 28, display: 'flex', alignItems: 'center', padding: '0 8px', background: '#151f26', borderBottom: '1px solid #293740', color: '#d6e0e5', fontSize: 11 }}>{title}</header>
    <div style={{ height: 'calc(100% - 28px)', overflow: 'auto' }}>{children}</div>
    <button type="button" aria-label={`Resize ${title}`} onPointerDown={event => begin(event, true)} style={{ position: 'absolute', right: 1, bottom: 1, width: 14, height: 14, cursor: 'nwse-resize', background: 'transparent', border: 0 }} />
  </section>;
}
