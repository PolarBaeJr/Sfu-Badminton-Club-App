// The arithmetic behind /my-stats?season=<past season>, kept apart from the
// page that draws it.
//
// A member can look back at a term they played, and every figure on that screen
// has to come from a row that was written AT THE TIME. The club stores less
// about a finished season than it feels like it does, so most of the work here
// is deciding what may honestly be shown and what has no source at all:
//
//   - `matches.season_id` is stamped with whichever season was active when the
//     result was entered, and the app refuses to write NULL, so every match
//     belongs to exactly one season. A season's match list is therefore real.
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
//     that screen, in any season.
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
}

/**
 * A result the club considers settled.
 *
 * `confirmed` is the ordinary path. `walkover` is the unrated forfeit: 00003
 * stamps `win_flag` on it just as a played match does, and somebody really was
 * awarded that match, so leaving it out would drop a win the member was given.
 *
 * `disputed` and `voided` are the two that must not count. Voiding sets
 * `result_status` and does NOT clear `win_flag`, so a filter written on
 * `win_flag` alone counts matches the club has struck off — which is why the
 * status is checked and not just the flag.
 *
 * `pending_submission`, `pending_confirmation` and `incomplete` never have a
 * `win_flag` at all, so they fall out of the tally either way; they are excluded
 * here as well so that the list and the tally are decided by ONE predicate.
 */
export const SETTLED_RESULT_STATUSES = ['confirmed', 'walkover'] as const;

/** One of the member's matches in a season, reduced to what the tallies read. */
export interface SeasonMatchRow {
  match_type: string | null;
  result_status: string | null;
  win_flag: boolean | null;
  points_scored: number | null;
  points_allowed: number | null;
  played_at: string | null;
}

/**
 * Did this match end in a win or a loss for the member?
 *
 * `true` / `false` / `null`, where null means "no result to count" — pending,
 * disputed, voided, or a row whose winner was never stamped. The match table on
 * the page renders WIN / LOSS / an em dash off this same function, so the record
 * beside it can never disagree with the rows it is a summary of.
 */
export function settledOutcome(row: SeasonMatchRow): boolean | null {
  const status = row.result_status;
  if (status === null) return null;
  if (!(SETTLED_RESULT_STATUSES as readonly string[]).includes(status)) return null;
  return row.win_flag === true ? true : row.win_flag === false ? false : null;
}

export interface DisciplineRecord {
  wins: number;
  losses: number;
}

export interface SeasonRecord {
  singles: DisciplineRecord;
  doubles: DisciplineRecord;
  /** Both disciplines together — what "how did my term go" actually asks. */
  wins: number;
  losses: number;
  /** Settled matches. Not the number of rows: unsettled ones are not a record. */
  played: number;
  /** Points won minus points conceded, over settled matches only. */
  pointDiff: number;
  /** Longest run of wins anywhere in the season, oldest to newest. */
  bestWinStreak: number;
}

/**
 * The member's record for one season, counted from that season's own match rows.
 *
 * Counted, never read off `ratings`. That table is cumulative across every
 * season a member has played and is REBASED at a rollover — compressed toward
 * the mean, or under the 'full' policy reset outright with every counter zeroed
 * (00068). Its win column has therefore never been an answer to "how did I do in
 * Fall 2026", and for a club that has ever run a full reset it is not even an
 * answer to "how have I done overall".
 *
 * `rows` may arrive in any order; the streak sorts by `played_at` itself. A row
 * with no date cannot be placed in that order, so it counts toward the record
 * and is skipped by the streak rather than being dropped from both.
 */
export function summarizeSeason(rows: readonly SeasonMatchRow[]): SeasonRecord {
  const record: SeasonRecord = {
    singles: { wins: 0, losses: 0 },
    doubles: { wins: 0, losses: 0 },
    wins: 0,
    losses: 0,
    played: 0,
    pointDiff: 0,
    bestWinStreak: 0,
  };

  for (const row of rows) {
    const won = settledOutcome(row);
    if (won === null) continue;

    record.played += 1;
    if (won) record.wins += 1;
    else record.losses += 1;
    record.pointDiff += (row.points_scored ?? 0) - (row.points_allowed ?? 0);

    // Anything that is not singles is counted as doubles rather than being
    // silently dropped: `match_type` is an enum of exactly those two, and a
    // discipline split whose halves do not add up to the total is a worse
    // failure than one that mis-files a value the database cannot hold.
    const bucket = row.match_type === 'singles' ? record.singles : record.doubles;
    if (won) bucket.wins += 1;
    else bucket.losses += 1;
  }

  let run = 0;
  const dated = rows
    .filter((r): r is SeasonMatchRow & { played_at: string } => r.played_at !== null)
    // ISO 8601 sorts lexicographically, so this is a string compare and not a
    // Date construction per element.
    .sort((a, b) => a.played_at.localeCompare(b.played_at));
  for (const row of dated) {
    const won = settledOutcome(row);
    if (won === null) continue;
    run = won ? run + 1 : 0;
    if (run > record.bestWinStreak) record.bestWinStreak = run;
  }

  return record;
}

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
    .filter((s) => !s.active_flag && (archivedSeasonIds.has(s.id) || s.id === selectedId))
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
 * A DATE column as `1 SEP 2026`.
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
