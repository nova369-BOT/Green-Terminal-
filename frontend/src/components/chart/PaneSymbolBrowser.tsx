// ============================================================================
// PaneSymbolBrowser.tsx — per-pane instrument browser for the multi grid.
//
// Phase 1b. cTrader lets you retarget any chart in a grid to a different
// instrument straight from the pane, and the pop-out is a proper browser:
// a Watchlists tab and an All-symbols tab, a search box, and collapsible
// category groups — not a bare text field. This replaces PanelSymbolPicker
// on the grid panes with that browser, matching the approved mockup
// (design/mockups/phase1b-pane-symbol-browser.png):
//
//   ┌ Watchlists | All symbols ┐   ← two tabs
//   │ 🔍 Search symbols…        │
//   │ ▾ Popular markets         │   ← expanded group
//   │    XAU/USD          Gold  │
//   │    EUR/USD  Euro / Dollar │   ← active row: gold left edge + emerald fill
//   │ ▸ Metals · Energies · …   │   ← collapsed category groups
//   └───────────────────────────┘
//
// Data is honest and provider-adaptive:
//   • All symbols  → GET /api/instruments?provider=<active>&limit=5000,
//                    grouped by each instrument's own `category`. Every row
//                    listed is one the engine can serve, so no pick errors.
//   • Watchlists   → window.__lseShell.getWatchlists() (the active provider's
//                    saved lists). Absent bundle/shell → a plain empty state.
//   • Popular      → the active watchlist's symbols, else the provider's first
//                    few catalog entries (its featured instruments). Labelled
//                    "Popular markets" for quick access, never faked prices.
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, ChevronRight, Search, Star, List } from 'lucide-react';
import { getEngineContext } from '@/lib/localEngine';

const EMERALD = '#0f9d58';
const GOLD = '#d4af37';
const POPULAR = 'Popular markets';

interface Instrument {
  symbol: string;
  name: string;
  category: string;
  live: boolean;
}

interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
}

type Tab = 'watchlists' | 'all';

interface Props {
  value: string;
  onChange: (symbol: string) => void;
  compact?: boolean;
}

// One catalog fetch per provider, shared across every pane that opens the
// browser (the grid can show up to eight). Cleared implicitly on reload.
const catalogCache = new Map<string, Instrument[]>();

async function fetchCatalog(provider: string): Promise<Instrument[]> {
  if (!provider) return [];
  const cached = catalogCache.get(provider);
  if (cached) return cached;
  try {
    const r = await fetch(`/api/instruments?provider=${encodeURIComponent(provider)}&limit=5000`);
    if (!r.ok) return [];
    const rows = await r.json();
    const list: Instrument[] = Array.isArray(rows)
      ? rows
          .filter((x) => x && typeof x.symbol === 'string')
          .map((x) => ({
            symbol: String(x.symbol),
            name: String(x.name || x.symbol),
            category: String(x.category || 'Other'),
            live: x.live !== false,
          }))
      : [];
    catalogCache.set(provider, list);
    return list;
  } catch {
    return [];
  }
}

// The shell owns the saved watchlists (per provider). It exposes them through
// the __lseShell bridge; a bundle running without the shell just gets none.
function readWatchlists(): Watchlist[] {
  try {
    const shell = (window as any).__lseShell;
    if (shell && typeof shell.getWatchlists === 'function') {
      const w = shell.getWatchlists();
      if (Array.isArray(w)) {
        return w
          .filter((l: any) => l && Array.isArray(l.symbols))
          .map((l: any) => ({
            id: String(l.id || l.name || 'wl'),
            name: String(l.name || 'Watchlist'),
            symbols: l.symbols.filter((s: any) => typeof s === 'string'),
          }));
      }
    }
  } catch {
    /* no shell bridge in this context */
  }
  return [];
}

interface Group {
  key: string;
  label: string;
  rows: Instrument[];
}

export default function PaneSymbolBrowser({ value, onChange, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<Instrument[]>([]);
  const [loading, setLoading] = useState(false);
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const upper = value.toUpperCase();

  // Load the catalog + watchlists whenever the browser opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const t = setTimeout(() => inputRef.current?.focus(), 25);
    setWatchlists(readWatchlists());
    const provider = getEngineContext().provider;
    let alive = true;
    setLoading(true);
    fetchCatalog(provider)
      .then((list) => {
        if (alive) setCatalog(list);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open]);

  // Symbol → display name, for enriching watchlist rows (which carry only ids).
  const nameBy = useMemo(() => {
    const m = new Map<string, Instrument>();
    for (const i of catalog) m.set(i.symbol.toUpperCase(), i);
    return m;
  }, [catalog]);

  const q = query.trim().toUpperCase();
  const matches = (i: Instrument) =>
    !q || i.symbol.toUpperCase().includes(q) || i.name.toUpperCase().includes(q);

  // ── All-symbols groups: Popular first, then one group per category ────────
  const allGroups = useMemo<Group[]>(() => {
    const groups: Group[] = [];

    // Popular = active watchlist symbols (resolved against the catalog), else
    // the provider's first few catalog entries (its featured instruments).
    const wlSyms = watchlists[0]?.symbols ?? [];
    let popular: Instrument[] = wlSyms
      .map((s) => nameBy.get(s.toUpperCase()))
      .filter((x): x is Instrument => !!x);
    if (popular.length === 0) popular = catalog.slice(0, 6);
    const popularRows = popular.filter(matches);
    if (popularRows.length) groups.push({ key: POPULAR, label: POPULAR, rows: popularRows });

    // Category groups, in the catalog's own order of first appearance.
    const order: string[] = [];
    const byCat = new Map<string, Instrument[]>();
    for (const i of catalog) {
      if (!matches(i)) continue;
      const c = i.category || 'Other';
      if (!byCat.has(c)) {
        byCat.set(c, []);
        order.push(c);
      }
      byCat.get(c)!.push(i);
    }
    for (const c of order) groups.push({ key: c, label: c, rows: byCat.get(c)! });
    return groups;
  }, [catalog, watchlists, nameBy, q]);

  // ── Watchlists groups: one per saved list ─────────────────────────────────
  const wlGroups = useMemo<Group[]>(() => {
    return watchlists.map((l) => ({
      key: `wl:${l.id}`,
      label: l.name,
      rows: l.symbols
        .map(
          (s) =>
            nameBy.get(s.toUpperCase()) ?? {
              symbol: s,
              name: '',
              category: l.name,
              live: true,
            },
        )
        .filter(matches),
    }));
  }, [watchlists, nameBy, q]);

  const groups = tab === 'all' ? allGroups : wlGroups;

  // A group is open when: searching (always, to surface hits), it is the
  // Popular group, or the user expanded it. Everything else stays collapsed.
  const defaultOpen = (key: string) => key === POPULAR;
  const openState = (key: string) =>
    collapsed[key] !== undefined ? !collapsed[key] : defaultOpen(key);
  const isOpen = (g: Group) => (q ? true : openState(g.key));
  const toggle = (key: string) =>
    setCollapsed((c) => ({ ...c, [key]: openState(key) })); // collapsed = was-open

  const commit = (sym: string) => {
    const s = (sym || '').trim();
    if (!s) return;
    onChange(s);
    setOpen(false);
  };

  const triggerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    height: compact ? 22 : 26,
    padding: compact ? '0 7px' : '0 9px',
    fontSize: compact ? 11 : 12,
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: 'var(--text, #e6e6e6)',
    background: 'var(--panel, #1b1d22)',
    border: `1px solid ${open ? EMERALD : 'var(--edge, #2a2e39)'}`,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '9px 8px',
    fontSize: 12.5,
    fontWeight: 600,
    color: active ? EMERALD : 'var(--dim, #8b8f98)',
    background: 'transparent',
    border: 'none',
    borderBottom: `2px solid ${active ? EMERALD : 'transparent'}`,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" style={triggerStyle} title="Change instrument">
          <span>{value || '—'}</span>
          <ChevronDown size={compact ? 12 : 13} style={{ opacity: 0.7 }} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          style={{
            zIndex: 400,
            width: 300,
            background: 'var(--panel, #14181c)',
            border: '1px solid rgba(15, 157, 88, 0.4)',
            borderRadius: 10,
            boxShadow: '0 14px 44px var(--shadow, rgba(0,0,0,0.55))',
            color: 'var(--text, #e6e6e6)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '70vh',
          }}
        >
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--edge, #2a2e39)' }}>
            <button type="button" style={tabStyle(tab === 'watchlists')} onClick={() => setTab('watchlists')}>
              <Star size={13} /> Watchlists
            </button>
            <button type="button" style={tabStyle(tab === 'all')} onClick={() => setTab('all')}>
              <List size={13} /> All symbols
            </button>
          </div>

          {/* Search */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              margin: '9px 10px',
              padding: '7px 10px',
              border: '1px solid var(--edge, #2a2e39)',
              borderRadius: 8,
              background: 'var(--bg, #0f1216)',
            }}
          >
            <Search size={14} style={{ color: 'var(--dim, #8b8f98)' }} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter') {
                  const first = groups.find((g) => g.rows.length)?.rows[0];
                  if (first) commit(first.symbol);
                }
              }}
              placeholder="Search symbols…"
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'inherit',
                font: 'inherit',
                fontSize: 13,
              }}
            />
          </div>

          {/* Body */}
          <div style={{ overflowY: 'auto', paddingBottom: 6 }}>
            {loading && (
              <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--dim, #8b8f98)' }}>
                Loading instruments…
              </div>
            )}

            {!loading && tab === 'watchlists' && wlGroups.length === 0 && (
              <div style={{ padding: '14px', fontSize: 12.5, color: 'var(--dim, #8b8f98)', lineHeight: 1.5 }}>
                No watchlists yet. Star instruments from the market watch, or use the
                <b style={{ color: 'var(--text,#e6e6e6)' }}> All symbols </b> tab.
              </div>
            )}

            {!loading &&
              groups.map((g) => {
                const openG = isOpen(g);
                return (
                  <div key={g.key}>
                    <button
                      type="button"
                      onClick={() => toggle(g.key)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        width: '100%',
                        padding: '8px 12px',
                        border: 'none',
                        borderTop: '1px solid var(--edge, #2a2e39)',
                        background: 'var(--panel-2, rgba(255,255,255,0.03))',
                        color: 'var(--text, #e6e6e6)',
                        font: 'inherit',
                        fontSize: 12.5,
                        fontWeight: 700,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      {openG ? <ChevronDown size={14} style={{ opacity: 0.7 }} /> : <ChevronRight size={14} style={{ opacity: 0.7 }} />}
                      <span style={{ flex: 1 }}>{g.label}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--dim, #8b8f98)' }}>{g.rows.length}</span>
                    </button>

                    {openG &&
                      g.rows.map((row) => {
                        const active = row.symbol.toUpperCase() === upper;
                        return (
                          <button
                            key={`${g.key}:${row.symbol}`}
                            type="button"
                            onClick={() => commit(row.symbol)}
                            onMouseEnter={(e) => {
                              if (!active) e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,0.06))';
                            }}
                            onMouseLeave={(e) => {
                              if (!active) e.currentTarget.style.background = 'transparent';
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 10,
                              width: '100%',
                              padding: '7px 12px 7px 18px',
                              border: 'none',
                              borderLeft: active ? `3px solid ${GOLD}` : '3px solid transparent',
                              background: active ? 'rgba(15, 157, 88, 0.22)' : 'transparent',
                              color: 'inherit',
                              font: 'inherit',
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{row.symbol}</span>
                            <span
                              style={{
                                fontSize: 11.5,
                                color: active ? 'var(--text, #e6e6e6)' : 'var(--dim, #8b8f98)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {row.name}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                );
              })}

            {!loading && tab === 'all' && groups.length === 0 && (
              <div style={{ padding: '14px', fontSize: 12.5, color: 'var(--dim, #8b8f98)' }}>
                {q ? 'No symbols match your search.' : 'No instruments available for this provider.'}
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
