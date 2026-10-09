// A STAGE'S ROWS AS THEY ARE INSERTED, and the courts they go on. Pure, and NOT
// 'use server' (which may export only async functions), so stages.ts can use it
// and a test can reach it.

import { courtLabel, resolveCourtLabels, type StageRow, type TournamentCourt } from '@badminton/shared';

/**
 * The court ids a stage's court labels resolve to (00273).
 *
 *   courts null    the database is older than 00273: no ids, and no court_id
 *                  column to write (courtIds null).
 *   courts empty   the tournament lists no courts: the labels stay text only.
 *   otherwise      every label must name an ACTIVE court; the rest are returned
 *                  in `unknown` for the draw to refuse before it tears anything
 *                  down.
 */
export function resolveStageCourts(
  courts: readonly TournamentCourt[] | null,
  rows: readonly Pick<StageRow, 'court'>[],
): { courtIds: Map<string, string> | null; unknown: string[] } {
  if (courts === null) return { courtIds: null, unknown: [] };
  if (courts.length === 0) return { courtIds: new Map(), unknown: [] };
  const labels = [...new Set(rows.map((r) => r.court).filter((c): c is string => !!c))];
  const { byLabel, unknown } = resolveCourtLabels(courts, labels);
  return { courtIds: new Map([...byLabel].map(([label, court]) => [label, court.id])), unknown };
}

/** What the organiser is told when a stage names courts the tournament does not have. */
export function unknownStageCourtsMessage(unknown: readonly string[]): string {
  if (unknown.length === 1) {
    return `${courtLabel(unknown[0]) ?? unknown[0]} in this stage is missing from the tournament's courts or switched off. `
      + 'Fix it in Courts on the tournament page, or change the stage.';
  }
  return `Courts ${unknown.map((l) => l.trim()).join(', ')} in this stage are missing from the tournament's courts or switched off. `
    + 'Fix them in Courts on the tournament page, or change the stage.';
}

/**
 * One row of tournament_matches for a stage. `courtIds` null means the
 * database has no court_id column yet, so the key is left out entirely.
 */
export function rowForInsert(
  eventId: string,
  r: StageRow,
  doubles: boolean,
  courtIds: ReadonlyMap<string, string> | null = null,
): Record<string, unknown> {
  const side = (s: 'a' | 'b') => (doubles ? `pair_${s}_id` : `participant_${s}_id`);
  return {
    id: r.id,
    event_id: eventId,
    draw_generation_id: r.draw_generation_id,
    stage: r.stage,
    pool_number: r.pool_number,
    group_number: r.group_number,
    slot: r.slot,
    match_label: r.match_label,
    court: r.court,
    ...(courtIds ? { court_id: (r.court && courtIds.get(r.court)) || null } : {}),
    round_number: r.round_number,
    round_name: r.round_name,
    bracket_position: r.bracket_position,
    match_number: r.match_number,
    games_per_match: r.games_per_match,
    points_per_game: r.points_per_game,
    handicap_a: r.handicap_a,
    handicap_b: r.handicap_b,
    is_bye: r.is_bye,
    is_third_place: r.is_third_place,
    status: r.status,
    winner_to_match_id: r.winner_to_match_id,
    winner_to_position: r.winner_to_position,
    loser_to_match_id: r.loser_to_match_id,
    loser_to_position: r.loser_to_position,
    [side('a')]: r.a,
    [side('b')]: r.b,
    ...(r.winner ? { [doubles ? 'winner_pair_id' : 'winner_participant_id']: r.winner } : {}),
  };
}
