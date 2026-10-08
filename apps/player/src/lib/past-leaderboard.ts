// The finished season's ladder, /leaderboard?season=<id>.
//
// DRIVEN FROM THE ARCHIVE. `season_final_ratings` is the roster of record for a
// term that is over: every row in it is somebody who was on the ladder when the
// club closed that season off, and there is no row for anybody who was not. This
// module never starts from a player list, and it has no fallback to `ratings`:
// that table is cumulative and was rebased at the rollover, so it is not an
// answer to "where did the club finish Fall 2026" for anyone.
//
// It also duplicates get_leaderboard()'s three visibility predicates in the app
// layer. That looks redundant beside the same filters in the query, and is not:
// the caller reads `season_final_ratings` under the SERVICE ROLE, because 00128
// revoked anon's grants on that table and on `players`, so a logged-out visitor
// cannot read it at all through the anon key. The service role bypasses RLS and
// is not the SECURITY DEFINER function. There is no database backstop behind
// this read, and a dropped filter in the query is an opted-out member on a
// public page with nothing to catch it.

import type { LeaderboardEntry } from '@/app/leaderboard/leaderboard-client';

/** The season a past-season ladder is showing, as its header needs it. */
export type PastSeasonView = {
  id: string;
  name: string;
  /** `formatSeasonRange` output, already club-local. */
  range: string;
  /**
   * The day the club archived the ladder, already through the club's clock and
   * formatted: `archived_at` is a TIMESTAMPTZ, so the caller converts it.
   * Null when the archive has no rows to take it from.
   */
  archivedAt: string | null;
};

/** The embedded member on an archived row, narrowed to what a ladder needs. */
export type SnapshotPlayer = {
  id: string;
  full_name: string;
  handle: string | null;
  avatar_url?: string | null;
  status: string;
  /** Optional so a select that forgot to ask arrives as undefined, not true. */
  active_flag?: boolean;
  hide_from_leaderboard?: boolean;
};

/** One archived ladder row with its member embedded. */
export type SnapshotRow = {
  singles_elo: number;
  doubles_elo: number;
  archived_at: string;
  /**
   * EITHER SHAPE. PostgREST may hand a to-one embed back as an array rather than
   * an object, and supabase-js types this one as an array from the select string,
   * so the union is declared and normalised before it is read. The same idiom
   * past-season.tsx uses on its own embeds.
   */
  player: SnapshotPlayer | SnapshotPlayer[] | null;
};

/**
 * The statuses that have no place on a ladder.
 *
 * MIRRORS 00092_member_handle_and_number.sql:749-751, which is the source of
 * truth: `p.status NOT IN ('pending_approval', 'suspended')`. If that list ever
 * changes, this one changes with it.
 */
export const HIDDEN_LADDER_STATUSES = ['pending_approval', 'suspended'] as const;

/**
 * May this member appear on a ladder today?
 *
 * `=== true` / `=== false` rather than truthiness, so a column left out of a
 * select arrives as `undefined` and FAILS CLOSED. The alternative spelling
 * (`p.active_flag !== false`) turns a query that forgot to ask for the column
 * into a page that shows everybody.
 */
export function isVisibleOnLadder(p: Pick<
  SnapshotPlayer,
  'status' | 'active_flag' | 'hide_from_leaderboard'
>): boolean {
  return (
    p.active_flag === true &&
    p.hide_from_leaderboard === false &&
    !(HIDDEN_LADDER_STATUSES as readonly string[]).includes(p.status)
  );
}

/**
 * Archived rows to ladder entries.
 *
 * The entry carries the archived Elo and NOTHING ELSE. No record, no
 * provisional flag, no streak, no tournament points: every one of those is an
 * all-time counter that was never scoped to a season, so putting it beside a
 * closing Elo would state one figure about the term and three about a career in
 * the same line. The absent fields are what make that impossible rather than
 * merely unwise.
 */
export function pastLeaderboardEntries(rows: SnapshotRow[]): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  for (const row of rows) {
    const raw = row.player;
    const player = (Array.isArray(raw) ? raw[0] : raw) ?? null;
    if (!player) continue;
    if (!isVisibleOnLadder(player)) continue;
    entries.push({
      id: player.id,
      full_name: player.full_name,
      handle: player.handle,
      avatar_url: player.avatar_url ?? null,
      status: player.status,
      ratings: {
        singles_elo: row.singles_elo,
        doubles_elo: row.doubles_elo,
      },
    });
  }
  return entries;
}
