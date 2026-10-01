import React, { useEffect, useRef, useState } from 'react';
import { applyWorkspacePreset, addWorkspaceWidget, cycleWorkspaceLinkGroup, DEFAULT_WORKSPACE_WIDGETS, propagateWorkspaceLink, removeWorkspaceWidget, setWorkspaceWidgetMinimized, setWorkspaceWidgetSymbol, toggleWorkspaceLink, toggleWorkspaceMaximized, useWorkspaceWidgets, WIDGET_DEFS, type WorkspaceWidgetType } from '@/lib/workspaceWidgets';
import { moveWidget, WORKSPACE_COLUMNS, WORKSPACE_ROWS, type WidgetRect } from '@/lib/workspaceLayout';
import { resolveWidgetCapability } from '@/lib/widgetCapabilities';
import { useCapabilities } from '@/market-data/hooks';
import WorkspacePanelFrame from './WorkspacePanelFrame';
import { UnsupportedPanel, WIDGET_PANELS } from './workspaceWidgetPanels';

export type WorkspacePreset = '1' | '2' | '4' | '16';

const PICKER_GROUPS: Array<{ label: string; types: WorkspaceWidgetType[] }> = [
  { label: 'Charts & flow', types: ['chart', 'footprint', 'heatmap', 'volumeProfile', 'cvdDelta'] },
  { label: 'Market data', types: ['dom', 'orderbook', 'trades', 'marketStats'] },
  { label: 'Trading & tools', types: ['paperTrading', 'watchlist', 'replay'] },
];

/**
 * The native Green Terminal widget workspace. This is the REAL grid surface —
 * not an overlay: a 12x24 persisted grid where the chart itself is one widget
 * among DOM, Trades, Footprint, Heatmap, Volume Profile and CVD panels.
 *
 * Every panel is bound to its persisted rect; drag/resize gestures commit
 * through the collision-safe layout engine; maximize, minimize and restore
 * are persisted; and the 1/2/4/16 presets reposition the actual rendered
 * panels. State survives reload through the versioned workspace document.
 */
export default function NativeWidgetWorkspace({ symbol, timeframe, children }: { symbol: string; timeframe: string; children: React.ReactNode }) {
  const [widgets, update] = useWorkspaceWidgets();
  const { caps } = useCapabilities();
  const gridRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ghost, setGhost] = useState<{ id: string; rect: WidgetRect } | null>(null);

  /* Linked widgets follow the active symbol/timeframe of the chart widget.
   * propagateWorkspaceLink returns the SAME array when nothing changed, and
   * updateWorkspaceWidgets commits nothing on identity — so no render loop. */
  useEffect(() => {
    if (!symbol) return;
    update(previous => {
      const chart = previous.find(widget => widget.type === 'chart');
      return chart ? propagateWorkspaceLink(previous, chart.id, symbol, timeframe) : previous;
    });
  }, [symbol, timeframe, update]);

  /* Close picker/menus on any outside pointer-down. */
  useEffect(() => {
    if (!pickerOpen && !menuOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pickerOpen, menuOpen]);

  const commitRect = (id: string, rect: WidgetRect) => update(previous => moveWidget(previous, id, rect));
  const preset = (value: WorkspacePreset) => { update(previous => applyWorkspacePreset(previous, value)); setMenuOpen(false); };
  const reset = () => { update(() => DEFAULT_WORKSPACE_WIDGETS.map(widget => ({ ...widget, symbol, timeframe }))); setMenuOpen(false); };
  const add = (type: WorkspaceWidgetType) => { update(previous => addWorkspaceWidget(previous, type, symbol, timeframe)); setPickerOpen(false); };

  return (
    <div style={rootStyle}>
      <div ref={toolbarRef} style={toolbarStyle}>
        <button type="button" aria-expanded={pickerOpen} onClick={() => { setPickerOpen(value => !value); setMenuOpen(false); }} style={accentButtonStyle}>
          <span style={{ fontSize: 16, lineHeight: 0 }}>+</span> Widget
        </button>
        <div style={chipRowStyle}>
          {widgets.filter(widget => widget.visible).map(widget => (
            <button
              key={widget.id}
              type="button"
              onClick={() => widget.minimized && update(previous => setWorkspaceWidgetMinimized(previous, widget.id, false))}
              title={`${WIDGET_DEFS[widget.type].description}${widget.minimized ? ' — minimized, click to restore' : ''}`}
              style={{ ...chipStyle, opacity: widget.minimized ? 0.55 : 1 }}
            >
              {widget.title}
            </button>
          ))}
        </div>
        <button type="button" aria-label="Workspace options" aria-expanded={menuOpen} onClick={() => { setMenuOpen(value => !value); setPickerOpen(false); }} style={ghostButtonStyle}>⋮</button>
        {menuOpen && <div style={menuStyle}>
          <div style={menuTitleStyle}>WORKSPACE</div>
          <button type="button" onClick={reset} style={menuItemStyle}>Reset to Chart + DOM + Trades</button>
          <div style={{ ...menuTitleStyle, marginTop: 8 }}>PANEL PRESETS</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, padding: '3px 10px 8px' }}>
            {(['1', '2', '4', '16'] as WorkspacePreset[]).map(value => <button key={value} type="button" onClick={() => preset(value)} style={presetButtonStyle}>{value}</button>)}
          </div>
          <div style={{ ...menuTitleStyle, marginTop: 6 }}>LINKING</div>
          <div style={{ color: '#87939f', fontSize: 11, padding: '3px 10px 9px', lineHeight: 1.5 }}>Panels follow {symbol || 'the active symbol'} and {timeframe} until unlinked (S / T on each panel). The ●/○ dot cycles link groups A · B · C — same-color panels sync with each other.</div>
        </div>}
        {pickerOpen && <div style={pickerStyle}>
          <div style={pickerHeaderStyle}><strong>Add widget</strong><span style={{ color: '#7e8a96', fontSize: 11 }}>Native workspace panels</span></div>
          {PICKER_GROUPS.map(group => (
            <section key={group.label}>
              <div style={groupLabelStyle}>{group.label}</div>
              <div style={pickerGridStyle}>
                {group.types.map(type => {
                  const def = WIDGET_DEFS[type];
                  const exists = Boolean(def.single && widgets.some(widget => widget.type === type && widget.visible));
                  const capability = resolveWidgetCapability(type, caps);
                  const unavailable = capability.availability === 'unavailable';
                  const disabled = exists || unavailable;
                  return (
                    <button type="button" key={type} disabled={disabled} title={exists ? 'Already on the workspace' : capability.reason} onClick={() => add(type)} style={{ ...pickerItemStyle, opacity: disabled ? 0.42 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
                      <span style={iconStyle}>{iconFor(type)}</span>
                      <span><b>{def.title}</b><small style={{ display: 'block', color: '#83939d', fontSize: 10, lineHeight: 1.35 }}>{def.description}</small><em style={capabilityTextStyle}>{exists ? 'On workspace' : capability.availability === 'unknown' ? 'Capability pending' : capability.availability}</em></span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>}
      </div>

      <div ref={gridRef} data-workspace-grid style={gridStyle}>
        {widgets.filter(widget => widget.visible).map(widget => (
          <WorkspacePanelFrame
            key={widget.id}
            widget={widget}
            gridRef={gridRef}
            symbol={symbol}
            timeframe={timeframe}
            canClose={widget.type !== 'chart'}
            canMinimize={widget.type !== 'chart'}
            onGhost={(rect) => setGhost(rect ? { id: widget.id, rect } : null)}
            onCommitRect={(rect) => commitRect(widget.id, rect)}
            onToggleLink={(field) => update(previous => toggleWorkspaceLink(previous, widget.id, field))}
            onCycleLinkGroup={() => update(previous => cycleWorkspaceLinkGroup(previous, widget.id))}
            onSymbolCommit={(value) => update(previous => {
              const changed = setWorkspaceWidgetSymbol(previous, widget.id, value);
              if (changed === previous) return previous;
              // A group member's own symbol drives its whole group; an
              // ungrouped panel stays local (only the chart drives the floor).
              return widget.linkGroup ? propagateWorkspaceLink(changed, widget.id, value.trim().toUpperCase(), widget.timeframe || timeframe) : changed;
            })}
            onMinimize={() => update(previous => setWorkspaceWidgetMinimized(previous, widget.id, !widget.minimized))}
            onMaximize={() => update(previous => toggleWorkspaceMaximized(previous, widget.id))}
            onClose={() => update(previous => removeWorkspaceWidget(previous, widget.id))}
          >
            {widget.type === 'chart'
              ? <div style={chartContentStyle}>{children}</div>
              : (() => {
                  const Panel = WIDGET_PANELS[widget.type] || UnsupportedPanel;
                  return <Panel widget={widget} symbol={symbol} timeframe={timeframe} />;
                })()}
          </WorkspacePanelFrame>
        ))}
        {ghost && <div aria-hidden style={ghostStyle(ghost.rect)} />}
      </div>
    </div>
  );
}

function iconFor(type: WorkspaceWidgetType): string {
  return ({ chart: '▥', footprint: '▤', heatmap: '▦', volumeProfile: '▥', cvdDelta: '∿', dom: '⇅', orderbook: '≋', trades: '≡', marketStats: '◌', paperTrading: '⌁', watchlist: '☆', replay: '↺' } as Record<WorkspaceWidgetType, string>)[type];
}

function ghostStyle(rect: WidgetRect): React.CSSProperties {
  return {
    position: 'absolute',
    left: `${(rect.x / WORKSPACE_COLUMNS) * 100}%`,
    top: `${(rect.y / WORKSPACE_ROWS) * 100}%`,
    width: `${(rect.width / WORKSPACE_COLUMNS) * 100}%`,
    height: `${(rect.height / WORKSPACE_ROWS) * 100}%`,
    border: '1px dashed #42d493',
    borderRadius: 6,
    background: '#42d49314',
    pointerEvents: 'none',
    zIndex: 80,
  };
}

const rootStyle: React.CSSProperties = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#0b1014', overflow: 'hidden' };
const toolbarStyle: React.CSSProperties = { flex: '0 0 34px', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: '1px solid #1c2830', background: '#0d1319', position: 'relative', zIndex: 70 };
const accentButtonStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, background: '#123d2d', border: '1px solid #1e9b68', borderRadius: 5, color: '#7bf0b5', padding: '4px 9px', fontSize: 12, cursor: 'pointer', flex: '0 0 auto' };
const ghostButtonStyle: React.CSSProperties = { border: '1px solid #34404a', borderRadius: 5, background: '#131a20', color: '#b5c0c8', padding: '4px 8px', fontSize: 13, cursor: 'pointer', flex: '0 0 auto' };
const chipRowStyle: React.CSSProperties = { display: 'flex', gap: 4, overflowX: 'auto', flex: 1, minWidth: 0, scrollbarWidth: 'none' };
const chipStyle: React.CSSProperties = { border: '1px solid #29353e', background: '#11181e', borderRadius: 4, color: '#aebbc4', padding: '3px 8px', fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer', flex: '0 0 auto' };
const menuStyle: React.CSSProperties = { position: 'absolute', right: 8, top: 36, width: 230, background: '#10171d', border: '1px solid #33414b', borderRadius: 6, boxShadow: '0 12px 28px #000b', padding: '9px 0', zIndex: 90 };
const menuTitleStyle: React.CSSProperties = { color: '#60717c', fontSize: 10, letterSpacing: '.08em', padding: '0 10px 4px' };
const menuItemStyle: React.CSSProperties = { width: '100%', textAlign: 'left', border: 0, background: 'transparent', color: '#ccd6dc', cursor: 'pointer', padding: '7px 10px', fontSize: 12 };
const presetButtonStyle: React.CSSProperties = { border: '1px solid #2b3942', borderRadius: 3, background: 'transparent', color: '#ccd6dc', cursor: 'pointer', padding: '5px 2px', fontSize: 11, textAlign: 'center' };
const pickerStyle: React.CSSProperties = { position: 'absolute', top: 36, left: 8, width: 372, maxHeight: 'calc(100% - 48px)', overflowY: 'auto', background: '#10171d', border: '1px solid #33414b', borderRadius: 7, boxShadow: '0 14px 40px #000b', padding: '12px 12px 10px', zIndex: 90 };
const pickerHeaderStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', color: '#e1e9ee', padding: '0 2px 10px', fontSize: 13 };
const groupLabelStyle: React.CSSProperties = { color: '#697983', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.08em', padding: '9px 2px 5px' };
const pickerGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 };
const pickerItemStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left', background: '#161f26', border: '1px solid #26343d', borderRadius: 5, color: '#d8e0e5', padding: '8px 7px', fontSize: 12 };
const iconStyle: React.CSSProperties = { color: '#42d493', fontSize: 17, width: 18, textAlign: 'center' };
const capabilityTextStyle: React.CSSProperties = { display: 'block', color: '#71808a', fontSize: 9, fontStyle: 'normal', textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 3 };
const gridStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  position: 'relative',
  display: 'grid',
  gridTemplateColumns: `repeat(${WORKSPACE_COLUMNS}, minmax(0, 1fr))`,
  gridTemplateRows: `repeat(${WORKSPACE_ROWS}, minmax(0, 1fr))`,
  gap: 4,
  padding: 4,
};
const chartContentStyle: React.CSSProperties = { flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' };
