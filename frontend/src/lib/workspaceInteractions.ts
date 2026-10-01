import { clampRect, type WidgetRect } from './workspaceLayout';

export interface PointerStart { clientX: number; clientY: number; rect: WidgetRect; }
export interface PointerDelta { clientX: number; clientY: number; cellWidth: number; cellHeight: number; }

/** Converts pointer movement into grid movement. Kept independent of React so
 * drag and resize gestures can be tested without a browser or DOM. */
export function dragRect(start: PointerStart, delta: PointerDelta): WidgetRect {
  return clampRect({
    ...start.rect,
    x: start.rect.x + Math.round((delta.clientX - start.clientX) / Math.max(1, delta.cellWidth)),
    y: start.rect.y + Math.round((delta.clientY - start.clientY) / Math.max(1, delta.cellHeight)),
  });
}

export function resizeRect(start: PointerStart, delta: PointerDelta): WidgetRect {
  return clampRect({
    ...start.rect,
    width: start.rect.width + Math.round((delta.clientX - start.clientX) / Math.max(1, delta.cellWidth)),
    height: start.rect.height + Math.round((delta.clientY - start.clientY) / Math.max(1, delta.cellHeight)),
  });
}
