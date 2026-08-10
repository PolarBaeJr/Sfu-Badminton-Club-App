'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { ScopeSeason } from './season-scope';

/**
 * Pick which season a page is showing.
 *
 * Was a row of chips, one per season. That is fine for three and unusable for
 * a club that has been running five years: the row wraps to several lines,
 * pushes the page content down on every scoped page, and finding a particular
 * term means reading every label.
 *
 * Search matches the name, the term and the year independently, so "2027",
 * "fall" and "fall 27" all find Fall 2027. Worth having because season names
 * sort badly — "Fall 2026" comes before "Spring 2026" alphabetically, which is
 * backwards — so scanning a long list is genuinely slow.
 *
 * The selection lives in the URL rather than in React state: these pages are
 * server components that re-query per season, so it has to survive a
 * navigation, and it makes a particular term a link somebody can send.
 */
export function SeasonSelect({
  seasons,
  selected,
  basePath,
}: {
  seasons: ScopeSeason[];
  selected: ScopeSeason | null;
  /** e.g. "/sessions" — the active season is the bare path, others carry ?season= */
  basePath: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return seasons;
    // Every whitespace-separated word must match somewhere, so "fall 27"
    // narrows rather than widening the way an OR would.
    const words = q.split(/\s+/);
    return seasons.filter((s) => {
      const hay = `${s.name} ${s.start_date ?? ''} ${s.end_date ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [seasons, query]);

  // Reset the highlight whenever the list changes underneath it, or Enter picks
  // whatever happened to be at the old index.
  useEffect(() => setActive(0), [query, open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function choose(s: ScopeSeason) {
    setOpen(false);
    setQuery('');
    router.push(s.active_flag ? basePath : `${basePath}?season=${s.id}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const s = filtered[active];
      if (s) choose(s);
    }
  }

  // Nothing to choose between.
  if (seasons.length < 2) return null;

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--text-primary)] hover:border-[var(--border-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <span className="text-[var(--text-muted)]">Season</span>
        <span className="font-semibold">{selected?.name ?? 'All'}</span>
        {selected?.active_flag && <span className="text-[var(--color-success)]">· now</span>}
        <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-[60] mt-1 w-64 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] shadow-lg"
          role="listbox"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-2.5 py-2">
            <Search className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search seasons…"
              aria-label="Search seasons"
              className="w-full bg-transparent text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
            />
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-[var(--text-muted)]">No season matches that.</p>
            ) : (
              filtered.map((s, i) => {
                const isSelected = s.id === selected?.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(s)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${
                      i === active ? 'bg-[var(--bg-elevated)]' : ''
                    }`}
                  >
                    <Check
                      className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-[var(--color-accent)]' : 'opacity-0'}`}
                    />
                    <span className="flex-1 truncate text-[var(--text-primary)]">{s.name}</span>
                    {s.active_flag && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-success)]">
                        now
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
