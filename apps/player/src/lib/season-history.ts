// The arithmetic behind /my-stats?season=<past season>, kept apart from the
// page that draws it.
//
// A member can look back at a term they played, and every figure on that screen
// has to come from a row that was written AT THE TIME. The club stores less
// about a finished season than it feels like it does, so most of the work here
// is deciding what may honestly be shown and what has no source at all:
//
//   - `matches.season_id` is stamped with whichever season was active when the
//     result was entered. THIS COMMENT USED TO SAY THE APP REFUSES TO WRITE
//     NULL. It does not: `submit_match_result` does an unguarded
//     `SELECT id INTO v_season FROM seasons WHERE active_flag LIMIT 1`, so a
//     result entered while no season is active is stamped NULL and drops out
//     of every season-scoped view here, silently and permanently. Verified
//     against the live function on prod 2026-09-19; no such rows exist yet.
//     A season's match list is real only for as long as that stays true.
//   - `season_final_ratings` holds the whole ladder's Elo at the moment the club
//     activated the NEXT season, and 00084 keeps it correct when an old match is
//     corrected. It is the only record of where somebody finished a term.
//   - RANK is not stored anywhere. `season_snapshots` has a `singles_rank`
//     column but nothing writes it (the edge function that would is invoked by
//     hand and never has been, and the `capture_season_snapshot` RPC its types
//     claim does not exist in the database). It cannot be reconstructed from
//     `season_final_ratings` either: that table holds an Elo and a player id and
//     nothing else, while the ladder ranks only ESTABLISHED members and hides
//     pending, suspended, deactivated and hidden ones. Ranking the archive ranks
//     a different population than the member ever saw. So there is no rank on
//     /my-stats, in any season.
//
//     THE LEADERBOARD'S PAST-SEASON VIEW DOES RANK THE ARCHIVE, and the
//     distinction is what it says about the number rather than how it is
//     computed: it is a club-wide standings table, it sorts the archive under
//     TODAY's visibility rules, and its own legend states that the places are not
//     the places members saw at the time. A single "you finished #14" on a
//     member's own page carries none of that and would simply read as a fact. See
//     lib/past-leaderboard.ts.
//
// Everything here is pure and takes the club's day key as an argument rather
// than reading the clock, so "when did they join" can be tested rather than
// hoped for.

/** A `seasons` row, narrowed to what a season history needs. */
export interface HistorySeason {
  id: string;
  name: string;
  /** DATE column, `YYYY-MM-DD`. Club-local already; never parse it as a Date. */
  start_date: string;
  /** DATE column, and genuinely nullable — a season may be open-ended. */
  end_date: string | null;
  active_flag: boolean;
  /**
   * 00234. True keeps the season out of every MEMBER-facing history: the
   * leaderboard's past-season standings and the /my-stats picker. It is a
   * publication decision and nothing more, so nothing that reports on sessions
   * or money may filter on it.
   *
   * Optional because the column is NOT NULL in the database but this interface
   * describes a PostgREST payload, and a caller that has not added it to its
   * select list, or a database without 00234 applied, hands back a row with no
   * such key. Every read must therefore treat `undefined` as "not hidden",
   * which is the safe default: it publishes a season that should have been
   * published rather than silently blanking club history on a bad select.
   */
  hidden_flag?: boolean;
}

// The season tally moved to @badminton/shared so the ADMIN console could use
// the same arithmetic: its member page was drawing a past season's archived
// Elo over today's live counters. Re-exported here so every existing import of
// this module keeps working and there is still one obvious place to look.
export {
  SETTLED_RESULT_STATUSES,
  settledOutcome,
  summarizeSeason,
} from '@badminton/shared';
export type { SeasonMatchRow, DisciplineRecord, SeasonRecord } from '@badminton/shared';

/**
 * The seasons a member may look back on, newest first.
 *
 * "Past" is `active_flag = false` and NOTHING to do with the calendar. Season
 * dates are set by hand and routinely sit in the future — on staging today,
 * every one of the club's four seasons starts after the current date, including
 * the active one — so an `end_date < today` test answers a question about the
 * fixture data rather than about the club.
 *
 * `archivedSeasonIds` is the set of seasons this member has a `season_final_
 * ratings` row for, which is exactly the set of seasons that were closed off
 * while they were on the ladder. Using it as the filter keeps two kinds of
 * season out of the list without any date arithmetic: one that was created but
 * never activated (nothing happened in it, ever) and one that ended before the
 * member joined (nothing happened in it to them).
 *
 * `selectedId` is unioned in so that a link somebody was sent to a season
 * outside their own history still shows the season it names in the picker,
 * rather than a control that disagrees with the page under it.
 */
export function memberSeasonHistory(
  seasons: readonly HistorySeason[],
  archivedSeasonIds: ReadonlySet<string>,
  selectedId: string | null
): HistorySeason[] {
  return seasons
    .filter(
      (s) =>
        !s.active_flag &&
        // 00234, and it beats the `selectedId` clause below deliberately. That
        // clause exists so a season reached by direct link still names itself in
        // the control; a HIDDEN season reached by direct link must not, because
        // putting it in the picker would re-publish the one thing the flag was
        // set to unpublish. Both callers redirect a hidden id before rendering,
        // so this is the second of two independent guards rather than the only
        // one. `=== true` keeps a row that arrived without the key visible.
        s.hidden_flag !== true &&
        (archivedSeasonIds.has(s.id) || s.id === selectedId)
    )
    .slice()
    .sort((a, b) => b.start_date.localeCompare(a.start_date));
}

/**
 * The list the season control offers: the season that is running now, then every
 * past season the member has something in.
 *
 * The active season leads rather than sorting in by date, because it is "now"
 * and not a date — and because a club whose next term is already in the database
 * would otherwise sort a season that has not started above the one being played.
 */
export function seasonPickerOptions(
  seasons: readonly HistorySeason[],
  archivedSeasonIds: ReadonlySet<string>,
  selectedId: string | null
): HistorySeason[] {
  const active = seasons.filter((s) => s.active_flag);
  return [...active, ...memberSeasonHistory(seasons, archivedSeasonIds, selectedId)];
}

/**
 * Every finished season, for a picker on a CLUB-WIDE screen.
 *
 * The counterpart to the `archivedSeasonIds` /my-stats passes, which offers only
 * the terms the reader has an archived row of their own in. The leaderboard's
 * ladder and the tournament calendar are the club's and not anybody's history,
 * so every season that is not the active one is offered, including one that was
 * created and never rolled over. That season's page is empty, and its own empty
 * state says which of those two things happened.
 *
 * Lives here rather than in either page so the two cannot drift: a season this
 * offers is a season both of those screens must be willing to serve.
 */
export function finishedSeasonIds(seasons: readonly HistorySeason[]): Set<string> {
  // `hidden_flag === true` rather than a truthy test, so a row that arrived
  // without the key (see HistorySeason) stays offered rather than vanishing.
  // Each caller's direct-URL guard repeats this: dropping a season from the
  // picker hides the door, not the room, and the two have to agree.
  return new Set(
    seasons.filter((s) => !s.active_flag && s.hidden_flag !== true).map((s) => s.id)
  );
}

/**
 * Whether the member joined the club after a season had finished — or `null`
 * when that cannot be answered.
 *
 * Null is the point of the function. `end_date` is nullable, and a season with
 * no end has no "after" to be later than; the next season's start is the only
 * other honest boundary, and when there is no next season either the club has
 * simply not recorded when that term stopped. Guessing produces the worst
 * possible line on this screen — telling somebody they were not in the club for
 * a term they played.
 *
 * Both sides are `YYYY-MM-DD` CLUB day keys and are compared as strings.
 * `players.created_at` is a TIMESTAMPTZ and the season columns are DATEs, so the
 * caller must pass `clubDayKey(created_at, CLUB_TIMEZONE)` — comparing the two
 * through `new Date()` parses the DATE as UTC midnight, which lands on the
 * previous evening in Vancouver and reports a member who joined on the last day
 * of a term as having missed it.
 */
export function joinedAfterSeason(
  joinedDayKey: string | null,
  seasonEndDate: string | null,
  nextSeasonStartDate: string | null
): boolean | null {
  if (!joinedDayKey) return null;
  const boundary = seasonEndDate ?? nextSeasonStartDate;
  if (!boundary) return null;
  return joinedDayKey > boundary.slice(0, 10);
}

/**
 * The season immediately after `seasonId`, by start date, or null if it is the
 * latest one on record. Used only to bound an open-ended season.
 */
export function nextSeasonAfter(
  seasons: readonly HistorySeason[],
  seasonId: string
): HistorySeason | null {
  const ordered = seasons.slice().sort((a, b) => a.start_date.localeCompare(b.start_date));
  const index = ordered.findIndex((s) => s.id === seasonId);
  if (index < 0) return null;
  return ordered[index + 1] ?? null;
}

/** `1 SEP 2026 — 31 DEC 2026`, `FROM 1 SEP 2026` when the term has no end. */
export function formatSeasonRange(season: HistorySeason): string {
  const start = formatDayKey(season.start_date);
  if (!season.end_date) return `FROM ${start}`;
  return `${start} — ${formatDayKey(season.end_date)}`;
}

/** Three letters each, so the range fits beside a season name at 360px. */
const MONTH_LABELS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

/**
 * A club-local day key — `YYYY-MM-DD` — as `1 SEP 2026`.
 *
 * A DAY KEY, which is what a Postgres DATE column already is. A TIMESTAMPTZ is
 * NOT one and must be put through `clubDayKey` first: this takes the leading ten
 * characters, and every instant after 16:00 in Vancouver carries the following
 * day's date in UTC, so a timestamp handed straight in reads a day late for a
 * whole evening. There is a test that pins exactly this.
 *
 * Two things this deliberately does not do.
 *
 * It does not hand the string to `new Date()`: `new Date('2026-09-01')` is UTC
 * midnight, which renders as 31 August anywhere west of Greenwich — a season
 * that visibly starts the day before the club says it does. The parts are split
 * and read directly instead, so no zone is involved at all.
 *
 * And it does not go through `Intl` for the month. A `month: 'short'` format
 * renders September as "SEPT" or "SEP" depending on which ICU the runtime was
 * built with, so the same date reads differently on a member's phone and in a
 * test. The table below is three letters everywhere, forever.
 */
export function formatDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.slice(0, 10).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dayKey;
  const month = MONTH_LABELS[(m as number) - 1];
  if (!month) return dayKey;
  return `${d} ${month} ${y}`;
}

export type SeasonEmptyReason =
  | 'joined-later'
  | 'no-matches-but-on-ladder'
  | 'nothing-on-record'
  | 'has-matches';

/**
 * Why a past season has no matches to show — which is three genuinely different
 * situations that must not read as one broken screen.
 *
 * Ordered so the most specific true statement wins. A member who has an archived
 * rating for the term was demonstrably on the ladder for it, so they were in the
 * club whatever the join date suggests; that check comes first and the join-date
 * comparison is only reached when there is nothing else to go on.
 */
export function seasonEmptyReason(input: {
  matchCount: number;
  hasArchivedRating: boolean;
  joinedAfter: boolean | null;
}): SeasonEmptyReason {
  if (input.matchCount > 0) return 'has-matches';
  if (input.hasArchivedRating) return 'no-matches-but-on-ladder';
  if (input.joinedAfter === true) return 'joined-later';
  return 'nothing-on-record';
}
