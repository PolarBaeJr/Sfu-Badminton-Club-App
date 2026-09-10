'use client';

import React from 'react';
import { cn } from '../utils';

interface CheckboxProps {
  checked: boolean;
  /**
   * Neither checked nor unchecked — "some of these, not all". Drawn as a dash
   * and reported to assistive tech as `aria-checked="mixed"`, which is what a
   * select-all box in a partly-selected table actually means. `checked` still
   * decides what a click DOES: an indeterminate box is unchecked, so clicking
   * it selects the rest rather than clearing the few.
   */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /** Required. There is no visible text beside a checkbox in a table row, so
   *  without this the only thing a screen reader can announce is "checkbox". */
  label: string;
  /** Show the label beside the box. Off in table rows, on in a form. */
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A checkbox, for choosing several of something.
 *
 * NOT Switch, and the distinction is worth keeping: a Switch is a setting that
 * takes effect the moment it moves ("email me reminders"), a Checkbox is a
 * selection that does nothing until something else acts on it ("these eleven
 * members"). Drawing the second as the first is what makes a row of toggles in
 * a table read as eleven settings somebody just changed.
 *
 * A REAL `<input type="checkbox">` under a drawn box, rather than a
 * `role="checkbox"` button like Switch. Three things come free with the native
 * element and none of them are worth reimplementing: Space toggles it, a label
 * click reaches it, and a browser's own find-and-check tooling sees it. It is
 * `sr-only` rather than `hidden` or `opacity-0` — hiding it outright takes it
 * out of the tab order, which is the whole point of using it.
 *
 * Square, not rounded: this app's tailwind config replaces the radius scale
 * with zeroes, so `rounded-sm` here would compile to nothing and read as an
 * accident. The corner is square on purpose, like every other box in the
 * console.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  showLabel = false,
  disabled,
  className,
}: CheckboxProps) {
  const ref = React.useRef<HTMLInputElement>(null);

  // `indeterminate` is a DOM property with no HTML attribute, so React cannot
  // set it from JSX — it has to be written to the node after every render that
  // could change it.
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <label
      className={cn(
        // 44px of tappable area around a 16px box: this sits in a roster row an
        // officer is working from a phone at the gym door.
        'group inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center gap-2',
        showLabel && 'justify-start px-1',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate && !checked ? 'mixed' : checked}
        aria-label={showLabel ? undefined : label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={cn(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center border transition-colors',
          'peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-accent)] peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--bg-primary)]',
          checked || indeterminate
            ? 'border-[var(--color-accent)] bg-[var(--color-accent)]'
            : 'border-[var(--border-hover)] bg-transparent group-hover:border-[var(--text-muted)]',
        )}
      >
        {checked ? (
          <svg viewBox="0 0 16 16" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : indeterminate ? (
          <span className="h-[2px] w-2.5 bg-white" />
        ) : null}
      </span>
      {showLabel && <span className="text-sm text-[var(--text-primary)]">{label}</span>}
    </label>
  );
}
