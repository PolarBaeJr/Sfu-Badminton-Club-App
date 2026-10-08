'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { EmptyState, ResponsiveTable, SearchFilter } from '@badminton/ui';
import { filterMatchRows, type MatchSearchRow } from '@/lib/match-search';

interface Props {
  /** The `<tr>` of `<th>`s, authored with the table on the server. */
  head: ReactNode;
  /**
   * Rows pre-rendered on the SERVER, exactly as the roster does it. Scores,
   * rating deltas and format labels stay server-decided; the only thing the
   * client owns is which of them are mounted.
   */
  rows: MatchSearchRow<{ row: ReactNode; card: ReactNode }>[];
  /** Named so the empty state can say which season found nothing. */
  seasonNote: string;
}

/**
 * A member's recent matches, with a filter over them.
 *
 * The search is client-side over the rows the page already fetched, so it
 * cannot disagree with the list it is filtering and costs no round trip per
 * keystroke. That also means it searches THIS SEASON's rows — the season picker
 * above chooses the set, and this narrows within it.
 */
export function RecentMatches({ head, rows, seasonNote }: Props) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterMatchRows(rows, query), [rows, query]);

  // Nothing recorded at all is a different answer from "your search found
  // nothing", and conflating them would tell an officer the member has no
  // history when they have simply mistyped a score.
  if (rows.length === 0) {
    return <EmptyState title="No matches this season" description={seasonNote} />;
  }

  return (
    <div>
      {/* Inset, because the panel itself is full-bleed to the hairline so the
          table can be. */}
      <div className="border-b border-[var(--border)] px-5 py-3">
        <SearchFilter
          className="w-full md:max-w-[320px]"
          value={query}
          onChange={setQuery}
          label="Search this member's matches by result, score, format or date"
          placeholder="Search matches"
          resultCount={filtered.length}
          noun="match"
          nounPlural="matches"
        />
      </div>

      {filtered.length === 0 ? (
        // Say what was searched — "No results" leaves the reader unsure whether
        // they mistyped or the match genuinely is not there. `anywhere` because
        // the query is arbitrary text and a long unbroken one would push the
        // phone layout sideways.
        <p className="px-4 py-10 text-center text-[var(--text-muted)] [overflow-wrap:anywhere]">
          No matches match “{query}”
        </p>
      ) : (
        <ResponsiveTable cards={filtered.map((m) => <Fragment key={m.id}>{m.value.card}</Fragment>)}>
          <table className="w-full">
            <thead>{head}</thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.map((m) => (
                <Fragment key={m.id}>{m.value.row}</Fragment>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </div>
  );
}
