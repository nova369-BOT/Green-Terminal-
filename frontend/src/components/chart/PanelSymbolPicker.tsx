// ============================================================================
// PanelSymbolPicker.tsx — compact per-panel symbol changer for the multi grid.
//
// cTrader lets you retarget any chart in a grid to a different instrument from
// the pane itself. GT's grid previously required a sidebar/search pick that
// only landed on the selected pane; this control puts the change on the pane.
//
// It is deliberately provider-agnostic: the user types a symbol (or picks a
// recent / suggested one) and it is applied verbatim to the local engine fetch,
// so it works for every dataset without needing the shell's symbol catalogue
// wired into the React bundle.
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Search } from 'lucide-react';

const EMERALD = '#0f9d58';
const RECENTS_KEY = 'lset-panel-recent-symbols';

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(sym: string) {
  try {
    const next = [sym, ...loadRecents().filter((s) => s !== sym)].slice(0, 8);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* session-only if storage is blocked */
  }
}

interface Props {
  value: string;
  onChange: (symbol: string) => void;
  /** Extra symbols to offer (e.g. the shell's charted pair + other panes). */
  suggestions?: string[];
  compact?: boolean;
}

export default function PanelSymbolPicker({ value, onChange, suggestions = [], compact }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      // Focus after the popover has mounted.
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
  }, [open]);

  const options = useMemo(() => {
    const seen = new Set<string>();
    const all = [...suggestions.map((s) => (s || '').toUpperCase()), ...loadRecents()]
      .map((s) => (s || '').toUpperCase().trim())
      .filter((s) => s && s !== value.toUpperCase() && !seen.has(s) && (seen.add(s), true));
    const q = query.toUpperCase().trim();
    return q ? all.filter((s) => s.includes(q)) : all;
  }, [suggestions, value, query]);

  const commit = (raw: string) => {
    const sym = (raw || '').toUpperCase().trim();
    if (!sym) return;
    pushRecent(sym);
    onChange(sym);
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
            width: 220,
            background: 'var(--panel, #14181c)',
            border: '1px solid rgba(15, 157, 88, 0.35)',
            borderRadius: 10,
            boxShadow: '0 14px 44px var(--shadow, rgba(0,0,0,0.55))',
            color: 'var(--text, #e6e6e6)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '9px 11px',
              borderBottom: '1px solid var(--edge, #2a2e39)',
            }}
          >
            <Search size={14} style={{ color: 'var(--dim, #8b8f98)' }} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(query || options[0] || '');
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="Symbol… (Enter)"
              spellCheck={false}
              autoCapitalize="characters"
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'inherit',
                font: 'inherit',
                fontSize: 13,
                textTransform: 'uppercase',
              }}
            />
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto', padding: '4px 0' }}>
            {options.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--dim, #8b8f98)' }}>
                {query ? 'Press Enter to apply' : 'Type a symbol'}
              </div>
            )}
            {options.map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => commit(sym)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,0.06))';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 12px',
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: 13,
                  fontWeight: 600,
                  textAlign: 'left',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {sym}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
