// The pure half of the My stats screen. Mirrors the current-season branch of
// apps/player/src/app/my-stats/page.tsx.
import type { SeasonMatchRow } from '@badminton/shared/src/utils/season-record';

/** The match window the web reads: a season and a half of heavy play. */
export const MATCH_WINDOW = 200;
/** How many of those get a row in the recent list. */
export const HISTORY_ROWS = 20;

/** The web's select, verbatim, so both apps read the same rows. */
export const MY_MATCHES_SELECT =
  'id, season_id, played_at, match_type, format, rated_flag, completed_flag, result_status, score_summary, participants:match_participants!inner(id, player_id, win_flag, rating_delta, post_rating, team_side, points_scored, points_allowed)';

export interface OwnParticipant {
  player_id: string;
  win_flag: boolean | null;
  rating_delta: number | null;
  points_scored: number | null;
  points_allowed: number | null;
}

export interface MyMatchRow {
  id: string;
  season_id: string | null;
  played_at: string | null;
  match_type: string | null;
  result_status: string | null;
  score_summary: string | null;
  participants: unknown;
}

/**
 * The member's own participant row, matched on player_id rather than taken as
 * the first element: if the embed filter ever stops narrowing the array, the
 * first element is an OPPONENT and every figure is plausibly wrong.
 */
export function ownParticipant(match: { participants: unknown }, playerId: string): OwnParticipant | null {
  const raw = match.participants;
  const rows = (Array.isArray(raw) ? raw : raw ? [raw] : []) as OwnParticipant[];
  return rows.find((p) => p.player_id === playerId) ?? null;
}

/**
 * The rows summarizeSeason counts: this season's matches only. Counted from
 * match rows and never read off `ratings`, whose win and loss columns are
 * lifetime figures that survive every rollover.
 */
export function seasonRecordRows(
  matches: readonly MyMatchRow[],
  activeSeasonId: string | null,
  playerId: string,
): SeasonMatchRow[] {
  if (activeSeasonId === null) return [];
  return matches
    .filter((m) => m.season_id === activeSeasonId)
    .map((m) => {
      const p = ownParticipant(m, playerId);
      return {
        match_type: m.match_type,
        result_status: m.result_status,
        win_flag: p?.win_flag ?? null,
        points_scored: p?.points_scored ?? null,
        points_allowed: p?.points_allowed ?? null,
        played_at: m.played_at,
      };
    });
}
