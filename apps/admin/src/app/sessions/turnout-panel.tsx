import { Card } from '@badminton/ui';
import type { AttendanceStatus } from '@badminton/shared';
import { buildColumns, uniqueColumnLabels } from '@/lib/charts';
import { ChartFigure, ChartNote, ColumnChart, MICRO, chartDay, count } from '@/components/charts';

/**
 * IS TURNOUT HOLDING UP? — the one question this page holds every number for
 * and cannot answer.
 *
 * The stat strip prints an AVERAGE and the table prints a per-night count in a
 * list. Neither is a trend: a mean says nothing about whether the club is
 * filling up or emptying out, and a column of figures read top to bottom is a
 * sequence a human has to hold in their head. A column per night in date order
 * IS that shape, and "the Wednesday drop-in has halved since we moved it" comes
 * straight off it in a way the table never gives up.
 *
 * THE WEEKDAY AND THE TRACK ARE ON THE TICK, which is what makes this one panel
 * rather than two. "Is Wednesday dying?" is a question about a night across the
 * term, not about Wednesday against Monday, so it is answered by labelling the
 * series — not by a second chart averaging turnout per weekday, which would
 * answer the different and weaker question of which night is busier.
 *
 * TWO BUCKETS, NOT FOUR. `session_attendance.status` carries four values
 * (checked_in | present | no_show | excused) and the honest split is the one
 * the page already makes everywhere else: somebody either turned up or they did
 * not. Clubwide on staging, `present` and `excused` are entirely unused, so a
 * four-segment stack would draw two invisible bands and read as broken — and
 * even on a club that used all four, `under` is documented for two parts of ONE
 * observed quantity and three stacked segments cannot be compared by eye.
 *
 * WHAT THE COLUMN'S TOTAL IS, exactly: the roll AS AN OFFICER TOOK IT. It is
 * not the club and it is not the RSVP list — a member who never appeared and
 * was never marked has no row at all, so a fifteen-high column on a
 * hundred-member club is not "15% turnout". The panel says that in words,
 * because a stack always implies a denominator and this one's is smaller than a
 * reader would assume.
 *
 * NO QUERY OF ITS OWN, and no new capability. Every session and every
 * attendance row it draws was already fetched by the page under `sessions.page`
 * to render the table and the stat strip. Nothing here touches `club_fees`,
 * `players` or anything else behind another area's key — see the note on the
 * fee lookup in page.tsx for why that separation matters on this screen in
 * particular.
 */

/** How many nights fit across a card before the ticks stop being readable. */
const MAX_NIGHTS = 10;

/** One night, folded from rows the page already holds. */
export interface TurnoutNight {
  id: string;
  /** `YYYY-MM-DD`, the session's own club-local date. */
  date: string;
  /** 'competitive' | 'recreational' — the session's track, for the tick. */
  track: string | null;
  /** Every attendance row on this night, whatever its status. */
  statuses: readonly AttendanceStatus[];
}

/** Turned up. The same predicate the door feed and the average already use. */
const arrived = (status: AttendanceStatus) => status === 'checked_in' || status === 'present';

/**
 * `WED · REC` — the weekday and the track, under the date.
 *
 * Formatted in UTC from a `YYYY-MM-DD` that is already a club-local calendar
 * date, for the same reason chartDay is: re-reading it through the club's zone
 * would shift it a second time and print the day before.
 */
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });

function tickNote(date: string, track: string | null): string {
  const weekday = WEEKDAY_FMT.format(new Date(`${date}T12:00:00Z`)).toUpperCase();
  if (!track) return weekday;
  // COMPETITIVE and RECREATIONAL do not fit under a column at 10px beside a
  // date, and the tick truncates rather than wrapping, so they are cut to the
  // three letters that still tell the two apart.
  return `${weekday} · ${track.slice(0, 3).toUpperCase()}`;
}

export function TurnoutPanel({
  nights,
  today,
  seasonName,
}: {
  /** Every session in scope with its attendance rows, in date order. */
  nights: readonly TurnoutNight[];
  /** Club-local today, so tonight can be marked as still running. */
  today: string;
  /** The season in scope, or null when the club has none active. */
  seasonName: string | null;
}) {
  // A NIGHT THAT HAS NOT HAPPENED IS LEFT OUT, not drawn as a zero. A session
  // booked for next Saturday, charted today, would otherwise put the club at
  // the floor and read as a collapse rather than as a calendar — the same lie
  // /seasons' trend panel refuses for a term that has not started.
  const held = nights.filter((n) => n.date <= today);

  // A PAST NIGHT WITH NO ROLL TAKEN IS ALSO LEFT OUT, and that is a different
  // exclusion from the one above. No attendance row at all means nobody wrote
  // anything down — a cancelled night, or a door nobody worked — and charting
  // it as zero would assert that nobody came. A night where every single person
  // was marked no_show is NOT this case: the roll was taken, the answer was
  // nobody, and that is a real zero which is drawn as one.
  //
  // This is a stricter test than the stat strip's average, which counts a night
  // as played only when somebody ARRIVED and so silently drops a night the club
  // actually recorded as a washout.
  const drawn = held.filter((n) => n.statuses.length > 0);
  const skipped = held.length - drawn.length;

  // The most recent nights, because that is where a trend anybody acts on
  // lives. Kept in date order after the cap so the axis still reads forwards.
  const shown = drawn.slice(-MAX_NIGHTS);

  // `sessions` permits two rows on one date — the page's own comment says so —
  // and ColumnChart keys its columns by label, so without this the second of
  // two nights on one date would vanish into the first.
  const labels = uniqueColumnLabels(shown.map((n) => chartDay(n.date)));

  const columns = buildColumns(
    shown.map((night, i) => {
      const turnedUp = night.statuses.filter(arrived).length;
      return {
        label: labels[i]!,
        value: turnedUp,
        // Marked and did not come. `under` rather than a second chart because
        // these two ARE parts of one observed quantity — the roll as taken.
        under: night.statuses.length - turnedUp,
        note: tickNote(night.date, night.track),
      };
    }),
  );

  const totalRoll = shown.reduce((n, night) => n + night.statuses.length, 0);
  const totalUp = shown.reduce((n, night) => n + night.statuses.filter(arrived).length, 0);

  return (
    <Card padding={false}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <h2 className="font-[family-name:var(--display)] text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]">
          Turnout by night
        </h2>
        {shown.length > 0 && <span className={MICRO}>Oldest first</span>}
      </div>
      <div className="space-y-4 px-4 py-4">
        {shown.length === 0 ? (
          <ChartNote>
            {held.length === 0
              ? `No session in ${seasonName ?? 'this schedule'} has been held yet. A column appears for each night once it has been played and its door list has been taken.`
              : 'No door list has been taken on any night held so far, so there is no turnout to draw. Open a session’s door list to mark who came.'}
          </ChartNote>
        ) : (
          <>
            <ChartFigure
              label="Turned up"
              value={String(totalUp)}
              sub={`Across ${shown.length} ${shown.length === 1 ? 'night' : 'nights'} of ${totalRoll} marked on the door.`}
            />
            {/* Turnout on the baseline and the absences stacked above it: the
                part standing on the floor has to be the one the chart is about,
                or the absences read as holding the attendance up. */}
            <ColumnChart
              columns={columns}
              tone="var(--color-success)"
              underTone="var(--border-hover)"
              format={count}
            />
            {skipped > 0 && (
              // Conditional, because on most terms it describes nothing. Said
              // when it does, so a reader counting columns against the table
              // above finds the nights that are missing rather than doubting
              // both.
              <p className="text-xs text-[var(--text-muted)]">
                {skipped} held {skipped === 1 ? 'night has' : 'nights have'} no door list at all
                and {skipped === 1 ? 'is' : 'are'} left out — no roll was taken, which is not
                the same as nobody coming.
              </p>
            )}
            {drawn.length > shown.length && (
              <p className="text-xs text-[var(--text-muted)]">
                The most recent {MAX_NIGHTS} nights are shown; {drawn.length - shown.length}{' '}
                earlier {drawn.length - shown.length === 1 ? 'night is' : 'nights are'} in the
                table below.
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
