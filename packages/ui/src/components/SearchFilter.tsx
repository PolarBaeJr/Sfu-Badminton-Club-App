'use client';

import { useId } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../utils';

interface SearchFilterProps {
  value: string;
  onChange: (next: string) => void;
  /**
   * Accessible name. Say what is being searched, not just "Search" — a screen
   * reader user meets this field with no surrounding context: "Search
   * challenges by player".
   */
  label: string;
  placeholder?: string;
  /**
   * How many rows survived the filter. Announced, never drawn: sighted users
   * watch the list shrink, so a visible count would be a second, redundant
   * answer to a question they can already see.
   */
  resultCount: number;
  /** Singular noun for that count — "challenge" gives "3 challenges match". */
  noun: string;
  /** Override when appending "s" is wrong: "match" would give "matchs". */
  nounPlural?: string;
  className?: string;
}

/**
 * The filter field, styled as PlayerPicker's closed state.
 *
 * NOT PlayerPicker itself, deliberately. That control is a combobox: it
 * collapses to ONE chosen player and hides the rest, which is right for "who
 * are you challenging" and wrong for "show me every game Chen played" — the
 * answer there is rows, plural. What the two share is what matters: the
 * matching (filterPlayerOptions) and the field's appearance, so the same
 * gesture looks and behaves the same wherever it appears.
 *
 * Lifted here from the roster's inline copy on /players so the third and
 * fourth uses (challenges, matches) are not a third and fourth hand-rolled
 * field. It owns no filtering of its own — it is an input with a search icon,
 * a clear affordance and a live region. The caller keeps the query and decides
 * what it means.
 */
export function SearchFilter({
  value,
  onChange,
  label,
  placeholder = 'Search…',
  resultCount,
  noun,
  nounPlural,
  className,
}: SearchFilterProps) {
  const statusId = useId();
  const plural = nounPlural ?? `${noun}s`;

  return (
    <div className={className}>
      <div className="w-full pl-3 pr-2 min-h-[48px] flex items-center gap-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] transition-colors focus-within:ring-2 focus-within:ring-[var(--color-accent)] focus-within:border-transparent">
        <Search aria-hidden="true" className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
        <input
          type="text"
          role="searchbox"
          autoComplete="off"
          aria-label={label}
          aria-describedby={statusId}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              // Stop here — Escape otherwise bubbles to whatever overlay is open.
              e.preventDefault();
              e.stopPropagation();
              onChange('');
            }
          }}
          // `min-w-0` is what keeps this off the phone's horizontal scrollbar:
          // a flex item's default min-width is its content, so a long query
          // would otherwise widen the row rather than scroll inside the input.
          className="flex-1 min-w-0 bg-transparent py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
        />
        {value && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onChange('')}
            className={cn(
              'shrink-0 w-7 h-7 flex items-center justify-center rounded-md',
              'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors'
            )}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Sighted users see the list shrink; screen readers get the count. */}
      <p id={statusId} role="status" aria-live="polite" className="sr-only">
        {value ? `${resultCount} ${resultCount === 1 ? noun : plural} match` : ''}
      </p>
    </div>
  );
}
