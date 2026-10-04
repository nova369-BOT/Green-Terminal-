import type { WorkspaceWidget } from './workspaceWidgets';

export const WORKSPACE_COLUMNS = 12;
export const WORKSPACE_ROWS = 24;

export interface WidgetRect { x: number; y: number; width: number; height: number; }

export function clampRect(rect: WidgetRect): WidgetRect {
  const width = Math.max(2, Math.min(WORKSPACE_COLUMNS, Math.round(rect.width)));
  const height = Math.max(2, Math.min(WORKSPACE_ROWS, Math.round(rect.height)));
  return {
    width, height,
    x: Math.max(0, Math.min(WORKSPACE_COLUMNS - width, Math.round(rect.x))),
    y: Math.max(0, Math.round(rect.y)),
  };
}

export function overlaps(a: WidgetRect, b: WidgetRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Move a widget and push collisions down instead of silently stacking panels. */
export function moveWidget(widgets: WorkspaceWidget[], id: string, rect: WidgetRect): WorkspaceWidget[] {
  const moved = widgets.map(widget => widget.id === id ? { ...widget, ...clampRect(rect) } : { ...widget });
  const target = moved.find(widget => widget.id === id);
  if (!target) return moved;
  for (const widget of moved) {
    if (widget.id === id || !widget.visible) continue;
    while (overlaps(target, widget)) {
      widget.y = target.y + target.height;
    }
  }
  return moved;
}

export function resizeWidget(widgets: WorkspaceWidget[], id: string, width: number, height: number): WorkspaceWidget[] {
  const target = widgets.find(widget => widget.id === id);
  if (!target) return widgets;
  return moveWidget(widgets, id, { x: target.x, y: target.y, width, height });
}

export function normalizeWorkspace(widgets: WorkspaceWidget[]): WorkspaceWidget[] {
  const result: WorkspaceWidget[] = [];
  for (const widget of widgets) {
    const rect = clampRect(widget);
    const placed = { ...widget, ...rect };
    while (result.some(other => other.visible && placed.visible && overlaps(placed, other))) placed.y += placed.height;
    result.push(placed);
  }
  return result;
}
