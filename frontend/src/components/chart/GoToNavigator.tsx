// ============================================================================
// GoToNavigator.tsx — GT "History Navigator" (Phase 2).
//
// A bottom dock over the time axis with quick ranges (1D 5D 1M 3M 6M YTD 1Y 5Y
// All) and a Go-to panel (Date / Range tabs). Its signature — not seen in the
// tools we drew from — is a live OVERVIEW SPARKLINE of the loaded history with a
// draggable gold band, so you see WHERE you are jumping, plus a bars/span
// readout and one-tap First bar / Latest / Today chips.
//
// Honesty (RULE 5): in-range jumps are pure viewport moves (no fetch); a target
// older than the loaded window asks the shell to page a REAL candle window from
// the engine before jumping. A date with no exact bar snaps to the nearest real
// bar and says so — never a fabricated candle. When a quick range reaches past
// the deepest loaded bar (e.g. 5Y on 1h), it frames everything available and
// notes the limit instead of inventing history.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, X } from 'lucide-react';

const EMERALD = '#0f9d58';
const GOLD = '#d4af37';

type Tab = 'date' | 'range';
interface Pt { t: number; c: number } // t = ms epoch, c = close

const PRESETS: { id: string; label: string; ms: number | 'YTD' | 'ALL' }[] = [
  { id: '1D', label: '1D', ms: 86400e3 },
  { id: '5D', label: '5D', ms: 5 * 86400e3 },
  { id: '1M', label: '1M', ms: 30 * 86400e3 },
  { id: '3M', label: '3M', ms: 91 * 86400e3 },
  { id: '6M', label: '6M', ms: 182 * 86400e3 },
  { id: 'YTD', label: 'YTD', ms: 'YTD' },
  { id: '1Y', label: '1Y', ms: 365 * 86400e3 },
  { id: '5Y', label: '5Y', ms: 5 * 365 * 86400e3 },
  { id: 'All', label: 'All', ms: 'ALL' },
];

// ── window bridges (loosely typed; safe no-ops if a method is missing) ───────
const chart = () => (window as any).LSEChart || {};
const shell = () => (window as any).__lseShell || {};
const getCandles = (): Pt[] => {
  try {
    const cs = chart().getLoadedCandles?.() || [];
    return cs.map((c: any) => ({ t: c.time, c: c.close }));
  } catch {
    return [];
  }
};
const series = (): { symbol: string; timeframe: string; provider: string } => {
  try {
    return chart().currentSeries?.() || { symbol: '', timeframe: '', provider: '' };
  } catch {
    return { symbol: '', timeframe: '', provider: '' };
  }
};

// ── time helpers (native inputs are local; index maths is tz-agnostic) ───────
const pad = (n: number) => String(n).padStart(2, '0');
const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const parseLocal = (date: string, time: string): number => {
  if (!date) return NaN;
  const t = time && /^\d{2}:\d{2}/.test(time) ? time : '00:00';
  return new Date(`${date}T${t}`).getTime();
};

function tfSeconds(tf: string): number {
  const s = String(tf || '').trim();
  let m = /^(\d+)\s*([smhdw])$/.exec(s);
  if (m) {
    const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
    return Number(m[1]) * mult[m[2]];
  }
  m = /^(\d+)\s*M$/.exec(s);
  if (m) return Number(m[1]) * 30 * 86400;
  m = /^(\d+)\s*[yY]$/.exec(s);
  if (m) return Number(m[1]) * 365 * 86400;
  return 3600;
}

// first index with t >= target (binary search over ascending times)
function lowerBound(cs: Pt[], targetMs: number): number {
  let lo = 0;
  let hi = cs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cs[mid].t < targetMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function nearest(cs: Pt[], targetMs: number): number {
  if (!cs.length) return 0;
  const i = lowerBound(cs, targetMs);
  if (i <= 0) return 0;
  if (i >= cs.length) return cs.length - 1;
  return Math.abs(cs[i].t - targetMs) < Math.abs(cs[i - 1].t - targetMs) ? i : i - 1;
}

function humanSpan(ms: number): string {
  const d = ms / 86400e3;
  if (d < 1) return `${Math.max(1, Math.round(ms / 3600e3))}h`;
  if (d < 45) return `${Math.round(d)} days`;
  if (d < 365) return `${Math.round(d / 30)} months`;
  const y = d / 365;
  return `${y.toFixed(y < 10 ? 1 : 0)} years`;
}

export default function GoToNavigator() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('date');
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Date tab
  const [dDate, setDDate] = useState('');
  const [dTime, setDTime] = useState('00:00');
  // Range tab
  const [fDate, setFDate] = useState('');
  const [fTime, setFTime] = useState('00:00');
  const [tDate, setTDate] = useState('');
  const [tTime, setTTime] = useState('00:00');

  const [snapshot, setSnapshot] = useState<Pt[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<'from' | 'to' | 'date' | null>(null);

  const meta = series();

  // Seed inputs + overview snapshot when the panel opens.
  useEffect(() => {
    if (!open) return;
    const cs = getCandles();
    setSnapshot(cs);
    setNote('');
    if (cs.length) {
      const last = cs[cs.length - 1].t;
      const first = cs[0].t;
      setDDate(fmtDate(last));
      setDTime(fmtTime(last));
      const from = Math.max(first, last - 90 * 86400e3);
      setFDate(fmtDate(from));
      setFTime(fmtTime(from));
      setTDate(fmtDate(last));
      setTTime(fmtTime(last));
    }
  }, [open]);

  const t0 = snapshot.length ? snapshot[0].t : 0;
  const t1 = snapshot.length ? snapshot[snapshot.length - 1].t : 1;
  const tSpan = Math.max(1, t1 - t0);

  const targetMs = parseLocal(dDate, dTime);
  const fromMs = parseLocal(fDate, fTime);
  const toMs = parseLocal(tDate, tTime);
  const [lo, hi] = fromMs <= toMs ? [fromMs, toMs] : [toMs, fromMs];

  // Readout: bars + span for the current selection.
  const readout = useMemo(() => {
    if (!snapshot.length) return '';
    if (tab === 'date') {
      if (!isFinite(targetMs)) return '';
      return `jump to ${fmtDate(targetMs)}`;
    }
    if (!isFinite(lo) || !isFinite(hi)) return '';
    const a = lowerBound(snapshot, lo);
    const b = Math.min(snapshot.length - 1, lowerBound(snapshot, hi));
    const bars = Math.max(0, b - a + 1);
    return `≈ ${bars.toLocaleString()} bars · ${humanSpan(hi - lo)}`;
  }, [snapshot, tab, targetMs, lo, hi]);

  // ── overview sparkline geometry ────────────────────────────────────────────
  const VW = 1000;
  const VH = 100;
  const poly = useMemo(() => {
    if (snapshot.length < 2) return '';
    const N = Math.min(200, snapshot.length);
    const step = (snapshot.length - 1) / (N - 1);
    let min = Infinity;
    let max = -Infinity;
    const pts: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const idx = Math.round(i * step);
      const c = snapshot[idx].c;
      if (c < min) min = c;
      if (c > max) max = c;
      pts.push([i / (N - 1), c]);
    }
    const rng = max - min || 1;
    return pts
      .map(([x, c]) => `${(x * VW).toFixed(1)},${(VH - ((c - min) / rng) * (VH - 12) - 6).toFixed(1)}`)
      .join(' ');
  }, [snapshot]);

  const xFrac = (ms: number) => Math.max(0, Math.min(1, (ms - t0) / tSpan));
  const msAtFrac = (frac: number) => t0 + Math.max(0, Math.min(1, frac)) * tSpan;

  const applyDragMs = (ms: number) => {
    const snapIdx = nearest(snapshot, ms);
    const snapped = snapshot[snapIdx]?.t ?? ms;
    if (dragRef.current === 'from') {
      setFDate(fmtDate(snapped));
      setFTime(fmtTime(snapped));
    } else if (dragRef.current === 'to') {
      setTDate(fmtDate(snapped));
      setTTime(fmtTime(snapped));
    } else if (dragRef.current === 'date') {
      setDDate(fmtDate(snapped));
      setDTime(fmtTime(snapped));
    }
  };

  const onSvgPointer = useCallback((e: PointerEvent) => {
    if (!dragRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    applyDragMs(msAtFrac(frac));
  }, [snapshot, t0, tSpan]);

  useEffect(() => {
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onSvgPointer);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', onSvgPointer);
      window.removeEventListener('pointerup', up);
    };
  }, [onSvgPointer]);

  const startDrag = (which: 'from' | 'to' | 'date') => (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = which;
    const rect = svgRef.current!.getBoundingClientRect();
    applyDragMs(msAtFrac((e.clientX - rect.left) / rect.width));
  };

  // ── actions ────────────────────────────────────────────────────────────────
  const fit = (a: number, b: number) => chart().fitIndexRange?.(a, b);
  const goIdx = (i: number) => chart().goToIndex?.(i);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    const cs = getCandles();
    if (!cs.length) return;
    const last = cs[cs.length - 1].t;
    let start: number;
    if (p.ms === 'ALL') start = cs[0].t;
    else if (p.ms === 'YTD') {
      const d = new Date(last);
      start = new Date(d.getFullYear(), 0, 1).getTime();
    } else start = last - p.ms;
    const idx = Math.min(cs.length - 1, lowerBound(cs, start));
    fit(idx, cs.length - 1);
    setActivePreset(p.id);
    if (p.ms !== 'ALL' && start < cs[0].t) {
      setNote(`Only ${humanSpan(last - cs[0].t)} loaded at ${meta.timeframe} — showing all of it.`);
    } else setNote('');
  };

  // Ensure the loaded window covers a target time; page a real window if not.
  const ensureCovered = async (aMs: number, bMs: number): Promise<Pt[]> => {
    let cs = getCandles();
    if (cs.length && aMs >= cs[0].t) return cs;
    const fn = shell().loadHistoryWindow;
    if (typeof fn !== 'function') return cs; // no bridge: work with what we have
    setBusy(true);
    try {
      const tf = tfSeconds(meta.timeframe);
      const padS = 200 * tf; // context bars around the window
      const startSec = Math.floor(aMs / 1000) - padS;
      const endSec = Math.floor(bMs / 1000) + padS;
      await fn(startSec, endSec);
      cs = getCandles();
    } catch {
      /* keep current data */
    } finally {
      setBusy(false);
    }
    return cs;
  };

  const doGo = async () => {
    if (tab === 'date') {
      if (!isFinite(targetMs)) return;
      const cs = await ensureCovered(targetMs, targetMs);
      if (!cs.length) return;
      const idx = nearest(cs, targetMs);
      goIdx(idx);
      const diff = Math.abs(cs[idx].t - targetMs);
      setNote(diff > tfSeconds(meta.timeframe) * 1000 ? `Snapped to nearest bar: ${fmtDate(cs[idx].t)} ${fmtTime(cs[idx].t)}` : '');
    } else {
      if (!isFinite(lo) || !isFinite(hi)) return;
      const cs = await ensureCovered(lo, hi);
      if (!cs.length) return;
      const a = lowerBound(cs, lo);
      const b = Math.min(cs.length - 1, lowerBound(cs, hi));
      fit(Math.min(a, b), Math.max(a, b));
      setNote('');
    }
    setActivePreset(null);
    setOpen(false);
  };

  const chip = (label: string, fn: () => void) => (
    <button type="button" onClick={fn} style={chipStyle}>
      {label}
    </button>
  );

  const firstBar = () => {
    const cs = getCandles();
    if (cs.length) fit(0, Math.min(cs.length - 1, 200));
    setOpen(false);
  };
  const latest = () => {
    if (typeof shell().reloadLatest === 'function') shell().reloadLatest();
    else {
      const cs = getCandles();
      if (cs.length) fit(Math.max(0, cs.length - 160), cs.length - 1);
    }
    setActivePreset(null);
    setOpen(false);
  };
  const today = () => {
    const cs = getCandles();
    if (cs.length) goIdx(nearest(cs, Date.now()));
    setOpen(false);
  };

  return (
    <>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 440, background: 'transparent', pointerEvents: 'auto' }}
        />
      )}
      <div style={{ position: 'relative', pointerEvents: 'auto', zIndex: 445 }}>
        {/* ── Go-to panel ── */}
        {open && (
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 10px)',
              right: 0,
              width: 380,
              maxWidth: '92vw',
              background: 'var(--panel, #14181c)',
              border: `1px solid rgba(15,157,88,0.45)`,
              borderRadius: 12,
              boxShadow: '0 18px 50px var(--shadow, rgba(0,0,0,0.6))',
              color: 'var(--text, #e6e6e6)',
              padding: '14px 16px 16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>Go to</div>
                <div style={{ fontSize: 12, color: 'var(--dim, #8b8f98)' }}>
                  {meta.symbol || '—'} · {meta.timeframe || '—'}
                </div>
              </div>
              <button type="button" onClick={() => setOpen(false)} style={iconBtn} title="Close">
                <X size={16} />
              </button>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 20, marginTop: 12, borderBottom: '1px solid var(--edge,#2a2e39)' }}>
              {(['date', 'range'] as Tab[]).map((tk) => (
                <button
                  key={tk}
                  type="button"
                  onClick={() => setTab(tk)}
                  style={{
                    padding: '6px 2px 8px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: `2px solid ${tab === tk ? EMERALD : 'transparent'}`,
                    color: tab === tk ? EMERALD : 'var(--dim,#8b8f98)',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    marginBottom: -1,
                  }}
                >
                  {tk === 'date' ? 'Date' : 'Range'}
                </button>
              ))}
            </div>

            {/* Inputs */}
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {tab === 'date' ? (
                <Row label="">
                  <input type="date" value={dDate} onChange={(e) => setDDate(e.target.value)} style={inputStyle} />
                  <input type="time" value={dTime} onChange={(e) => setDTime(e.target.value)} style={timeStyle} />
                </Row>
              ) : (
                <>
                  <Row label="From">
                    <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} style={inputStyle} />
                    <input type="time" value={fTime} onChange={(e) => setFTime(e.target.value)} style={timeStyle} />
                  </Row>
                  <Row label="To">
                    <input type="date" value={tDate} onChange={(e) => setTDate(e.target.value)} style={inputStyle} />
                    <input type="time" value={tTime} onChange={(e) => setTTime(e.target.value)} style={timeStyle} />
                  </Row>
                </>
              )}
            </div>

            {/* Overview sparkline */}
            {snapshot.length > 1 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--dim,#8b8f98)' }}>history overview</span>
                  {readout && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: GOLD,
                        background: 'rgba(212,175,55,0.12)',
                        border: '1px solid rgba(212,175,55,0.35)',
                        borderRadius: 999,
                        padding: '2px 9px',
                      }}
                    >
                      {readout}
                    </span>
                  )}
                </div>
                <svg
                  ref={svgRef}
                  viewBox={`0 0 ${VW} ${VH}`}
                  preserveAspectRatio="none"
                  style={{ width: '100%', height: 68, display: 'block', touchAction: 'none', cursor: 'ew-resize' }}
                >
                  {/* selection band / marker */}
                  {tab === 'range' ? (
                    <>
                      <rect
                        x={xFrac(lo) * VW}
                        y={0}
                        width={Math.max(1, (xFrac(hi) - xFrac(lo)) * VW)}
                        height={VH}
                        fill="rgba(212,175,55,0.18)"
                        stroke="rgba(212,175,55,0.5)"
                        strokeWidth={1}
                      />
                      <BandHandle x={xFrac(lo) * VW} onDown={startDrag('from')} />
                      <BandHandle x={xFrac(hi) * VW} onDown={startDrag('to')} />
                    </>
                  ) : (
                    isFinite(targetMs) && <BandHandle x={xFrac(targetMs) * VW} onDown={startDrag('date')} line />
                  )}
                  <polyline points={poly} fill="none" stroke="rgba(230,230,230,0.85)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
                </svg>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--dim,#8b8f98)', marginTop: 2 }}>
                  <span>{fmtDate(t0)}</span>
                  <span>{fmtDate(t1)}</span>
                </div>
              </div>
            )}

            {/* Quick chips */}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {chip('First bar', firstBar)}
              {chip('Latest', latest)}
              {chip('Today', today)}
            </div>

            {note && <div style={{ marginTop: 10, fontSize: 11.5, color: GOLD }}>{note}</div>}

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" onClick={() => setOpen(false)} style={outlineBtn}>
                Cancel
              </button>
              <button type="button" onClick={doGo} disabled={busy} style={{ ...emeraldBtn, opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Loading…' : 'Go to'}
              </button>
            </div>
          </div>
        )}

        {/* ── bottom navigator strip ── */}
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '5px 8px',
            background: 'var(--panel, #14181c)',
            border: '1px solid var(--edge,#2a2e39)',
            borderRadius: 999,
            boxShadow: '0 6px 20px var(--shadow, rgba(0,0,0,0.45))',
            color: 'var(--text,#e6e6e6)',
            userSelect: 'none',
          }}
        >
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--dim,#8b8f98)', padding: '0 8px 0 4px' }}>
            History Navigator
          </span>
          {PRESETS.map((p) => {
            const active = activePreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p)}
                style={{
                  minWidth: 34,
                  padding: '4px 8px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: active ? '#fff' : 'var(--text,#e6e6e6)',
                  background: active ? EMERALD : 'transparent',
                  border: 'none',
                  borderRadius: 999,
                  borderBottom: active ? `2px solid ${GOLD}` : '2px solid transparent',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,0.07))';
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent';
                }}
              >
                {p.label}
              </button>
            );
          })}
          <span style={{ width: 1, height: 18, background: 'var(--edge,#2a2e39)', margin: '0 4px' }} />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            title="Go to date / range"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 600,
              color: GOLD,
              background: open ? 'rgba(212,175,55,0.14)' : 'transparent',
              border: 'none',
              borderRadius: 999,
              cursor: 'pointer',
            }}
          >
            <Calendar size={14} /> Go to
          </button>
        </div>
      </div>
    </>
  );
}

// ── small presentational helpers ─────────────────────────────────────────────
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {label ? <span style={{ width: 40, fontSize: 12.5, color: 'var(--dim,#8b8f98)' }}>{label}</span> : null}
      {children}
    </div>
  );
}

function BandHandle({ x, onDown, line }: { x: number; onDown: (e: React.PointerEvent) => void; line?: boolean }) {
  return (
    <g onPointerDown={onDown} style={{ cursor: 'ew-resize' }}>
      {line && <line x1={x} y1={0} x2={x} y2={100} stroke={GOLD} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
      <rect x={x - 8} y={0} width={16} height={100} fill="transparent" />
      <rect x={x - 3} y={38} width={6} height={24} rx={2} fill={GOLD} />
    </g>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '7px 10px',
  fontSize: 13,
  color: 'var(--text,#e6e6e6)',
  background: 'var(--bg,#0f1216)',
  border: '1px solid var(--edge,#2a2e39)',
  borderRadius: 8,
  outline: 'none',
  colorScheme: 'dark',
};
const timeStyle: React.CSSProperties = { ...inputStyle, flex: '0 0 110px' };
const chipStyle: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text,#e6e6e6)',
  background: 'var(--panel-2, rgba(255,255,255,0.05))',
  border: '1px solid var(--edge,#2a2e39)',
  borderRadius: 8,
  cursor: 'pointer',
};
const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  padding: 4,
  background: 'transparent',
  border: 'none',
  color: 'var(--dim,#8b8f98)',
  cursor: 'pointer',
};
const outlineBtn: React.CSSProperties = {
  padding: '7px 16px',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--text,#e6e6e6)',
  background: 'transparent',
  border: '1px solid var(--edge,#2a2e39)',
  borderRadius: 8,
  cursor: 'pointer',
};
const emeraldBtn: React.CSSProperties = {
  padding: '7px 18px',
  fontSize: 13,
  fontWeight: 700,
  color: '#fff',
  background: EMERALD,
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
};
