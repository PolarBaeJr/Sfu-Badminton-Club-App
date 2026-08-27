'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Card, ResponsiveTable, SearchFilter, filterPlayerOptions } from '@badminton/ui';

/**
 * Rows mounted at first paint, and added each time the sentinel comes into view.
 *
 * Deliberately the same 25 the player ladder uses, but declared HERE rather than
 * imported from apps/player/src/lib/ladder.ts: the two apps share `packages/`,
 * not each other's `src`, and reaching across would be the first such import in
 * the repo. Same number, same reasoning, independent knob.
 */
const ROSTER_WINDOW_STEP = 25;

/**
 * How far BELOW the viewport the sentinel starts extending, in CSS pixels.
 *
 * A roster row is taller than a ladder row (two lines of badges and a 44px
 * action button), so 800px is roughly eight rows of warning rather than the
 * ladder's twelve — still enough that the next batch is mounted before anyone
 * scrolls to the end of this one. It is a distance because that is what
 * IntersectionObserver's rootMargin takes; quoting it in rows here is what keeps
 * the number honest when somebody changes the row padding.
 */
const ROSTER_WINDOW_LOOKAHEAD_PX = 800;

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
 * count. It searches the page's first 500 rows, which is MORE than the table is
 * showing: the rows are windowed 25 at a time, and the slice is taken after the
 * filter precisely so that searching still reaches a row that has never been
 * mounted. The count line below is measured against the tab's real total, so it
 * is also where the 500 cap would become visible.
 *
 * The window is a MOUNT budget, not a fetch budget. Every row was already
 * server-rendered and shipped in this page's payload; holding 25 of them in the
 * DOM keeps a 500-row roster from laying out 500 rows' worth of badges and 44px
 * buttons at once, but it does not make the payload smaller. Making the payload
 * incremental means paging the query itself, which this component cannot do
 * alone — the page accumulates the standings chart's counts inside the same map
 * that builds these rows, so a server-side page would silently chart only the
 * rows it fetched.
 */
export function RosterTable({ head, rows, tabs, total, initialQuery = '', note }: Props) {
  const [query, setQuery] = useState(initialQuery);

  const filtered = useMemo(() => filterPlayerOptions(rows, query), [rows, query]);

  // WINDOWED, and the slice is taken AFTER the filter — never before. Searching
  // only what happens to be mounted is the trap here: type "chen" with 25 of 500
  // rows on screen and a roster of Chens would answer "no players match", which
  // is worse than slow. filterPlayerOptions still ranks the whole fetched set;
  // the window only decides how much of the ANSWER is in the DOM.
  const [shown, setShown] = useState(ROSTER_WINDOW_STEP);

  // Reset on the QUERY only. Not on `rows`: this page revalidates on every
  // roster mutation, and resetting there would yank an admin scrolled to row 200
  // back to the top because somebody else approved a signup. A new search is the
  // one moment the reader has actually asked for a different list.
  useEffect(() => {
    setShown(ROSTER_WINDOW_STEP);
  }, [query]);

  const windowed = useMemo(() => filtered.slice(0, shown), [filtered, shown]);
  const hasMore = shown < filtered.length;

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown((n) => Math.min(n + ROSTER_WINDOW_STEP, filtered.length));
        }
      },
      { rootMargin: `0px 0px ${ROSTER_WINDOW_LOOKAHEAD_PX}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, filtered.length]);

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
          <>
            <ResponsiveTable cards={windowed.map((r) => <Fragment key={r.id}>{r.card}</Fragment>)}>
              <table className="w-full border-collapse">
                <thead>{head}</thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {windowed.map((r) => (
                    <Fragment key={r.id}>{r.row}</Fragment>
                  ))}
                </tbody>
              </table>
            </ResponsiveTable>

            {/* The sentinel sits INSIDE the card, below the last mounted row, so
                it crosses the viewport as part of the list rather than after the
                card's bottom rule. aria-hidden: it is a scroll tripwire, not
                content, and a screen reader has the button below instead. */}
            {hasMore && (
              <>
                <div ref={sentinelRef} aria-hidden className="h-px w-full" />
                {/* The keyboard and screen-reader path to the same extension.
                    IntersectionObserver only ever fires for somebody scrolling a
                    pointer; without this, tabbing through the roster stops dead
                    at row 25 with no way forward. */}
                <div className="flex justify-center border-t border-[var(--border)] px-4 py-3">
                  <button
                    type="button"
                    onClick={() =>
                      setShown((n) => Math.min(n + ROSTER_WINDOW_STEP, filtered.length))
                    }
                    className="min-h-[44px] font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
                  >
                    Show more · {filtered.length - shown} left
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </Card>

      {/* Outside the card, in the margin voice: what you are looking at on the
          left, what the console will hold you to on the right. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
        {/* THREE numbers, because with a window there are three honest answers
            to "how much am I looking at": what is mounted, what the search
            matched, and what the tab holds. The last two only separate when
            something is hiding rows — a search, or the query's 500 cap — so in
            the ordinary case this still reads "Showing 10 of 10" and no more.
            Dropping `total` was never an option: the list query is capped at 500
            and the count query is not, so it is the only warning anyone gets
            that the cap is in play. */}
        <span>
          Showing {windowed.length} of {filtered.length}
          {filtered.length !== total && ` · ${total} in tab`}
        </span>
        {note && <span className="text-right">{note}</span>}
      </div>
    </div>
  );
}
