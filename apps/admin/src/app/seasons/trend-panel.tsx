import { Card } from '@badminton/ui';
import { buildColumns, uniqueColumnLabels } from '@/lib/charts';
import { ChartNote, ColumnChart, count } from '@/components/charts';
import { PanelLabel } from './panel';
import { hasStarted, type SeasonShape } from './season-shape';

/**
 * IS THE CLUB GROWING OR DYING? — the one question this screen holds the
 * numbers for and cannot currently answer.
 *
 * The table above already prints both counts, and prints them NEWEST FIRST,
 * which is right for finding a season and destroys the only thing they say
 * together. A trend is the shape of a sequence; a column per term in calendar
 * order is that shape, and a reader gets "matches halved when we moved to
 * Tuesdays" out of it in a way no column of figures gives up.
 *
 * TWO CHARTS, NOT ONE STACK. buildColumns' `under` exists for two parts of ONE
 * observed quantity (turned up / did not). Matches and the people who played
 * them are not parts of anything — a season is 60 matches AND 22 players, not
 * 60 of 82 — so stacking them would draw a total that does not exist. They
 * share an order and a card instead, which is what actually makes them
 * comparable.
 *
 * NO QUERY OF ITS OWN. Both counts are already computed by the page for the
 * table, under `seasons.page` and nothing narrower. There is no `seasons.read`
 * to gate a fetch on and inventing one would move an answer in the
 * capability-equivalence table; nothing drawn here comes from another area's
 * books.
 */

/** How many terms fit across a card before the labels stop being readable. */
const MAX_TERMS = 8;

interface TrendSeason extends SeasonShape {
  id: string;
  name: string;
}

// The label de-duplication this panel used to keep privately now lives in the
// kit as uniqueColumnLabels: /sessions needs exactly the same guard (two
// sessions may share one date, as two terms may share one name), and the
// constraint it works around — ColumnChart keying its columns by label — is the
// kit's, so the fix belongs beside it rather than in two screens.

export function SeasonTrendPanel({
  seasons,
  matchCounts,
  playerCounts,
  now,
}: {
  /** Every season the club has, newest first — exactly as the page holds them. */
  seasons: readonly TrendSeason[];
  matchCounts: ReadonlyMap<string, number>;
  playerCounts: ReadonlyMap<string, number>;
  now: string;
}) {
  // A SEASON THAT HAS NOT STARTED IS LEFT OUT, not drawn as a zero. The table
  // prints an em-dash for those for exactly this reason: a term beginning in
  // September, charted as a zero column in August, reads as the club having
  // collapsed rather than as a term that has not happened yet. This is not a
  // rare case here — a club sets its next season up while playing the current
  // one, so there is almost always one ahead of the calendar.
  const started = seasons.filter((s) => hasStarted(s, now));
  // Oldest first: the table's newest-first order is right for finding a row and
  // backwards for a time axis. The cap keeps the most RECENT terms, which is
  // where the trend anybody acts on lives.
  const terms = started.slice(0, MAX_TERMS).reverse();
  const labels = uniqueColumnLabels(terms.map((s) => s.name));

  const matches = buildColumns(
    terms.map((s, i) => ({ label: labels[i]!, value: matchCounts.get(s.id) ?? 0 })),
  );
  const players = buildColumns(
    terms.map((s, i) => ({ label: labels[i]!, value: playerCounts.get(s.id) ?? 0 })),
  );

  return (
    <Card padding={false}>
      <PanelLabel
        label="Term over term"
        note={terms.length > 0 ? 'Oldest first' : undefined}
        className="px-5 pt-5 pb-3.5"
      />
      <div className="space-y-6 px-5 pb-5">
        {terms.length === 0 ? (
          // Every season the club has is still ahead of the calendar — the
          // ordinary state of a brand-new club, and of staging. An axis with
          // nothing on it would be worse than this sentence.
          <ChartNote>
            {seasons.length === 0
              ? 'No season has been created yet. Terms appear here once the club has played one.'
              : 'No season has started yet, so there is nothing to compare. The first term appears here on its start date.'}
          </ChartNote>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-xs text-[var(--text-muted)]">
                Matches recorded in each term.
              </p>
              <ColumnChart columns={matches} tone="var(--color-accent)" format={count} />
            </div>
            <div className="space-y-2 border-t border-[var(--border)] pt-5">
              <p className="text-xs text-[var(--text-muted)]">
                Members who played at least one of them.
              </p>
              <ColumnChart columns={players} tone="var(--color-info)" format={count} />
            </div>
            {/* A term that has started but has nothing in it yet is a real zero
                and is drawn as one — an empty tick with its figure under it.
                Said here because the newest column is almost always that, and a
                reader seeing the club's current term at the floor deserves to
                know whether it is a collapse or a calendar. */}
            <p className="text-xs text-[var(--text-muted)]">
              A term at zero has started and has nothing recorded in it yet. Terms that have
              not begun are left out entirely.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
