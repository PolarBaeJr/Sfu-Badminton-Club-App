'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { ResponsiveTable, SearchFilter, filterRowsByPlayers } from '@badminton/ui';

export interface SearchableRow {
  id: string;
  /**
   * Every person named on the row — both sides, partners and opponents alike.
   * This is the search key, not the display: the page has already rendered the
   * names into `row` and `card` however it wants them to read.
   */
  players: string[];
  /**
   * The `<tr>`, rendered on the SERVER. Elo deltas, dispute call-outs and the
   * action buttons all stay server-decided; the only thing the client owns is
   * which of these already-rendered rows are mounted. Nothing about the joins
   * behind them ships to the browser just so a search box can hide a row.
   */
  row: ReactNode;
  /** The `<TableCard>` shown below `md`. Server-rendered for the same reason. */
  card: ReactNode;
}

interface SearchableTableProps {
  /** The `<tr>` of `<th>`s. Passed in so each table stays authored in one
   *  place — this component filters, it does not know the columns. */
  head: ReactNode;
  rows: SearchableRow[];
  /** Accessible name for the field: "Search challenges by player". */
  label: string;
  placeholder: string;
  /** Singular noun, for the live count and the no-results line. */
  noun: string;
  nounPlural?: string;
  /** The page's own "nothing here yet" state, for when there is nothing to
   *  search in the first place. */
  empty: ReactNode;
}

/**
 * A ResponsiveTable with the roster's search over it.
 *
 * Filtering is client-side over the rows the page already fetched — no round
 * trip per keystroke, and no way for the list to disagree with its own header
 * count. It therefore searches exactly what the table is showing, which is the
 * page's most recent 50 rows.
 *
 * Both admin lists that are about two sides (challenges, matches) render
 * through this rather than growing a copy each.
 */
export function SearchableTable({
  head,
  rows,
  label,
  placeholder,
  noun,
  nounPlural,
  empty,
}: SearchableTableProps) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterRowsByPlayers(rows, query), [rows, query]);
  const plural = nounPlural ?? `${noun}s`;

  // Nothing fetched at all: there is nothing to search, so offering a search
  // box would be offering a control that cannot do anything.
  if (rows.length === 0) return <>{empty}</>;

  return (
    <>
      {/* Deliberately outside the branch below. A query that matches nothing
          must not take the field with it, or there is no way to undo it. */}
      <div className="p-3 border-b border-[var(--border)]">
        <SearchFilter
          value={query}
          onChange={setQuery}
          label={label}
          placeholder={placeholder}
          resultCount={visible.length}
          noun={noun}
          nounPlural={nounPlural}
        />
      </div>

      {visible.length === 0 ? (
        // Say what was searched. "No results" leaves the reader wondering
        // whether they mistyped or the row genuinely is not there.
        // `anywhere` because the query is arbitrary text and a long unbroken
        // one would otherwise push the phone layout sideways.
        <p className="py-8 px-4 text-center text-[var(--text-muted)] [overflow-wrap:anywhere]">
          No {plural} match “{query}”
        </p>
      ) : (
        <ResponsiveTable cards={visible.map((r) => <Fragment key={r.id}>{r.card}</Fragment>)}>
          <table className="w-full border-collapse">
            <thead>{head}</thead>
            <tbody className="divide-y divide-[var(--border)]">
              {visible.map((r) => (
                <Fragment key={r.id}>{r.row}</Fragment>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </>
  );
}
