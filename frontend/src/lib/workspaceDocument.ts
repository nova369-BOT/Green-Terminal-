import type { WorkspaceWidget } from './workspaceWidgets';

export interface WorkspaceDocument { version: 1; widgets: WorkspaceWidget[]; updatedAt: number; }

export function encodeWorkspace(widgets: WorkspaceWidget[]): string {
  const document: WorkspaceDocument = { version: 1, widgets, updatedAt: Date.now() };
  return JSON.stringify(document);
}

export function decodeWorkspace(raw: string | null): WorkspaceWidget[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (Array.isArray(value)) return value as WorkspaceWidget[];
    if (value && typeof value === 'object' && (value as WorkspaceDocument).version === 1 && Array.isArray((value as WorkspaceDocument).widgets)) return (value as WorkspaceDocument).widgets;
  } catch { /* corrupt workspace state is handled by the caller */ }
  return null;
}
