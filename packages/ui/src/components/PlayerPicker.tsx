'use client';

import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { AvatarChip } from './AvatarChip';
import { filterPlayerOptions } from '../player-search';
import {
  addSelectedId,
  removeSelectedId,
  selectableOptions,
  selectedOptions,
  toSelectedIds,
  toSingleValue,
} from '../player-selection';
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

interface PlayerPickerBaseProps {
  label?: string;
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

export interface SinglePlayerPickerProps extends PlayerPickerBaseProps {
  /** Absent or false: one player, the original behaviour. */
  multiple?: false;
  /** Selected player id, or '' for "nothing chosen yet". */
  value: string;
  onChange: (playerId: string) => void;
}

export interface MultiPlayerPickerProps extends PlayerPickerBaseProps {
  multiple: true;
  /** Selected player ids, in the order they were picked. */
  value: string[];
  onChange: (playerIds: string[]) => void;
}

/**
 * A discriminated union rather than `value: string | string[]`, so the compiler
 * — not a runtime check, and not a code reviewer — is what stops a `string[]`
 * reaching a picker that means "exactly one person". A challenge opponent and a
 * merge survivor are singular by definition; typing them as "maybe a list"
 * would push that check into every call site.
 *
 * `multiple` must be a LITERAL at the call site for narrowing to work. That is
 * a feature: `multiple={!isDoubles}` is rejected, which forces the two shapes
 * to be written as two elements instead of one element that is quietly both.
 */
export type PlayerPickerProps = SinglePlayerPickerProps | MultiPlayerPickerProps;

/**
 * Searchable player combobox: type to filter, avatars to tell similar names
 * apart, arrows/Enter/Escape to drive it from the keyboard.
 *
 * With `multiple`, the same control becomes a token field: each pick becomes a
 * removable chip, the search box clears itself and stays open, and the people
 * already chosen drop out of the list. An exec adding a dozen people to a
 * session types twelve surnames without ever reaching for the mouse.
 *
 * Purely presentational — callers pass the roster they already fetched, so both
 * apps can use it without the component knowing anything about Supabase.
 */
export function PlayerPicker(props: PlayerPickerProps) {
  const {
    label,
    players,
    placeholder = 'Search players…',
    required,
    disabled,
    error,
    id,
    className,
    clearable = true,
  } = props;

  // Normalise the union ONCE, here. Everything below works on a string[]
  // regardless of mode, which is what keeps the single-select path from
  // acquiring a second set of branches — and keeps `[]` (truthy!) out of the
  // "is anything selected?" tests further down.
  const multiple = props.multiple === true;
  const selectedIds = props.multiple ? props.value : toSelectedIds(props.value);

  function emit(ids: string[]) {
    if (props.multiple) props.onChange(ids);
    else props.onChange(toSingleValue(ids));
  }

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

  const selected = useMemo(
    () => players.find((p) => p.id === selectedIds[0]) ?? null,
    // selectedIds is a fresh array each render; its first entry is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, selectedIds[0]],
  );

  // A stable stand-in for selectedIds in dependency lists.
  const selectionKey = selectedIds.join(',');

  const chips = useMemo(
    () => (multiple ? selectedOptions(players, selectedIds) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, multiple, selectionKey],
  );

  const filtered = useMemo(
    () => filterPlayerOptions(multiple ? selectableOptions(players, selectedIds) : players, query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, query, multiple, selectionKey],
  );

  // Opening should land on the current selection, not the top of the roster.
  // In multi mode the selection is not IN the list, so the top is right.
  useEffect(() => {
    if (!open) return;
    if (multiple) { setActive(0); return; }
    const i = filtered.findIndex((p) => p.id === selectedIds[0]);
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
    // Chips wrap onto new rows as they are added, which GROWS the field without
    // firing scroll or resize. Without this dependency the fixed-position list
    // stays where the field used to end and overlaps it.
  }, [open, selectedIds.length]);

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
    if (multiple) {
      emit(addSelectedId(selectedIds, option.id));
      setQuery('');
      // The row just picked leaves the list, so every index below it shifts up.
      // Without this the highlight lands on whoever moved into the old slot.
      setActive(0);
      setOpen(true);
      inputRef.current?.focus();
      return;
    }
    emit([option.id]);
    close();
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Backspace on an empty query peels off the last chip — the token-field
    // convention, and the only way to undo a mis-click without the mouse.
    if (e.key === 'Backspace' && multiple && query === '' && selectedIds.length > 0) {
      e.preventDefault();
      emit(selectedIds.slice(0, -1));
      return;
    }
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
      // Enter ADDS in multi mode and leaves the list open (commit() handles it),
      // so a run of "surname, Enter, surname, Enter" works. preventDefault stops
      // it submitting the surrounding form on the way.
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

  const hasSelection = selectedIds.length > 0;
  const showClear = clearable && !required && hasSelection && !disabled;

  const emptyMessage = query
    ? `No players match “${query}”`
    : multiple && hasSelection
      ? 'Everyone is already selected'
      : 'No players available';

  const list = open && mounted && coords && (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={label ? `${label} options` : 'Players'}
      aria-multiselectable={multiple ? true : undefined}
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
        <p className="px-3 py-4 text-sm text-[var(--text-muted)] text-center">{emptyMessage}</p>
      ) : (
        filtered.map((p, i) => {
          // Multi mode never lists someone already chosen, so nothing on screen
          // is ever in the selected state — the chips carry that instead.
          const isSelected = !multiple && p.id === selectedIds[0];
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
          // Chips wrap instead of squeezing the search box to nothing.
          multiple && 'flex-wrap gap-1.5 py-1.5',
          disabled && 'opacity-50 cursor-not-allowed',
          open && 'ring-2 ring-[var(--color-accent)] border-transparent',
          error && 'border-[var(--color-danger)] focus-within:ring-[var(--color-danger)]',
          className
        )}
      >
        {multiple ? (
          <>
            {chips.length === 0 && <Search className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />}
            {chips.map((p) => (
              <span
                key={p.id}
                className="flex items-center gap-1.5 pl-1 pr-1 py-0.5 max-w-full rounded-full bg-[var(--bg-elevated)] border border-[var(--border)]"
              >
                <AvatarChip name={p.name} id={p.id} src={p.avatarUrl} size="xs" />
                <span className="text-sm text-[var(--text-primary)] truncate max-w-[10rem]">{p.name}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${p.name}`}
                  onClick={() => { emit(removeSelectedId(selectedIds, p.id)); inputRef.current?.focus(); }}
                  className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors disabled:cursor-not-allowed"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </>
        ) : selected ? (
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
          // Single: closed, the field reads as the current selection; open, it
          // becomes the search box with the selection kept as ghost text.
          // Multi: the chips ARE the selection, so the field is only ever the
          // search box and stays typeable between picks.
          value={multiple ? query : open ? query : selected?.name ?? ''}
          placeholder={
            multiple
              ? chips.length > 0 ? 'Add another…' : placeholder
              : open ? selected?.name ?? placeholder : placeholder
          }
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => !disabled && setOpen(true)}
          onClick={() => !disabled && setOpen(true)}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-[6rem] bg-transparent py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none disabled:cursor-not-allowed"
        />

        {showClear && (
          <button
            type="button"
            aria-label={label ? `Clear ${label}` : 'Clear selection'}
            onClick={() => { emit([]); setQuery(''); inputRef.current?.focus(); }}
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

      {/* Screen readers get the result count; sighted users see the list itself.
          In multi mode the running total matters just as much — the chips are
          the only other place it is stated. */}
      <p id={statusId} role="status" aria-live="polite" className="sr-only">
        {open ? `${filtered.length} player${filtered.length === 1 ? '' : 's'} available` : ''}
        {multiple && hasSelection ? `, ${selectedIds.length} selected` : ''}
      </p>

      {error && <p id={errorId} className="text-sm text-[var(--color-danger)]">{error}</p>}

      {mounted && list && createPortal(list, document.body)}
    </div>
  );
}
