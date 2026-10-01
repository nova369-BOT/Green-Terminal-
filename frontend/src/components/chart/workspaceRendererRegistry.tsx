import React from 'react';
import type { WorkspaceWidget, WorkspaceWidgetType } from '@/lib/workspaceWidgets';

export type WorkspaceRenderer = (widget: WorkspaceWidget) => React.ReactNode;

/** Explicit renderer registry. Unsupported widgets return a truthful state
 * instead of silently falling back to a chart or invented market data. */
export function createWorkspaceRendererRegistry(slots: Partial<Record<WorkspaceWidgetType, WorkspaceRenderer>>): WorkspaceRenderer {
  return (widget) => slots[widget.type]?.(widget) || <div style={emptyRendererStyle}>
    <strong>{widget.title}</strong>
    <span>Renderer unavailable for the selected provider.</span>
    <small>{widget.source || 'Provider capability not resolved'}</small>
  </div>;
}

const emptyRendererStyle: React.CSSProperties = { height: '100%', display: 'grid', placeContent: 'center', gap: 5, textAlign: 'center', color: '#83939d', fontSize: 11, padding: 16 };
