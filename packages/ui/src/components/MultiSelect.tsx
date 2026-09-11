'use client';

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, X } from 'lucide-react';
import {
  filterMultiSelectOptions,
  groupMultiSelectOptions,
  identifiedOptions,
  toggleValue,
  type MultiSelectOption,
} from '../multi-select';
import { selectableOptions, selectedOptions } from '../player-selection';
import { cn } from '../utils';

const MAX_LIST_HEIGHT = 288;

export interface MultiSelectProps {
  /**
   * REQUIRED, unlike every other control in this package.
   *
   * `Select` derives its element id from the label text, and that has already
   * collided once: two composers mounted in the same card, both with a field
   * called "Category". A control whose options are groups of arbitrary strings
   * has no better fallback to offer, so the caller says what it is.
   */
  id: string;
  label?: string;
  /** The chosen values, in the order they were picked. */
  value: string[];
  onChange: (values: string[]) => void;
  options: MultiSelectOption[];
  placeholder?: string;
  /** A line under the field. Stated in words what the chips only imply. */
  helpText?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A token multi-select: type to filter, chips for what is chosen, grouped
 * headings for where the options came from.
 *
 * MODELLED ON PlayerPicker'S `multiple` MODE AND NOT BUILT FROM IT. That control
 * is about people: avatar initials to tell two Matthews apart, "No players
 * match", `aria-label="Players"`. Handing it roles shaped as players would make
 * every one of those lie about what is being picked, and the initials in
 * particular would draw a coloured disc per role for no reason.
 *
 * A NATIVE `<select multiple>` IS NOT AN OPTION. On iOS it renders as a
 * scrolling list box with no visible multi-select affordance, and the people who
 * use this are execs on phones.
 *
 * Purely presentational: the caller passes the options it already has, so both
 * apps can use it without the component knowing where they came from.
 */
export function MultiSelect({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = 'Search…',
  helpText,
  disabled,
  className,
}: MultiSelectProps) {
  const listboxId = `${id}-listbox`;
  const statusId = `${id}-status`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A stable stand-in for `value` in dependency lists, which is a fresh array
  // on every render.
  const selectionKey = value.join(',');

  // `id` here is the option's `value`: the two generic helpers in
  // player-selection key on `{ id }`, and adapting is cheaper than a second copy
  // of "hide what is chosen" and "chips in selection order".
  const keyed = useMemo(() => identifiedOptions(options), [options]);

  const chips = useMemo(
    () => selectedOptions(keyed, value),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyed, selectionKey],
  );

  const filtered = useMemo(
    () => filterMultiSelectOptions(selectableOptions(keyed, value), query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyed, query, selectionKey],
  );

  const groups = useMemo(() => groupMultiSelectOptions(filtered), [filtered]);

  /** The flat order the keyboard walks, which is the order the groups draw in. */
  const walkable = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  // Everything picked and nothing typed leaves a single dead line sitting on top
  // of whatever follows the field, which is PlayerPicker's own lesson: there it
  // covered the Add button. Only when there is no query, so a search matching
  // nothing still says so rather than looking like the control died.
  const nothingLeftToPick = filtered.length === 0 && !query;

  useEffect(() => {
    if (nothingLeftToPick) setOpen(false);
  }, [nothingLeftToPick]);

  // Any change to the result set invalidates the old index.
  useEffect(() => {
    setActive((a) => (a >= walkable.length ? 0 : a));
  }, [walkable.length]);

  // Fixed positioning, anchored to whichever side has more room, so the list is
  // never clipped by a scrollable panel around it.
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
    // firing scroll or resize.
  }, [open, value.length]);

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
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  function commit(option: MultiSelectOption) {
    onChange(toggleValue(value, option.value));
    setQuery('');
    // The row just picked leaves the list, so every index below it shifts up.
    setActive(0);
    setOpen(true);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Backspace on an empty query peels off the last chip: the token-field
    // convention, and the only way to undo a mis-click without the mouse.
    if (e.key === 'Backspace' && query === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (walkable.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + delta + walkable.length) % walkable.length);
      return;
    }
    if (e.key === 'Home' && open) {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === 'End' && open) {
      e.preventDefault();
      setActive(Math.max(0, walkable.length - 1));
      return;
    }
    if (e.key === 'Enter') {
      if (!open) return;
      // Enter ADDS and leaves the list open, so a run of "type, Enter, type,
      // Enter" works. preventDefault stops it submitting the surrounding form.
      e.preventDefault();
      const option = walkable[active];
      if (option) commit(option);
      return;
    }
    if (e.key === 'Escape') {
      if (!open) return;
      // BOTH STOPS ARE NEEDED, and the second is the one that keeps a
      // surrounding Dialog open: Dialog.tsx binds Escape on `document`, which a
      // synthetic stopPropagation cannot reach. See PlayerPicker.tsx for why
      // the two listeners end up siblings on the same node, and why this is
      // still only a Dialog-stays-open fix (the selection was never lost).
      // Both files shipped this bug behind a one-liner claiming the synthetic
      // stop was sufficient, and both were fixed together.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      close();
      return;
    }
    if (e.key === 'Tab' && open) close();
  }

  /** The running index across every group, so the keyboard order matches the eye. */
  let walkIndex = -1;

  const list = open && mounted && coords && (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={label ? `${label} options` : 'Options'}
      aria-multiselectable
      // Keep focus, and therefore aria-activedescendant, on the input when an
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
      {walkable.length === 0 ? (
        <p className="px-3 py-4 text-sm text-[var(--text-muted)] text-center">
          {query ? `Nothing matches “${query}”` : 'Everything is already selected'}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.group ?? ''} role="group" aria-label={group.group ?? undefined}>
            {/* A heading only when there is one to draw. An ungrouped list must
                not grow a blank strip above it. */}
            {group.group && (
              <p className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">
                {group.group}
              </p>
            )}
            {group.options.map((option) => {
              walkIndex += 1;
              const i = walkIndex;
              return (
                <div
                  key={option.value}
                  id={`${id}-opt-${i}`}
                  data-idx={i}
                  role="option"
                  // Nothing on screen is ever in the selected state: a chosen
                  // option leaves the list, and the chips carry the selection.
                  aria-selected={false}
                  onClick={() => commit(option)}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    'flex items-center px-3 py-2 min-h-[40px] cursor-pointer',
                    i === active && 'bg-[var(--bg-elevated)]',
                  )}
                >
                  <span className="flex-1 min-w-0 text-sm text-[var(--text-primary)] truncate">
                    {option.label}
                  </span>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className="space-y-1">
      {label && (
        <label
          htmlFor={id}
          className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5"
        >
          {label}
        </label>
      )}

      <div
        ref={wrapRef}
        className={cn(
          'w-full pl-3 pr-2 min-h-[48px] flex flex-wrap items-center gap-1.5 py-1.5 bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] transition-colors',
          'focus-within:ring-2 focus-within:ring-[var(--color-accent)] focus-within:border-transparent',
          disabled && 'opacity-50 cursor-not-allowed',
          open && 'ring-2 ring-[var(--color-accent)] border-transparent',
          className,
        )}
      >
        {chips.length === 0 && <Search className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />}
        {chips.map((option) => (
          <span
            key={option.value}
            className="flex items-center gap-1.5 pl-2.5 pr-1 py-0.5 max-w-full rounded-full bg-[var(--bg-elevated)] border border-[var(--border)]"
          >
            <span className="text-sm text-[var(--text-primary)] truncate max-w-[10rem]">
              {option.label}
            </span>
            <button
              type="button"
              disabled={disabled}
              aria-label={`Remove ${option.label}`}
              onClick={() => {
                onChange(toggleValue(value, option.value));
                inputRef.current?.focus();
              }}
              className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)] transition-colors disabled:cursor-not-allowed"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}

        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={open && walkable[active] ? `${id}-opt-${active}` : undefined}
          aria-describedby={helpText ? `${id}-help` : undefined}
          disabled={disabled}
          // The chips ARE the selection, so the field is only ever the search
          // box and stays typeable between picks.
          value={query}
          placeholder={chips.length > 0 ? 'Add another…' : placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => !disabled && !nothingLeftToPick && setOpen(true)}
          onClick={() => !disabled && !nothingLeftToPick && setOpen(true)}
          onKeyDown={handleKeyDown}
          className="flex-1 min-w-[6rem] bg-transparent py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none disabled:cursor-not-allowed"
        />

        <ChevronDown
          aria-hidden="true"
          className={cn(
            'w-4 h-4 shrink-0 mr-1 text-[var(--text-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </div>

      {/* Screen readers get the counts; sighted users see the list and the chips. */}
      <p id={statusId} role="status" aria-live="polite" className="sr-only">
        {open ? `${walkable.length} option${walkable.length === 1 ? '' : 's'} available` : ''}
        {value.length > 0 ? `, ${value.length} selected` : ''}
      </p>

      {helpText && (
        <p id={`${id}-help`} className="text-xs text-[var(--text-muted)] leading-relaxed">
          {helpText}
        </p>
      )}

      {/* THE LISTBOX IS BUILT ABOVE AND MOUNTED HERE, AND IT IS ONLY A DROPDOWN
          BECAUSE OF THIS LINE. Without it `list` is dead JSX: the field still
          focuses, the chevron still turns, aria-expanded still flips to true,
          and no list ever appears, so the control is operable by blind keyboard
          alone. That is exactly how this shipped once, and nothing caught it,
          because tsconfig sets no noUnusedLocals and a server render cannot
          reach a portal anyway (`mounted` is false until the effect runs). The
          guard test next to this file's other tests pins the line by name.

          Portalled to document.body rather than positioned in place for the
          reason PlayerPicker.tsx:475 gives: a listbox inside the field inherits
          the overflow and stacking context of whatever the field sits in, and
          both composers sit inside scrolling panels. */}
      {mounted && list && createPortal(list, document.body)}
    </div>
  );
}
