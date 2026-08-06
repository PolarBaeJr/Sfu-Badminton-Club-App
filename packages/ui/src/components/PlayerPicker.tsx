'use client';

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { AvatarChip } from './AvatarChip';
import { cn } from '../utils';

const MAX_LIST_HEIGHT = 288;

export interface PlayerOption {
  id: string;
  name: string;
  avatarUrl?: string | null;
  /** Secondary line — email, "has login", etc. Searched as well as displayed,
   *  so an admin can disambiguate two people with the same name by typing the
   *  email instead of the name. */
  meta?: string | null;
  /** Short value pinned to the END of the row — a rating, a seed. Kept out of
   *  `name` so searching cannot match it as if it were part of someone's name,
   *  and out of `meta` because a number reads as a stat beside the name, not as
   *  a subtitle under it. Displayed only; not searched. */
  trailing?: string | null;
}

interface PlayerPickerProps {
  label?: string;
  /** Selected player id, or '' for "nothing chosen yet". */
  value: string;
  onChange: (playerId: string) => void;
  players: PlayerOption[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  id?: string;
  className?: string;
  /** Hides the clear (×) affordance even when the field is optional. */
  clearable?: boolean;
}

const norm = (s: string) => s.toLowerCase().trim();

/** Prefix > word-prefix > substring, so typing "ma" surfaces "Matthew" ahead of
 *  "Roman". Ties keep the caller's order (usually alphabetical). */
function rankOf(option: { name: string }, q: string): number {
  const name = norm(option.name);
  if (name.startsWith(q)) return 0;
  if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  if (name.includes(q)) return 2;
  return 3;
}

/**
 * The picker's matching, on its own so a plain list can filter itself the same
 * way the combobox does — same ranking, same email fallback, same "empty query
 * means everyone". Generic over the row type because a roster row carries a
 * rendered table row alongside its name; only `name` and `meta` are read.
 *
 * Pure and React-free: it is the searching, not the control.
 */
export function filterPlayerOptions<T extends { name: string; meta?: string | null }>(
  options: T[],
  query: string,
): T[] {
  const q = norm(query);
  if (!q) return options;
  return options
    .map((p, i) => ({ p, i, rank: rankOf(p, q) }))
    .filter(({ p, rank }) => rank < 3 || norm(p.meta ?? '').includes(q))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ p }) => p);
}

/**
 * Searchable player combobox: type to filter, avatars to tell similar names
 * apart, arrows/Enter/Escape to drive it from the keyboard.
 *
 * Purely presentational — callers pass the roster they already fetched, so both
 * apps can use it without the component knowing anything about Supabase.
 */
export function PlayerPicker({
  label,
  value,
  onChange,
  players,
  placeholder = 'Search players…',
  required,
  disabled,
  error,
  id,
  className,
  clearable = true,
}: PlayerPickerProps) {
  const reactId = useId();
  const inputId = id || (label ? `${label.toLowerCase().replace(/\s+/g, '-')}-${reactId}` : reactId);
  const listboxId = `${inputId}-listbox`;
  const errorId = `${inputId}-error`;
  const statusId = `${inputId}-status`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => players.find((p) => p.id === value) ?? null, [players, value]);

  const filtered = useMemo(() => filterPlayerOptions(players, query), [players, query]);

  // Opening should land on the current selection, not the top of the roster.
  useEffect(() => {
    if (!open) return;
    const i = filtered.findIndex((p) => p.id === value);
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Any change to the result set invalidates the old index.
  useEffect(() => {
    setActive((a) => (a >= filtered.length ? 0 : a));
  }, [filtered.length]);

  // Fixed positioning escapes the scrollable Dialog these pickers live in, so
  // the list never clips. Anchored to whichever side has more room.
  const [coords, setCoords] = useState<
    { left: number; width: number; maxHeight: number; top?: number; bottom?: number } | null
  >(null);

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const openUp = below < 180 && above > below;
      setCoords({
        left: r.left,
        width: r.width,
        maxHeight: Math.min(MAX_LIST_HEIGHT, Math.max(120, openUp ? above : below)),
        ...(openUp ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      });
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function commit(option: PlayerOption) {
    onChange(option.id);
    close();
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (filtered.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + delta + filtered.length) % filtered.length);
      return;
    }
    if (e.key === 'Home' && open) { e.preventDefault(); setActive(0); return; }
    if (e.key === 'End' && open) { e.preventDefault(); setActive(Math.max(0, filtered.length - 1)); return; }
    if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      const option = filtered[active];
      if (option) commit(option);
      return;
    }
    if (e.key === 'Escape') {
      if (!open) return;
      // Stop here or the surrounding Dialog closes with the list.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab' && open) close();
  }

  const showClear = clearable && !required && !!value && !disabled;

  const list = open && mounted && coords && (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={label ? `${label} options` : 'Players'}
      // Keep focus (and therefore aria-activedescendant) on the input when an
      // option is clicked.
      onMouseDown={(e) => e.preventDefault()}
      className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] overflow-y-auto py-1"
      style={{
        position: 'fixed',
        left: coords.left,
        width: coords.width,
        maxHeight: coords.maxHeight,
        zIndex: 60,
        boxShadow: '0 10px 40px -12px rgba(0,0,0,0.45)',
        ...(coords.top !== undefined ? { top: coords.top } : { bottom: coords.bottom }),
      }}
    >
      {filtered.length === 0 ? (
        <p className="px-3 py-4 text-sm text-[var(--text-muted)] text-center">No players match “{query}”</p>
      ) : (
        filtered.map((p, i) => {
          const isSelected = p.id === value;
          return (
            <div
              key={p.id}
              id={`${inputId}-opt-${i}`}
              data-idx={i}
              role="option"
              aria-selected={isSelected}
              onClick={() => commit(p)}
              onMouseMove={() => setActive(i)}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 cursor-pointer',
                i === active && 'bg-[var(--bg-elevated)]'
              )}
            >
              <AvatarChip name={p.name} id={p.id} src={p.avatarUrl} size="sm" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-[var(--text-primary)] truncate">{p.name}</span>
                {p.meta && <span className="block text-xs text-[var(--text-muted)] truncate">{p.meta}</span>}
              </span>
              {p.trailing && (
                <span className="shrink-0 font-mono text-xs text-[var(--text-muted)] tabular-nums">
                  {p.trailing}
                </span>
              )}
              {isSelected && <Check className="w-4 h-4 shrink-0 text-[var(--color-accent)]" />}
            </div>
          );
        })
      )}
    </div>
  );

  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={inputId} className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
          {label}
          {required && <span className="text-[var(--color-accent)]"> *</span>}
        </label>
      )}

      <div
        ref={wrapRef}
        className={cn(
          'w-full pl-3 pr-2 min-h-[48px] flex items-center gap-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] transition-colors',
          'focus-within:ring-2 focus-within:ring-[var(--color-accent)] focus-within:border-transparent',
          disabled && 'opacity-50 cursor-not-allowed',
          open && 'ring-2 ring-[var(--color-accent)] border-transparent',
          error && 'border-[var(--color-danger)] focus-within:ring-[var(--color-danger)]',
          className
        )}
      >
        {selected ? (
          <AvatarChip name={selected.name} id={selected.id} src={selected.avatarUrl} size="xs" />
        ) : (
          <Search className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
        )}

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open && filtered[active] ? `${inputId}-opt-${active}` : undefined}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          aria-required={required}
          disabled={disabled}
          // Closed, the field reads as the current selection; open, it becomes
          // the search box with the selection kept as ghost text.
          value={open ? query : selected?.name ?? ''}
          placeholder={open ? selected?.name ?? placeholder : placeholder}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => !disabled && setOpen(true)}
          onClick={() => !disabled && setOpen(true)}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-0 bg-transparent py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none disabled:cursor-not-allowed"
        />

        {showClear && (
          <button
            type="button"
            aria-label={label ? `Clear ${label}` : 'Clear selection'}
            onClick={() => { onChange(''); setQuery(''); inputRef.current?.focus(); }}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn('w-4 h-4 shrink-0 mr-1 text-[var(--text-muted)] transition-transform', open && 'rotate-180')}
        />
      </div>

      {/* Screen readers get the result count; sighted users see the list itself. */}
      <p id={statusId} role="status" aria-live="polite" className="sr-only">
        {open ? `${filtered.length} player${filtered.length === 1 ? '' : 's'} available` : ''}
      </p>

      {error && <p id={errorId} className="text-sm text-[var(--color-danger)]">{error}</p>}

      {mounted && list && createPortal(list, document.body)}
    </div>
  );
}
