// The record a member actually posted in one season, counted from that
// season's own match rows.
//
// This lived in apps/player/src/lib/season-history.ts and moved here unchanged
// when the ADMIN console needed the same arithmetic: its member page was
// showing a past season's archived Elo on top of today's live cumulative
// counters, because `season_final_ratings` archives elo and nothing else. Two
// apps answering "how did they do that term" must answer it the same way, so
// the tally lives in one place and both import it.
//
// Pure: no Supabase, no React, no clock. Everything here is arithmetic over
// rows the caller has already fetched and already scoped to one season.

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
