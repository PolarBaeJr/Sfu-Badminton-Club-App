'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Card, ResponsiveTable, SearchFilter, filterPlayerOptions } from '@badminton/ui';

export interface RosterRow {
  id: string;
  /** Ranked prefix > word-prefix > substring, exactly as the challenge picker does. */
  name: string;
  /** The chosen username. Ranked LIKE the name, not as a meta fallback, so
   *  `@kiera` and `kiera` both land on Kiera rather than under everyone whose
   *  name merely contains the letters. Null until a member picks one. */
  handle?: string | null;
  /** Email. Searched but not ranked, so two people with the same name can still
   *  be told apart by typing the address. */
  meta?: string | null;
  /** The `<tr>`, rendered on the SERVER. Elo, waiver maths and the action
   *  buttons all stay server-decided; the only thing the client owns is which
   *  of these already-rendered rows are mounted. */
  row: ReactNode;
  /** The `<TableCard>` shown below `md`. Server-rendered for the same reason. */
  card: ReactNode;
}

interface Props {
  /** The <tr> of <th>s. Passed in so the whole table stays authored in one
   *  place — this component only filters, it does not know the columns. */
  head: ReactNode;
  rows: RosterRow[];
  /** The tab links, rendered on the server so each is a real URL. They sit in
   *  the control row beside the search rather than in a strip of their own:
   *  narrowing by tab and narrowing by name are the same gesture, and the
   *  roster reads as one instrument when they are side by side. */
  tabs: ReactNode;
  /**
   * How many members this tab HAS, which is not how many were fetched.
   *
   * The denominator has to be the tab's own count, not `rows.length`: the list
   * query is capped at 500 and the count query is not, so a tab past 500 would
   * otherwise print "showing 500 of 500" and claim a completeness it does not
   * have. With the real total it reads "showing 500 of 620", which says the
   * opposite and is the only warning anyone gets that the cap is in play.
   */
  total: number;
  /** Seed from ?search= so a link to a search still lands on one. */
  initialQuery?: string;
  /**
   * The standing line under the table, right-hand side. Passed in rather than
   * hard-coded because it is only true of somebody who can reach those actions
   * — telling a trainer that suspensions take a typed reason is describing a
   * button they will never see.
   */
  note?: string;
}

/**
 * The roster, with the same search the new-challenge screen uses.
 *
 * NOT PlayerPicker itself, deliberately. That control is a combobox: it
 * collapses to ONE chosen player and hides the rest, which is right for "who
 * are you challenging" and wrong for "show me everyone called Chen" — an admin
 * searching the roster wants the matching rows, plural, with their rating and
 * standing still visible. What is shared is the part that matters: the matching
 * (filterPlayerOptions) and the field itself (SearchFilter), so it reads as the
 * same search in both apps.
 *
 * filterPlayerOptions, NOT filterRowsByPlayers — which is why this is not the
 * SearchableTable that /challenges and /matches share. Those rows are about two
 * sides and are searched by a list of names; a roster row is about ONE person
 * and carries a handle, and only filterPlayerOptions ranks a handle. Swapping to
 * the shared table would silently stop `@kiera` finding Kiera.
 *
 * Filtering is client-side over the rows the page already fetched — no round
 * trip per keystroke, and no way for the list to disagree with its own tab
 * count. It therefore searches exactly what the table is showing, which is the
 * page's first 500 rows — and the count line below is measured against the
 * tab's real total, so it is also where that cap would become visible.
 */
export function RosterTable({ head, rows, tabs, total, initialQuery = '', note }: Props) {
  const [query, setQuery] = useState(initialQuery);

  const filtered = useMemo(() => filterPlayerOptions(rows, query), [rows, query]);

  return (
    <div className="space-y-4">
      {/* Search left, tabs right, stacked on a phone — where a 360px field and
          five tabs cannot share a line without one of them scrolling. */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <SearchFilter
          className="w-full md:max-w-[360px]"
          value={query}
          onChange={setQuery}
          label="Search players by name, handle or email"
          placeholder="Search players"
          resultCount={filtered.length}
          noun="player"
        />
        <div className="min-w-0 md:ml-auto">{tabs}</div>
      </div>

      {/* Zero padding: the table is full-bleed to the hairline, so the rows'
          own cell padding is the only inset and the header rule meets both
          edges. No rounded-none: Card's rounded-xl already compiles to 0 —
          this app's tailwind.config.ts replaces the whole radius scale. */}
      <Card padding={false}>
        {filtered.length === 0 ? (
          // Say what was searched. "No results" leaves the reader wondering
          // whether they mistyped or the row genuinely is not there.
          // `anywhere` because the query is arbitrary text and a long unbroken
          // one would otherwise push the phone layout sideways.
          <p className="py-10 px-4 text-center text-[var(--text-muted)] [overflow-wrap:anywhere]">
            {query ? `No players match “${query}”` : 'No players found'}
          </p>
        ) : (
          <ResponsiveTable cards={filtered.map((r) => <Fragment key={r.id}>{r.card}</Fragment>)}>
            <table className="w-full border-collapse">
              <thead>{head}</thead>
              <tbody className="divide-y divide-[var(--border)]">
                {filtered.map((r) => (
                  <Fragment key={r.id}>{r.row}</Fragment>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        )}
      </Card>

      {/* Outside the card, in the margin voice: what you are looking at on the
          left, what the console will hold you to on the right. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
        <span>
          Showing {filtered.length} of {total}
        </span>
        {note && <span className="text-right">{note}</span>}
      </div>
    </div>
  );
}
