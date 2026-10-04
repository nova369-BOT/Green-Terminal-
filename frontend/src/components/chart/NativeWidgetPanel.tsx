import React from 'react';
import type { WorkspaceWidget } from '@/lib/workspaceWidgets';

export default function NativeWidgetPanel({ widget, children, onClose, onMinimize, onMaximize }: { widget: WorkspaceWidget; children?: React.ReactNode; onClose?: () => void; onMinimize?: () => void; onMaximize?: () => void }) {
  return <div style={panelStyle}>
    <header style={headerStyle}>
      <strong>{widget.title}</strong>
      <span style={metaStyle}>{widget.source || 'AUTO'}{widget.productType ? ` · ${widget.productType}` : ''}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
        {onMinimize && <button type="button" aria-label={`Minimize ${widget.title}`} onClick={onMinimize} style={buttonStyle}>—</button>}
        {onMaximize && <button type="button" aria-label={`Maximize ${widget.title}`} onClick={onMaximize} style={buttonStyle}>□</button>}
        {onClose && <button type="button" aria-label={`Close ${widget.title}`} onClick={onClose} style={buttonStyle}>×</button>}
      </div>
    </header>
    <div style={bodyStyle}>{children || <div style={emptyStyle}>No renderer is active for this widget.</div>}</div>
  </div>;
}
const panelStyle: React.CSSProperties = { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: '#10171d', color: '#d8e1e6' };
const headerStyle: React.CSSProperties = { height: 29, flex: '0 0 29px', display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', background: '#151f26', borderBottom: '1px solid #293740', fontSize: 11 };
const metaStyle: React.CSSProperties = { color: '#778891', fontSize: 9, textTransform: 'uppercase' };
const buttonStyle: React.CSSProperties = { border: 0, background: 'transparent', color: '#84949d', cursor: 'pointer', padding: '2px 5px' };
const bodyStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' };
const emptyStyle: React.CSSProperties = { height: '100%', display: 'grid', placeItems: 'center', color: '#71808a', fontSize: 11, padding: 12, textAlign: 'center' };
