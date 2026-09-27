import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { X, GripVertical, Palette, Crosshair, SlidersHorizontal, Plus, Trash2 } from 'lucide-react';
import { AdvancedColorPicker } from './AdvancedColorPicker';
import type { Drawing, ChartPoint } from './ChartDrawingOverlay';

// ---------------------------------------------------------------------------
// Green Terminal — advanced per-drawing settings panel.
// A cohesive teal/emerald, glassy FLOATING panel (no dimming overlay so the
// chart stays visible and every edit applies live) with Style / Coordinates /
// Visibility tabs, per-level customization for level tools (Gann Box,
// Fibonacci), and a working template system. Deliberately distinct from
// TradingView's look.
// ---------------------------------------------------------------------------

export type LevelStyle = { value: number; visible: boolean; color: string };

interface DrawingSettingsDialogProps {
  drawing: Drawing;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdateDrawing: (id: string, updates: Partial<Drawing>) => void;
}

const LINE_STYLES: { id: 'solid' | 'dashed' | 'dotted'; label: string; dash?: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'dashed', label: 'Dashed', dash: '7,4' },
  { id: 'dotted', label: 'Dotted', dash: '2,4' },
];

// Default level maps must match the renderer defaults in ChartDrawingOverlay.
const GANN_DEFAULT_VALUES = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
const GANN_DEFAULT_COLORS = ['#64748b', '#22d3ee', '#2dd4bf', '#34d399', '#2dd4bf', '#22d3ee', '#64748b'];
const FIB_DEFAULT_VALUES = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

const FILL_TYPES = new Set<string>([
  'rectangle', 'square', 'circle', 'oval', 'triangle', 'freeTriangle', 'parallelogram',
  'octagon', 'diamond', 'pentagon', 'hexagon', 'star', 'cross', 'arrowBlock', 'wedge',
  'heart', 'parallelChannel', 'flatChannel', 'splitChannel', 'long', 'short', 'gannBox',
  'pitchfork', 'schiff', 'modifiedSchiff', 'innerFork',
]);
const INLINE_LABEL_TYPES = new Set<string>(['trend', 'line', 'rectangle']);
const TEXT_TYPES = new Set<string>(['text', 'note', 'callout', 'signpost', 'priceLabel']);
const LEVEL_TYPES = new Set<string>(['gannBox', 'fibonacci', 'fibExtension']);
const LINE_EXTEND_TYPES = new Set<string>(['trend', 'line', 'ray', 'trendRay', 'extendedLine', 'straightArrow', 'infoLine']);

const TYPE_LABELS: Record<string, string> = {
  gannBox: 'Gann Box', gannSquare: 'Gann Square', gannFan: 'Gann Fan', gannSquareFixed: 'Gann Square Fixed',
  fibonacci: 'Fib Retracement', fibExtension: 'Fib Extension', fibFan: 'Fib Speed Fan', fibChannel: 'Fib Channel',
  trend: 'Trend Line', trendRay: 'Ray', line: 'Line', parallelChannel: 'Parallel Channel', splitChannel: 'Split Channel',
  rectangle: 'Rectangle', square: 'Rectangle', circle: 'Circle', oval: 'Ellipse', triangle: 'Triangle',
  pitchfork: 'Pitchfork', schiff: 'Schiff Pitchfork', modifiedSchiff: 'Modified Schiff', innerFork: 'Inner Fork',
  cyclicLines: 'Cyclic Lines', sineLine: 'Sine Line', timeArcs: 'Time Arcs', regressionTrend: 'Regression Trend',
  long: 'Long Position', short: 'Short Position', text: 'Text', note: 'Note', callout: 'Callout',
  anchoredVolumeProfile: 'Anchored Volume Profile', anchoredVwap: 'Anchored VWAP',
};

const TEMPLATES_KEY = 'gt-drawing-templates';

type StylePreset = {
  color?: string;
  opacity?: number;
  strokeWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  fillColor?: string | null;
  fillOpacity?: number;
  useOneColor?: boolean;
  textColor?: string;
  textFontSize?: number;
};

const loadTemplates = (): Record<string, StylePreset> => {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
};
const saveTemplates = (t: Record<string, StylePreset>) => {
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(t)); } catch { /* ignore */ }
};

const toLocalInput = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (s: string): number => {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : Date.now();
};

// A compact color swatch that opens the shared AdvancedColorPicker.
const ColorSwatch = ({ value, onChange, opacity, onOpacityChange, showOpacity, title }: {
  value: string; onChange: (v: string) => void; opacity?: number;
  onOpacityChange?: (v: number) => void; showOpacity?: boolean; title?: string;
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <button
        type="button"
        title={title}
        className="h-6 w-6 rounded-md border border-white/15 shadow-inner transition-transform hover:scale-110"
        style={{ backgroundColor: value }}
      />
    </PopoverTrigger>
    <PopoverContent className="w-auto p-0 border-0 bg-transparent shadow-xl z-[10000]" side="left" align="start">
      <AdvancedColorPicker
        value={value}
        onChange={onChange}
        showOpacity={!!showOpacity}
        opacity={opacity ?? 100}
        onOpacityChange={onOpacityChange}
      />
    </PopoverContent>
  </Popover>
);

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-3 py-1.5">
    <span className="text-[12px] text-slate-300">{label}</span>
    <div className="flex items-center gap-2">{children}</div>
  </div>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div className="mt-3 mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-teal-300/70">{children}</div>
);

export const DrawingSettingsDialog = ({ drawing, open, onOpenChange, onUpdateDrawing }: DrawingSettingsDialogProps) => {
  const type = drawing.type || '';
  const hasFill = FILL_TYPES.has(type);
  const hasText = TEXT_TYPES.has(type) || INLINE_LABEL_TYPES.has(type);
  const isLevelTool = LEVEL_TYPES.has(type);
  const isFib = type === 'fibonacci' || type === 'fibExtension';
  const isGannBox = type === 'gannBox';
  const canExtendLine = LINE_EXTEND_TYPES.has(type);
  const isParallelChannel = type === 'parallelChannel';
  const isLongShort = type === 'long' || type === 'short';
  const isFreehand = (drawing.points?.length || 0) > 6 || type === 'brush' || type === 'highlighter';

  // Snapshot for Cancel/revert.
  const snapshotRef = useRef<Drawing | null>(null);
  useEffect(() => {
    if (open) snapshotRef.current = JSON.parse(JSON.stringify(drawing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, drawing.id]);

  const [templates, setTemplates] = useState<Record<string, StylePreset>>({});
  const [templateName, setTemplateName] = useState('');
  useEffect(() => { if (open) setTemplates(loadTemplates()); }, [open]);

  // Draggable position (starts on the right so the chart stays visible).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const h = typeof window !== 'undefined' ? window.innerHeight : 800;
    setPos({ x: Math.max(12, w - 412), y: Math.max(12, h / 2 - 260) });
  }, [open]);
  useEffect(() => {
    if (!dragRef.current) return;
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({ x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy });
    };
    const up = () => { dragRef.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  });

  const update = (u: Partial<Drawing>) => onUpdateDrawing(drawing.id, u);

  const color = drawing.color || '#2dd4bf';
  const opacity = drawing.opacity ?? 100;
  const strokeWidth = drawing.strokeWidth ?? 2;
  const lineStyle = drawing.lineStyle || 'solid';
  const fillColor = drawing.fillColor || '#2dd4bf';
  const fillOpacity = drawing.fillOpacity ?? 20;
  const showLabels = drawing.showLabels !== false;
  const useOneColor = !!drawing.useOneColor;

  // Long/short position sizing readouts (safe when fields are absent).
  const lsEntry = drawing.points?.[0]?.price;
  const lsTarget = drawing.points?.[1]?.price;
  const lsStop = drawing.stopLoss?.price;
  const lsRiskPerUnit = (lsEntry != null && lsStop != null) ? Math.abs(lsEntry - lsStop) : 0;
  const lsReward = (lsEntry != null && lsTarget != null) ? Math.abs(lsTarget - lsEntry) : 0;
  const lsRR = lsRiskPerUnit > 0 ? lsReward / lsRiskPerUnit : 0;
  const lsRiskAmt = (drawing.accountSize && drawing.riskPercent) ? (drawing.accountSize * drawing.riskPercent / 100) : 0;
  const lsSize = (lsRiskAmt > 0 && lsRiskPerUnit > 0) ? lsRiskAmt / lsRiskPerUnit : 0;

  // Effective per-level styles (initialize from defaults when absent).
  const levels: LevelStyle[] = useMemo(() => {
    if (drawing.levelStyles && drawing.levelStyles.length) return drawing.levelStyles;
    if (type === 'gannBox') return GANN_DEFAULT_VALUES.map((v, i) => ({ value: v, visible: true, color: GANN_DEFAULT_COLORS[i] }));
    if (type === 'fibonacci' || type === 'fibExtension') {
      const vals = drawing.fibLevels && drawing.fibLevels.length ? drawing.fibLevels : FIB_DEFAULT_VALUES;
      return vals.map((v) => ({ value: v, visible: true, color }));
    }
    return [];
  }, [drawing.levelStyles, drawing.fibLevels, type, color]);

  const setLevel = (idx: number, patch: Partial<LevelStyle>) => {
    const next = levels.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    update({ levelStyles: next });
  };
  const addLevel = () => {
    // Smart default: fill the next standard Fibonacci value not already present,
    // otherwise extend by +0.618 beyond the current maximum.
    const FIB_SEQUENCE = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236];
    const existing = new Set(levels.map((l) => l.value));
    const nextInSeq = FIB_SEQUENCE.find((v) => !existing.has(v));
    const maxVal = levels.length ? Math.max(...levels.map((l) => l.value)) : 0;
    const val = nextInSeq !== undefined ? nextInSeq : Math.round((maxVal + 0.618) * 1000) / 1000;
    update({ levelStyles: [...levels, { value: val, visible: true, color }] });
  };
  const removeLevel = (idx: number) => {
    update({ levelStyles: levels.filter((_, i) => i !== idx) });
  };

  const title = TYPE_LABELS[type] || 'Drawing';

  const applyPreset = (p: StylePreset) => {
    const u: Partial<Drawing> = {};
    if (p.color !== undefined) u.color = p.color;
    if (p.opacity !== undefined) u.opacity = p.opacity;
    if (p.strokeWidth !== undefined) u.strokeWidth = p.strokeWidth;
    if (p.lineStyle !== undefined) u.lineStyle = p.lineStyle;
    if (p.fillColor !== undefined) u.fillColor = p.fillColor ?? undefined;
    if (p.fillOpacity !== undefined) u.fillOpacity = p.fillOpacity;
    if (p.useOneColor !== undefined) u.useOneColor = p.useOneColor;
    if (p.textColor !== undefined) u.textColor = p.textColor;
    if (p.textFontSize !== undefined) u.textFontSize = p.textFontSize;
    update(u);
  };

  const handleSaveTemplate = () => {
    const name = templateName.trim();
    if (!name) return;
    const preset: StylePreset = {
      color, opacity, strokeWidth, lineStyle,
      fillColor: hasFill ? fillColor : undefined,
      fillOpacity: hasFill ? fillOpacity : undefined,
      useOneColor: isLevelTool ? useOneColor : undefined,
      textColor: hasText ? drawing.textColor : undefined,
      textFontSize: hasText ? drawing.textFontSize : undefined,
    };
    const next = { ...templates, [name]: preset };
    setTemplates(next); saveTemplates(next); setTemplateName('');
  };
  const handleDeleteTemplate = (name: string) => {
    const next = { ...templates }; delete next[name];
    setTemplates(next); saveTemplates(next);
  };

  const handleCancel = () => {
    if (snapshotRef.current) {
      const s = snapshotRef.current;
      update({
        color: s.color, opacity: s.opacity, strokeWidth: s.strokeWidth, lineStyle: s.lineStyle,
        fillColor: s.fillColor, fillOpacity: s.fillOpacity, textColor: s.textColor,
        textFontSize: s.textFontSize, textBold: s.textBold, textItalic: s.textItalic,
        text: s.text, levelStyles: s.levelStyles, useOneColor: s.useOneColor,
        showLabels: s.showLabels, locked: s.locked, points: s.points,
        reverse: s.reverse, extendLeft: s.extendLeft, extendRight: s.extendRight,
        topLabels: s.topLabels, bottomLabels: s.bottomLabels, gannAngles: s.gannAngles,
        fibLabelMode: s.fibLabelMode, showMiddleLine: s.showMiddleLine,
        entryLineColor: s.entryLineColor, accountSize: s.accountSize, riskPercent: s.riskPercent, stopLoss: s.stopLoss,
      });
    }
    onOpenChange(false);
  };

  if (!open || !pos || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed z-[9999] w-[380px] select-none overflow-hidden rounded-xl border border-teal-400/20 bg-[#0b0f14]/95 text-slate-200 shadow-[0_0_40px_-8px_rgba(45,212,191,0.35)] backdrop-blur-xl"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header (drag handle) */}
      <div
        className="flex cursor-grab items-center gap-2 border-b border-white/5 px-4 py-3 active:cursor-grabbing"
        onMouseDown={(e) => { dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }; }}
      >
        <GripVertical className="h-3.5 w-3.5 text-slate-600" />
        <span className="h-2 w-2 rounded-full bg-teal-400 shadow-[0_0_8px_2px_rgba(45,212,191,0.6)]" />
        <span className="text-[14px] font-semibold text-slate-100">{title}</span>
        <span className="ml-auto text-[10px] font-normal uppercase tracking-widest text-slate-500">Inspector</span>
        <button type="button" className="ml-1 text-slate-500 hover:text-slate-200" onClick={() => onOpenChange(false)}><X className="h-4 w-4" /></button>
      </div>

      {/* Green Terminal signature layout: a vertical icon rail on the left
          (deliberately unlike TradingView's top Style/Coordinates/Visibility
          tabs) with our own section names — Look / Anchors / Options. */}
      <Tabs defaultValue="style" orientation="vertical" className="flex w-full items-stretch">
        <TabsList className="flex h-auto flex-col gap-1 rounded-none border-r border-white/5 bg-black/20 p-2">
          <TabsTrigger value="style" className="flex w-[70px] flex-col gap-1 rounded-lg px-1 py-2 text-[10px] font-medium text-slate-400 data-[state=active]:bg-teal-400/15 data-[state=active]:text-teal-200">
            <Palette className="h-4 w-4" /> Look
          </TabsTrigger>
          <TabsTrigger value="coords" className="flex w-[70px] flex-col gap-1 rounded-lg px-1 py-2 text-[10px] font-medium text-slate-400 data-[state=active]:bg-teal-400/15 data-[state=active]:text-teal-200">
            <Crosshair className="h-4 w-4" /> Anchors
          </TabsTrigger>
          <TabsTrigger value="visibility" className="flex w-[70px] flex-col gap-1 rounded-lg px-1 py-2 text-[10px] font-medium text-slate-400 data-[state=active]:bg-teal-400/15 data-[state=active]:text-teal-200">
            <SlidersHorizontal className="h-4 w-4" /> Options
          </TabsTrigger>
        </TabsList>

        <div className="min-w-0 flex-1">
        {/* ---------------- LOOK ---------------- */}
        <TabsContent value="style" className="mt-0 px-4 pb-2">
          <ScrollArea className="h-[320px] pr-3">
            <SectionTitle>Line</SectionTitle>
            <Row label={isLongShort ? 'Profit color' : 'Color'}>
              <ColorSwatch value={color} onChange={(v) => update({ color: v })} showOpacity={!isLongShort} opacity={opacity} onOpacityChange={(v) => update({ opacity: v })} title={isLongShort ? 'Profit color' : 'Line color'} />
            </Row>
            <Row label="Thickness">
              <Slider value={[strokeWidth]} min={1} max={8} step={1} onValueChange={(v) => update({ strokeWidth: v[0] })} className="w-32" />
              <span className="w-6 text-right font-mono text-[11px] text-slate-400">{strokeWidth}</span>
            </Row>
            <Row label="Style">
              <div className="flex gap-1">
                {LINE_STYLES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => update({ lineStyle: s.id })}
                    className={`flex h-7 w-11 items-center justify-center rounded-md border transition-colors ${lineStyle === s.id ? 'border-teal-400/60 bg-teal-400/15' : 'border-white/10 hover:bg-white/5'}`}
                    title={s.label}
                  >
                    <svg width="30" height="8" viewBox="0 0 30 8"><line x1="1" y1="4" x2="29" y2="4" stroke={lineStyle === s.id ? '#2dd4bf' : '#94a3b8'} strokeWidth="2" strokeDasharray={s.dash} strokeLinecap="round" /></svg>
                  </button>
                ))}
              </div>
            </Row>

            {hasFill && (
              <>
                <SectionTitle>Background</SectionTitle>
                {!isLongShort && (
                  <Row label="Fill">
                    <Switch checked={!!drawing.fillColor} onCheckedChange={(c) => update({ fillColor: c ? (drawing.fillColor || fillColor) : undefined })} />
                  </Row>
                )}
                {(isLongShort || !!drawing.fillColor) && (
                  <>
                    <Row label={isLongShort ? 'Stop color' : 'Fill color'}>
                      <ColorSwatch value={fillColor} onChange={(v) => update({ fillColor: v })} showOpacity={!isLongShort} opacity={fillOpacity} onOpacityChange={(v) => update({ fillOpacity: v })} title={isLongShort ? 'Stop color' : 'Fill color'} />
                    </Row>
                    {!isLongShort && (
                      <Row label="Fill opacity">
                        <Slider value={[fillOpacity]} min={0} max={100} step={1} onValueChange={(v) => update({ fillOpacity: v[0] })} className="w-32" />
                        <span className="w-9 text-right font-mono text-[11px] text-slate-400">{fillOpacity}%</span>
                      </Row>
                    )}
                  </>
                )}
              </>
            )}

            {hasText && (
              <>
                <SectionTitle>Text</SectionTitle>
                <Row label="Text color">
                  <ColorSwatch value={drawing.textColor || color} onChange={(v) => update({ textColor: v })} title="Text color" />
                </Row>
                <Row label="Font size">
                  <Slider value={[drawing.textFontSize ?? 14]} min={8} max={48} step={1} onValueChange={(v) => update({ textFontSize: v[0] })} className="w-32" />
                  <span className="w-6 text-right font-mono text-[11px] text-slate-400">{drawing.textFontSize ?? 14}</span>
                </Row>
                <Row label="Bold">
                  <Switch checked={!!drawing.textBold} onCheckedChange={(c) => update({ textBold: c })} />
                </Row>
                <Row label="Italic">
                  <Switch checked={!!drawing.textItalic} onCheckedChange={(c) => update({ textItalic: c })} />
                </Row>
              </>
            )}

            {isLevelTool && (
              <>
                <SectionTitle>{type === 'gannBox' ? 'Levels' : 'Fib Levels'}</SectionTitle>
                <Row label="Use one color">
                  <Switch checked={useOneColor} onCheckedChange={(c) => update({ useOneColor: c })} />
                </Row>
                <div className="mt-1 space-y-1.5">
                  {levels.map((lvl, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5">
                      <Switch checked={lvl.visible} onCheckedChange={(c) => setLevel(i, { visible: c })} />
                      <Input
                        type="number"
                        step="0.001"
                        value={lvl.value}
                        onChange={(e) => setLevel(i, { value: parseFloat(e.target.value) || 0 })}
                        className="h-7 w-16 bg-black/30 font-mono text-[12px]"
                      />
                      <span className="w-11 text-right font-mono text-[10px] text-slate-500">{(lvl.value * 100).toFixed(1)}%</span>
                      {useOneColor ? (
                        <div className="h-6 w-6 rounded-md border border-white/10 opacity-40" style={{ backgroundColor: color }} title="Using one color" />
                      ) : (
                        <ColorSwatch value={lvl.color} onChange={(v) => setLevel(i, { color: v })} title={`Level ${lvl.value} color`} />
                      )}
                      <button type="button" onClick={() => removeLevel(i)} className="ml-auto text-slate-500 transition-colors hover:text-red-400" title="Remove level">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addLevel}
                    className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-teal-400/30 py-1.5 text-[11px] font-medium text-teal-300 transition-colors hover:bg-teal-400/10"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add level
                  </button>
                </div>
              </>
            )}

            {isFib && (
              <>
                <SectionTitle>Fib options</SectionTitle>
                <Row label="Reverse"><Switch checked={!!drawing.reverse} onCheckedChange={(c) => update({ reverse: c })} /></Row>
                <Row label="Extend left"><Switch checked={!!drawing.extendLeft} onCheckedChange={(c) => update({ extendLeft: c })} /></Row>
                <Row label="Extend right"><Switch checked={!!drawing.extendRight} onCheckedChange={(c) => update({ extendRight: c })} /></Row>
                <Row label="Labels">
                  <div className="flex gap-1">
                    {(['percent', 'price', 'both'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => update({ fibLabelMode: m })}
                        className={`rounded-md px-2 py-1 text-[11px] transition-colors ${(drawing.fibLabelMode || 'both') === m ? 'bg-teal-400/15 text-teal-200' : 'text-slate-400 hover:bg-white/5'}`}
                      >
                        {m === 'percent' ? '%' : m === 'price' ? 'Price' : 'Both'}
                      </button>
                    ))}
                  </div>
                </Row>
              </>
            )}

            {isGannBox && (
              <>
                <SectionTitle>Gann options</SectionTitle>
                <Row label="Reverse"><Switch checked={!!drawing.reverse} onCheckedChange={(c) => update({ reverse: c })} /></Row>
                <Row label="Top labels"><Switch checked={drawing.topLabels !== false} onCheckedChange={(c) => update({ topLabels: c })} /></Row>
                <Row label="Bottom labels"><Switch checked={drawing.bottomLabels !== false} onCheckedChange={(c) => update({ bottomLabels: c })} /></Row>
                <Row label="Angles"><Switch checked={!!drawing.gannAngles} onCheckedChange={(c) => update({ gannAngles: c })} /></Row>
              </>
            )}

            {canExtendLine && (
              <>
                <SectionTitle>Line options</SectionTitle>
                <Row label="Extend left"><Switch checked={!!drawing.extendLeft} onCheckedChange={(c) => update({ extendLeft: c })} /></Row>
                <Row label="Extend right"><Switch checked={!!drawing.extendRight} onCheckedChange={(c) => update({ extendRight: c })} /></Row>
              </>
            )}

            {isParallelChannel && (
              <>
                <SectionTitle>Channel options</SectionTitle>
                <Row label="Extend left"><Switch checked={!!drawing.extendLeft} onCheckedChange={(c) => update({ extendLeft: c })} /></Row>
                <Row label="Extend right"><Switch checked={!!drawing.extendRight} onCheckedChange={(c) => update({ extendRight: c })} /></Row>
                <Row label="Middle line"><Switch checked={drawing.showMiddleLine !== false} onCheckedChange={(c) => update({ showMiddleLine: c })} /></Row>
              </>
            )}

            {isLongShort && (
              <>
                <SectionTitle>Position</SectionTitle>
                <Row label="Entry line color">
                  <ColorSwatch value={drawing.entryLineColor || '#94a3b8'} onChange={(v) => update({ entryLineColor: v })} title="Entry line color" />
                </Row>
                <SectionTitle>Prices</SectionTitle>
                <Row label="Entry">
                  <Input type="number" step="any" value={lsEntry ?? 0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isFinite(v)) return; const next = (drawing.points || []).map((p, j) => (j === 0 ? { ...p, price: v } : p)); update({ points: next }); }}
                    className="h-7 w-24 bg-black/30 font-mono text-[12px]" />
                </Row>
                <Row label="Target">
                  <Input type="number" step="any" value={lsTarget ?? 0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isFinite(v)) return; const next = (drawing.points || []).map((p, j) => (j === 1 ? { ...p, price: v } : p)); update({ points: next }); }}
                    className="h-7 w-24 bg-black/30 font-mono text-[12px]" />
                </Row>
                <Row label="Stop">
                  <Input type="number" step="any" value={lsStop ?? 0}
                    onChange={(e) => { const v = parseFloat(e.target.value); if (!Number.isFinite(v) || !drawing.stopLoss) return; update({ stopLoss: { ...drawing.stopLoss, price: v } }); }}
                    className="h-7 w-24 bg-black/30 font-mono text-[12px]" />
                </Row>
                <SectionTitle>Risk sizing</SectionTitle>
                <Row label="Account size">
                  <Input type="number" step="any" value={drawing.accountSize ?? ''} placeholder="10000"
                    onChange={(e) => { const v = parseFloat(e.target.value); update({ accountSize: Number.isFinite(v) ? v : undefined }); }}
                    className="h-7 w-24 bg-black/30 font-mono text-[12px]" />
                </Row>
                <Row label="Risk %">
                  <Input type="number" step="0.1" value={drawing.riskPercent ?? ''} placeholder="1"
                    onChange={(e) => { const v = parseFloat(e.target.value); update({ riskPercent: Number.isFinite(v) ? v : undefined }); }}
                    className="h-7 w-24 bg-black/30 font-mono text-[12px]" />
                </Row>
                <div className="mt-2 space-y-1 rounded-md border border-white/5 bg-white/[0.03] px-3 py-2 text-[11px]">
                  <div className="flex justify-between"><span className="text-slate-400">Risk / Reward</span><span className="font-mono text-teal-300">{lsRR > 0 ? lsRR.toFixed(2) : '\u2014'}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Risk amount</span><span className="font-mono text-slate-200">{lsRiskAmt > 0 ? `$${lsRiskAmt.toFixed(2)}` : '\u2014'}</span></div>
                  <div className="flex justify-between"><span className="text-slate-400">Position size</span><span className="font-mono text-slate-200">{lsSize > 0 ? lsSize.toFixed(2) : '\u2014'}</span></div>
                </div>
              </>
            )}
          </ScrollArea>
        </TabsContent>

        {/* ---------------- COORDINATES ---------------- */}
        <TabsContent value="coords" className="mt-0 px-4 pb-2">
          <ScrollArea className="h-[320px] pr-3">
            {isFreehand ? (
              <div className="flex h-40 items-center justify-center text-center text-[12px] text-slate-500">
                Freehand drawing — coordinates are not individually editable.
              </div>
            ) : (
              <>
                <SectionTitle>Anchor points</SectionTitle>
                {(drawing.points || []).map((pt: ChartPoint, i: number) => (
                  <div key={i} className="mb-3 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
                    <div className="mb-1.5 text-[11px] font-semibold text-slate-400">Point {i + 1}</div>
                    <div className="mb-2">
                      <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-500">Date / Time</label>
                      <Input
                        type="datetime-local"
                        value={toLocalInput(pt.time)}
                        onChange={(e) => {
                          const next = drawing.points.map((p, j) => (j === i ? { ...p, time: fromLocalInput(e.target.value) } : p));
                          update({ points: next });
                        }}
                        className="h-8 bg-black/30 text-[12px]"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-500">Price</label>
                      <Input
                        type="number"
                        step="any"
                        value={pt.price}
                        onChange={(e) => {
                          const next = drawing.points.map((p, j) => (j === i ? { ...p, price: parseFloat(e.target.value) || 0 } : p));
                          update({ points: next });
                        }}
                        className="h-8 bg-black/30 font-mono text-[12px]"
                      />
                    </div>
                  </div>
                ))}
              </>
            )}
          </ScrollArea>
        </TabsContent>

        {/* ---------------- VISIBILITY ---------------- */}
        <TabsContent value="visibility" className="mt-0 px-4 pb-2">
          <ScrollArea className="h-[320px] pr-3">
            <SectionTitle>Object</SectionTitle>
            <Row label="Lock position">
              <Switch checked={!!drawing.locked} onCheckedChange={(c) => update({ locked: c })} />
            </Row>
            <Row label="Object opacity">
              <Slider value={[opacity]} min={0} max={100} step={1} onValueChange={(v) => update({ opacity: v[0] })} className="w-32" />
              <span className="w-9 text-right font-mono text-[11px] text-slate-400">{opacity}%</span>
            </Row>
            {isFib && (
              <Row label="Show labels">
                <Switch checked={showLabels} onCheckedChange={(c) => update({ showLabels: c })} />
              </Row>
            )}
            <SectionTitle>Templates</SectionTitle>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Template name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                className="h-8 flex-1 bg-black/30 text-[12px]"
              />
              <Button size="sm" className="h-8 bg-teal-500/80 text-[12px] text-black hover:bg-teal-400" onClick={handleSaveTemplate}>Save</Button>
            </div>
            {Object.keys(templates).length > 0 && (
              <div className="mt-2 space-y-1">
                {Object.entries(templates).map(([name, preset]) => (
                  <div key={name} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5">
                    <span className="h-4 w-4 rounded-full border border-white/15" style={{ backgroundColor: preset.color || '#2dd4bf' }} />
                    <span className="flex-1 truncate text-[12px] text-slate-300">{name}</span>
                    <button type="button" className="text-[11px] text-teal-300 hover:text-teal-200" onClick={() => applyPreset(preset)}>Apply</button>
                    <button type="button" className="text-[11px] text-slate-500 hover:text-red-400" onClick={() => handleDeleteTemplate(name)}>Delete</button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>
        </div>
      </Tabs>

      <div className="flex items-center justify-end gap-2 border-t border-white/5 px-4 py-3">
        <Button variant="ghost" size="sm" className="text-[12px] text-slate-400 hover:text-slate-200" onClick={handleCancel}>Cancel</Button>
        <Button size="sm" className="bg-teal-500 text-[12px] font-semibold text-black hover:bg-teal-400" onClick={() => onOpenChange(false)}>Done</Button>
      </div>
    </div>,
    document.body,
  );
};

export default DrawingSettingsDialog;
