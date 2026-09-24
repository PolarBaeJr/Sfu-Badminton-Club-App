'use client';

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../utils';
import {
  TYPEAHEAD_RESET_MS,
  firstEnabledIndex,
  indexOfValue,
  initialActiveIndex,
  lastEnabledIndex,
  nextEnabledIndex,
  resolvePlacement,
  shouldEmitChange,
  typeaheadMatch,
  type SelectOption,
  type SelectPlacement,
} from '../select';

export type { SelectOption };

export interface SelectProps {
  id?: string;
  label?: string;
  error?: string;
  options: readonly SelectOption[];
  value?: string;
  /**
   * Event-shaped so every existing `(e) => set(e.target.value)` caller keeps
   * working. New code can use `onValueChange` instead.
   */
  onChange?: (event: { target: { value: string; name?: string } }) => void;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  /** Render a plain native `<select>`: the per-site opt-out. */
  native?: boolean;
  /**
   * `field` is the labelled form field. `bare` is the trigger alone, for
   * compact inline controls whose `className` owns the whole look.
   */
  variant?: 'field' | 'bare';
}

const COARSE_POINTER = '(hover: none) and (pointer: coarse)';

const FIELD_CLASSES =
  'w-full px-3 min-h-[48px] bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * A single-value dropdown with a custom list.
 *
 * WHY CUSTOM. The owner found the macOS native popup jarring next to the rest of
 * the console, so on desktop the list is drawn here, portalled to the body and
 * positioned against the trigger the way MultiSelect does it.
 *
 * WHY aria-activedescendant AND NOT ROVING FOCUS. The list is portalled outside
 * any Dialog panel, and Dialog's Tab trap would pull focus back out of it. So
 * focus stays on the trigger the whole time and the highlighted row is announced
 * through aria-activedescendant.
 *
 * WHY A NATIVE OVERLAY ON TOUCH. On a coarse pointer a transparent native
 * `<select>` is laid over the same trigger, so the closed control looks the same
 * everywhere while phones keep the OS picker wheel, which is better on a phone
 * than any list drawn here.
 *
 * WHY NO CHANGE ON A RE-PICK. A native select fires no change event when the
 * current option is picked again, and callers rely on it: the session location
 * field clears its free-text box when "Custom" is chosen, so a change on a
 * re-pick would wipe what was typed.
 */
export function Select({
  id,
  label,
  error,
  options,
  value,
  onChange,
  onValueChange,
  disabled,
  required,
  name,
  placeholder,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  native,
  variant = 'field',
}: SelectProps) {
  const reactId = useId();
  // The label-derived fallback is kept so existing htmlFor and id behaviour is
  // unchanged. The ids below come from useId instead, for the collision reason
  // MultiSelect.tsx gives for requiring its own `id`.
  const baseId = id ?? (label ? label.toLowerCase().replace(/\s+/g, '-') : reactId);
  const listboxId = `${reactId}-listbox`;
  const labelId = `${reactId}-label`;
  const valueId = `${reactId}-value`;
  const errorId = `${reactId}-error`;
  const optionId = (i: number) => `${reactId}-opt-${i}`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [invalid, setInvalid] = useState(false);
  const [coords, setCoords] = useState<SelectPlacement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(COARSE_POINTER);
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeBuffer = useRef('');
  const lastKeyAt = useRef(0);

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setCoords(
        resolvePlacement(
          { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
          { width: window.innerWidth, height: window.innerHeight },
          { gap: 6, maxHeight: 288, minHeight: 120, margin: 8 },
        ),
      );
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
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const selectedIndex = indexOfValue(options, value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  // The bare variant draws no error line, so it must not point at one.
  const shownError =
    variant === 'bare' ? undefined : error ?? (invalid ? 'Choose an option.' : undefined);
  const describedBy =
    [ariaDescribedBy, shownError ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  const hasName = Boolean(ariaLabel || label);

  if (native) {
    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={baseId} className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
            {label}
            {required && <span className="text-[var(--color-accent)]"> *</span>}
          </label>
        )}
        <select
          id={baseId}
          name={name}
          value={value}
          onChange={(e) => {
            onChange?.(e);
            onValueChange?.(e.target.value);
          }}
          disabled={disabled}
          required={required}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          className={cn(FIELD_CLASSES, className)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
          ))}
        </select>
        {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
      </div>
    );
  }

  function emit(next: string) {
    setInvalid(false);
    if (!shouldEmitChange(value, next)) return;
    onChange?.({ target: { value: next, name } });
    onValueChange?.(next);
  }

  function openList() {
    if (disabled) return;
    setActive(initialActiveIndex(options, value));
    setOpen(true);
  }

  function commit(i: number) {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    emit(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function typeahead(ch: string, from: number): number {
    const now = Date.now();
    if (now - lastKeyAt.current > TYPEAHEAD_RESET_MS) typeBuffer.current = '';
    typeBuffer.current += ch;
    lastKeyAt.current = now;
    return typeaheadMatch(options, typeBuffer.current, from);
  }

  const isPrintable = (e: React.KeyboardEvent) =>
    e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
        return;
      }
      if (isPrintable(e)) {
        e.preventDefault();
        const match = typeahead(e.key, selectedIndex);
        if (match >= 0) emit(options[match]!.value);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => nextEnabledIndex(options, a, e.key === 'ArrowDown' ? 1 : -1));
        return;
      case 'Home':
        e.preventDefault();
        setActive(firstEnabledIndex(options));
        return;
      case 'End':
        e.preventDefault();
        setActive(lastEnabledIndex(options));
        return;
      case 'Enter':
        e.preventDefault();
        commit(active);
        return;
      case ' ': {
        e.preventDefault();
        const typing =
          typeBuffer.current.length > 0 && Date.now() - lastKeyAt.current < TYPEAHEAD_RESET_MS;
        if (typing) {
          const match = typeahead(' ', active);
          if (match >= 0) setActive(match);
        } else {
          commit(active);
        }
        return;
      }
      case 'Escape':
        // All three stops, for the reason PlayerPicker.tsx gives at its Escape
        // handler: Dialog binds Escape on `document`, as a sibling of React's
        // own listener, so only stopImmediatePropagation keeps the Dialog open
        // while this closes the list. When the list is closed, Escape is left
        // alone so the Dialog still closes.
        e.preventDefault();
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        setOpen(false);
        return;
      case 'Tab': {
        // Tab commits the highlighted row, as native Chrome and Firefox do, and
        // then moves focus on as normal.
        const opt = options[active];
        if (opt && !opt.disabled) emit(opt.value);
        setOpen(false);
        return;
      }
    }

    if (isPrintable(e)) {
      e.preventDefault();
      const match = typeahead(e.key, active);
      if (match >= 0) setActive(match);
    }
  }

  // Firefox fires a button's click from the Space KEYUP, after the keydown above
  // has already opened or committed, which would toggle the list straight back.
  // Needs a manual Firefox check.
  function handleKeyUp(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === ' ') e.preventDefault();
  }

  function handleBlur(e: React.FocusEvent<HTMLButtonElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && !listRef.current?.contains(next)) setOpen(false);
  }

  function handleNativeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    emit(e.target.value);
  }

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      id={coarse ? undefined : baseId}
      tabIndex={coarse ? -1 : undefined}
      aria-hidden={coarse || undefined}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
      aria-labelledby={hasName ? `${labelId} ${valueId}` : undefined}
      aria-invalid={Boolean(error) || invalid || undefined}
      aria-required={required || undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => (open ? setOpen(false) : openList())}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      className={
        variant === 'bare'
          ? cn('inline-flex items-center justify-between gap-1.5 text-left', className)
          : cn(
              FIELD_CLASSES,
              'flex items-center justify-between gap-2 text-left',
              open && 'ring-2 ring-[var(--color-accent)] border-transparent',
              (error || invalid) && 'border-[var(--color-danger)]',
              className,
            )
      }
    >
      {ariaLabel && (
        <span id={labelId} className="sr-only">
          {ariaLabel}
        </span>
      )}
      <span id={valueId} className={cn('truncate', !selected && 'text-[var(--text-muted)]')}>
        {selected ? selected.label : placeholder ?? ' '}
      </span>
      <ChevronDown
        aria-hidden
        className={cn('w-4 h-4 shrink-0 text-[var(--text-muted)] transition-transform', open && 'rotate-180')}
      />
    </button>
  );

  // The touch overlay: a real select over the trigger, so a phone opens its own
  // picker. It is the only focusable part in this mode.
  const nativeOverlay = coarse && (
    <select
      id={baseId}
      name={name}
      required={required}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      value={value ?? ''}
      onChange={handleNativeChange}
      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer appearance-none"
    >
      {selectedIndex < 0 && <option value={value ?? ''} disabled hidden />}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
      ))}
    </select>
  );

  // The desktop form mirror, so `required` still blocks a submit and `name`
  // still posts a value. NOT type="hidden" and NOT readOnly: both are barred
  // from constraint validation.
  const formMirror = (required || name) && !coarse && (
    <input
      tabIndex={-1}
      aria-hidden="true"
      name={name}
      required={required}
      disabled={disabled}
      value={value ?? ''}
      onChange={() => {}}
      onInvalid={(e) => {
        e.preventDefault();
        setInvalid(true);
        triggerRef.current?.focus();
      }}
      className="absolute bottom-0 left-0 w-full h-px opacity-0 pointer-events-none"
    />
  );

  const list = open && mounted && coords && (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-labelledby={hasName ? labelId : undefined}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      // The portal still bubbles React events through the React tree, so a pick
      // would otherwise reach any row or card click handler above the Select.
      onClick={(e) => e.stopPropagation()}
      className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] overflow-y-auto py-1 text-[var(--text-primary)]"
      style={{
        position: 'fixed',
        left: coords.left,
        minWidth: coords.minWidth,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: coords.maxHeight,
        zIndex: 60,
        boxShadow: '0 10px 40px -12px rgba(0,0,0,0.45)',
        ...(coords.top !== undefined ? { top: coords.top } : { bottom: coords.bottom }),
      }}
    >
      {options.map((opt, i) => {
        const isSelected = opt.value === value;
        return (
          <div
            key={opt.value}
            id={optionId(i)}
            data-idx={i}
            role="option"
            aria-selected={isSelected}
            aria-disabled={opt.disabled || undefined}
            onClick={() => commit(i)}
            onPointerMove={() => !opt.disabled && setActive(i)}
            className={cn(
              'flex items-center gap-2 px-3 py-2 min-h-[40px] text-sm cursor-pointer select-none',
              i === active && 'bg-[color-mix(in_oklab,var(--text-primary)_8%,transparent)]',
              opt.disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            <Check
              aria-hidden
              className={cn('w-4 h-4 shrink-0 text-[var(--color-accent)]', !isSelected && 'invisible')}
            />
            <span className="truncate">{opt.label}</span>
          </div>
        );
      })}
    </div>
  );

  if (variant === 'bare') {
    return (
      <span className="relative inline-flex max-w-full">
        {trigger}
        {nativeOverlay}
        {formMirror}
        {/* Built above; only a dropdown because of this line (see MultiSelect). */}
        {mounted && list && createPortal(list, document.body)}
      </span>
    );
  }

  return (
    <div className="space-y-1">
      {label && (
        <label
          htmlFor={baseId}
          id={ariaLabel ? undefined : labelId}
          className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5"
        >
          {label}
          {required && <span className="text-[var(--color-accent)]"> *</span>}
        </label>
      )}
      <div className="relative">
        {trigger}
        {nativeOverlay}
        {formMirror}
      </div>
      {shownError && (
        <p id={errorId} className="text-sm text-[var(--color-danger)]">
          {shownError}
        </p>
      )}
      {/* Built above; only a dropdown because of this line (see MultiSelect). */}
      {mounted && list && createPortal(list, document.body)}
    </div>
  );
}
