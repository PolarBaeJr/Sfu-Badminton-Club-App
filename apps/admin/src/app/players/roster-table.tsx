'use client';

import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { Card, filterPlayerOptions } from '@badminton/ui';

export interface RosterRow {
  id: string;
  /** Ranked prefix > word-prefix > substring, exactly as the challenge picker does. */
  name: string;
  /** Email. Searched but not ranked, so two people with the same name can still
   *  be told apart by typing the address. */
  meta?: string | null;
  /** The row itself, rendered on the SERVER. Elo, waiver maths and the action
   *  buttons all stay server-decided; the only thing the client owns is which
   *  of these already-rendered rows are mounted. */
  row: ReactNode;
}

interface Props {
  /** The <tr> of <th>s. Passed in so the whole table stays authored in one
   *  place — this component only filters, it does not know the columns. */
  head: ReactNode;
  rows: RosterRow[];
  /** Seed from ?search= so a link to a search still lands on one. */
  initialQuery?: string;
}

/**
 * The roster, with the same search the new-challenge screen uses.
 *
 * NOT PlayerPicker itself, deliberately. That control is a combobox: it
 * collapses to ONE chosen player and hides the rest, which is right for "who
 * are you challenging" and wrong for "show me everyone called Chen" — an admin
 * searching the roster wants the matching rows, plural, with their Elo and
 * waiver state still visible. What is shared is the part that matters: the
 * matching itself (filterPlayerOptions, lifted out of PlayerPicker) and the
 * field's appearance, so it reads as the same search in both apps. The avatars
 * PlayerPicker shows beside each result are already in the table rows here.
 *
 * Filtering is client-side over the rows the page already fetched — no round
 * trip per keystroke, and no way for the list to disagree with its own tab
 * count. It therefore searches exactly what the table is showing, which is the
 * page's first 500 rows.
 */
export function RosterTable({ head, rows, initialQuery = '' }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const statusId = useId();

  const filtered = useMemo(() => filterPlayerOptions(rows, query), [rows, query]);

  return (
    <Card padding={false}>
      <div className="p-3 border-b border-[var(--border)]">
        <div className="w-full pl-3 pr-2 min-h-[48px] flex items-center gap-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] transition-colors focus-within:ring-2 focus-within:ring-[var(--color-accent)] focus-within:border-transparent">
          <Search aria-hidden="true" className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
          <input
            type="text"
            role="searchbox"
            autoComplete="off"
            aria-label="Search players"
            aria-describedby={statusId}
            value={query}
            placeholder="Search players…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                // Stop here — Escape otherwise bubbles to whatever overlay is open.
                e.preventDefault();
                e.stopPropagation();
                setQuery('');
              }
            }}
            className="flex-1 min-w-0 bg-transparent py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {/* Sighted users see the list shrink; screen readers get the count. */}
        <p id={statusId} role="status" aria-live="polite" className="sr-only">
          {query ? `${filtered.length} player${filtered.length === 1 ? '' : 's'} match` : ''}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>{head}</thead>
          <tbody className="divide-y divide-[var(--border)]">
            {filtered.map((r) => (
              <Fragment key={r.id}>{r.row}</Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <p className="text-center text-[var(--text-muted)] py-8">
          {query ? `No players match “${query}”` : 'No players found'}
        </p>
      )}
    </Card>
  );
}
