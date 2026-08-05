// Internal helpers for the tournament server actions. NOT a 'use server'
// module — these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files.
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import {
  calculateEloUpdate,
  getKFactor,
  getFormatWeight,
  isDoublesEvent,
  isOutOfEvent,
  isOpenMatch,
  forfeitOutcome,
  OPEN_MATCH_STATUSES,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentMatchFormat,
  MatchFormat,
  RatingSettings,
} from '@badminton/shared';

// The tournament engine rates matches in TypeScript while challenges are rated
// by apply_match_result in SQL. Both must read the SAME knobs or the identical
// scoreline moves ratings differently depending on where it was played — the
// cross-engine hazard the rounding comment in the Elo engine already warns
// about. This is the TS half of migration 00041.
//
// Fetched per call rather than cached: finalising an event is not a hot path,
// and a cache is how a mid-tournament settings change ends up applying to some
// matches and not others.
async function getRatingSettings(
  adminClient: ReturnType<typeof createAdminClient>,
): Promise<RatingSettings | null> {
  const { data } = await adminClient
    .from('platform_settings')
    .select('value')
    .eq('key', 'rating_defaults')
    .maybeSingle();
  return (data?.value as RatingSettings | null) ?? null;
}

export { getExecOrAdmin } from '../actions/_shared';

// Revalidate both the tournament page and the event detail page so admin UIs
// reflect mutations immediately. Pass eventId whenever it is in scope.
export function revalidateEventPaths(tournamentId: string, eventId?: string) {
  revalidatePath(`/tournaments/${tournamentId}`);
  if (eventId) revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}

// Throws when the tournament is suspended. Called by mutating tournament
// actions before they touch data; corrective actions (void/edit/undo,
// lock/unlock draw) intentionally skip this gate.
export async function assertTournamentNotSuspended(
  adminClient: ReturnType<typeof createAdminClient>,
  tournamentId: string
) {
  const { data } = await adminClient.from('tournaments')
    .select('suspended_at, suspension_reason')
    .eq('id', tournamentId)
    .single();
  if (data?.suspended_at) {
    const reason = data.suspension_reason;
    throw new Error(`Tournament is suspended${reason ? `: ${reason}` : ''}. Resume it to continue.`);
  }
}

// Map tournament match format to the shared elo engine's MatchFormat
function toEloFormat(mf: TournamentMatchFormat): MatchFormat {
  switch (mf) {
    case 'best_of_3_to_21': return 'bo3_21';
    case 'one_game_21': return 'single_21';
    case 'one_game_15': return 'single_15';
    case 'one_game_11': return 'single_11';
  }
}

// ============================================================
// Notification helper
// ============================================================

export async function notifyPlayers(
  adminClient: ReturnType<typeof createAdminClient>,
  playerIds: string[],
  title: string,
  body: string,
  metadata?: Record<string, unknown>,
  notificationType: 'general' | 'tournament_bracket_published' | 'tournament_match_ready' | 'tournament_match_result' | 'tournament_event_completed' | 'tournament_checkin_open' = 'general'
) {
  if (playerIds.length === 0) return;
  try {
    const rows = playerIds.map(pid => ({
      player_id: pid,
      type: notificationType,
      title,
      body,
      metadata: metadata ?? {},
    }));
    const { error } = await adminClient.from('notifications').insert(rows);
    if (error) throw error;
  } catch (err) {
    // Notifications are best-effort — never let a failure break the parent action.
    Sentry.captureException(err);
  }
}

// Pull the event/tournament context from a joined select on the UPDATE itself
// so participant/pair status mutations don't need a second round-trip just to
// figure out which paths to revalidate.
export const participantContextSelect = 'event_id, event:tournament_events(tournament_id)' as const;
export const pairContextSelect = 'event_id, event:tournament_events(tournament_id)' as const;

export function extractEventContext(row: { event_id?: unknown; event?: unknown } | null): { tid: string; eventId: string } | null {
  if (!row) return null;
  const eventId = row.event_id as string | undefined;
  const tid = (row.event as { tournament_id?: string } | null)?.tournament_id;
  if (!eventId || !tid) return null;
  return { tid, eventId };
}

/**
 * Standard tournament seeding positions.
 * For a bracket of size B, returns an array of length B where
 * index = bracket position, value = seed number (1-based).
 * Ensures seed 1 and 2 are on opposite halves, 3/4 in opposite quarters, etc.
 */
export function getStandardSeedPositions(bracketSize: number): number[] {
  if (bracketSize < 2) return [1];

  // Start with seeds 1 and 2
  let positions = [1, 2];

  while (positions.length < bracketSize) {
    const nextRound: number[] = [];
    const sum = positions.length * 2 + 1;
    for (const seed of positions) {
      nextRound.push(seed);
      nextRound.push(sum - seed);
    }
    positions = nextRound;
  }

  return positions;
}

// ============================================================
// Elo Integration
// ============================================================

export async function applyTournamentMatchElo(matchId: string) {
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match || match.status === 'voided' || match.is_bye) return;

  // Idempotency backstop: a populated elo_snapshot means this match's delta was
  // already applied. Re-applying would overwrite the snapshot and strand the
  // first delta with no way to reverse it, so refuse instead. Callers that
  // legitimately re-rate a match (editMatchResult) reverse the snapshot first,
  // which clears it.
  if (match.elo_snapshot) return;

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const matchFormat = event.match_format as TournamentMatchFormat;
  const eloMultiplier = Number(event.elo_multiplier) || 1.25;
  const eloFormat = toEloFormat(matchFormat);
  const formatWeight = getFormatWeight(eloFormat);

  // Per-player snapshot of this match's Elo change, persisted on the match row.
  // Enables perfect reversal in undoMatchResult / editMatchResult for both singles
  // and doubles regardless of how much state has drifted since.
  const snapshotEntries: Array<{
    player_id: string;
    before: number;
    after: number;
    delta: number;
  }> = [];
  const snapshotDiscipline: 'singles' | 'doubles' = doubles ? 'doubles' : 'singles';

  const nowIso = new Date().toISOString();

  if (doubles) {
    // For doubles, update both players in winning and losing pairs
    const winnerId = match.winner_pair_id;
    const loserId = match.loser_pair_id;
    if (!winnerId || !loserId) return;

    // Fetch both pairs in parallel.
    const [{ data: winnerPair }, { data: loserPair }] = await Promise.all([
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', loserId).single(),
    ]);

    if (!winnerPair || !loserPair) return;

    const winnerElo = winnerPair.combined_elo ?? 400;
    const loserElo = loserPair.combined_elo ?? 400;

    // Single batched ratings fetch for all 4 players
    const allPlayerIds = [winnerPair.player1_id, winnerPair.player2_id, loserPair.player1_id, loserPair.player2_id];
    const [{ data: ratings }, ratingSettings] = await Promise.all([
      adminClient.from('ratings')
        .select('player_id, doubles_elo, doubles_provisional, doubles_matches_played')
        .in('player_id', allPlayerIds),
      getRatingSettings(adminClient),
    ]);

    const computeFor = (playerId: string, opponentElo: number, won: boolean) => {
      const rating = ratings?.find(r => r.player_id === playerId);
      const before = rating?.doubles_elo ?? 400;
      const k = getKFactor('doubles', rating?.doubles_provisional ?? true, rating?.doubles_matches_played, ratingSettings);
      const result = calculateEloUpdate({
        playerRating: before,
        opponentRating: opponentElo,
        kFactor: k,
        formatWeight,
        eventMultiplier: eloMultiplier,
      bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
        won,
      });
      snapshotEntries.push({ player_id: playerId, before, after: result.newRating, delta: result.delta });
      return { playerId, newRating: result.newRating };
    };

    const computed = [
      computeFor(winnerPair.player1_id, loserElo, true),
      computeFor(winnerPair.player2_id, loserElo, true),
      computeFor(loserPair.player1_id, winnerElo, false),
      computeFor(loserPair.player2_id, winnerElo, false),
    ];

    // Issue all 4 rating UPDATEs in parallel
    const updateResults = await Promise.allSettled(
      computed.map(c => adminClient.from('ratings')
        .update({ doubles_elo: c.newRating, updated_at: nowIso })
        .eq('player_id', c.playerId))
    );
    for (const r of updateResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  } else {
    // Singles
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;
    if (!winnerId || !loserId) return;

    // Fetch both participants in parallel
    const [{ data: winnerP }, { data: loserP }] = await Promise.all([
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', loserId).single(),
    ]);

    if (!winnerP || !loserP) return;

    // Single batched ratings fetch
    const { data: ratings } = await adminClient.from('ratings')
      .select('player_id, singles_elo, singles_provisional, singles_matches_played')
      .in('player_id', [winnerP.player_id, loserP.player_id]);

    const winnerRating = ratings?.find(r => r.player_id === winnerP.player_id);
    const loserRating = ratings?.find(r => r.player_id === loserP.player_id);

    const winnerElo = winnerRating?.singles_elo ?? winnerP.elo_before ?? 400;
    const loserElo = loserRating?.singles_elo ?? loserP.elo_before ?? 400;

    const ratingSettings = await getRatingSettings(adminClient);
    const winK = getKFactor('singles', winnerRating?.singles_provisional ?? true, winnerRating?.singles_matches_played, ratingSettings);
    const loseK = getKFactor('singles', loserRating?.singles_provisional ?? true, loserRating?.singles_matches_played, ratingSettings);

    const winResult = calculateEloUpdate({
      playerRating: winnerElo,
      opponentRating: loserElo,
      kFactor: winK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
      won: true,
    });

    const loseResult = calculateEloUpdate({
      playerRating: loserElo,
      opponentRating: winnerElo,
      kFactor: loseK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      bounds: { min: ratingSettings?.min_elo, max: ratingSettings?.max_elo },
      won: false,
    });

    // Issue all 4 UPDATEs in parallel (2 ratings + 2 participants)
    const updateResults = await Promise.allSettled([
      adminClient.from('ratings')
        .update({ singles_elo: winResult.newRating, updated_at: nowIso })
        .eq('player_id', winnerP.player_id),
      adminClient.from('ratings')
        .update({ singles_elo: loseResult.newRating, updated_at: nowIso })
        .eq('player_id', loserP.player_id),
      adminClient.from('tournament_participants')
        .update({ elo_after: winResult.newRating, elo_change: winResult.delta })
        .eq('id', winnerId),
      adminClient.from('tournament_participants')
        .update({ elo_after: loseResult.newRating, elo_change: loseResult.delta })
        .eq('id', loserId),
    ]);
    for (const r of updateResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }

    snapshotEntries.push({ player_id: winnerP.player_id, before: winnerElo, after: winResult.newRating, delta: winResult.delta });
    snapshotEntries.push({ player_id: loserP.player_id, before: loserElo, after: loseResult.newRating, delta: loseResult.delta });
  }

  // Persist snapshot on the match row so undo/edit can reverse it perfectly.
  await adminClient.from('tournament_matches')
    .update({ elo_snapshot: { discipline: snapshotDiscipline, entries: snapshotEntries } })
    .eq('id', matchId);
}

// Reverse a previously applied Elo snapshot for a match. Resets ratings to their
// pre-match values and clears participant elo_after/elo_change for singles.
export async function reverseEloSnapshot(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>
) {
  const snapshot = match.elo_snapshot as {
    discipline: 'singles' | 'doubles';
    entries: Array<{ player_id: string; before: number; after: number; delta: number }>;
  } | null;
  if (!snapshot || !snapshot.entries?.length) return;

  const ratingColumn = snapshot.discipline === 'doubles' ? 'doubles_elo' : 'singles_elo';
  const playerIds = snapshot.entries.map(e => e.player_id);

  // Single batched fetch for all current ratings.
  const { data: currentRows, error: fetchErr } = await adminClient.from('ratings')
    .select(`player_id, ${ratingColumn}`)
    .in('player_id', playerIds);
  if (fetchErr) {
    Sentry.captureException(fetchErr);
    return;
  }

  const currentMap = new Map<string, number>();
  for (const row of currentRows ?? []) {
    const r = row as Record<string, unknown>;
    const elo = r[ratingColumn] as number | undefined;
    if (elo !== undefined) currentMap.set(r.player_id as string, elo);
  }

  const nowIso = new Date().toISOString();

  // Issue all reversal UPDATEs in parallel — independent rows, no contention.
  // Apply inverse delta regardless of drift so net effect is zero even if
  // intermediate matches moved the rating.
  const updatePromises = snapshot.entries
    .filter(e => currentMap.has(e.player_id))
    .map(e => adminClient.from('ratings')
      .update({ [ratingColumn]: (currentMap.get(e.player_id) as number) - e.delta, updated_at: nowIso })
      .eq('player_id', e.player_id));

  // Clear singles participant snapshots in the same parallel batch.
  if (snapshot.discipline === 'singles') {
    const participantIds = [match.winner_participant_id, match.loser_participant_id]
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (participantIds.length > 0) {
      updatePromises.push(adminClient.from('tournament_participants')
        .update({ elo_after: null, elo_change: null })
        .in('id', participantIds));
    }
  }

  // Clear the snapshot on the match row in the same batch.
  updatePromises.push(adminClient.from('tournament_matches')
    .update({ elo_snapshot: null })
    .eq('id', match.id as string));

  const results = await Promise.allSettled(updatePromises);
  for (const r of results) {
    if (r.status === 'rejected') Sentry.captureException(r.reason);
  }
}

// ============================================================
// Walkovers, advancement, and late withdrawals
// ============================================================

export type DrawExitStatus = 'withdrawn' | 'disqualified';

// Written onto a match forfeited automatically, so the opponent's walkover
// says why rather than just appearing.
export const FORFEIT_REASON: Record<DrawExitStatus, string> = {
  withdrawn: 'Opponent withdrew from the event',
  disqualified: 'Opponent was disqualified',
};

/**
 * The mechanical half of a walkover: stamp the result on the match, rate it,
 * and advance the winner. Shared by the admin's manual walkover entry and by
 * the forfeit cascade a late withdrawal triggers, so both write an identical
 * match row — including the elo_snapshot that undo/edit reverse. A second
 * hand-rolled forfeit path would be a second set of rating invariants.
 *
 * Always rated. Every caller reaches here only on a live event: a walkover
 * recorded earlier could not be rated at all, and it would count as a result,
 * which blocks regenerating the draw — the remedy that belongs at that stage.
 */
export async function recordWalkover(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  winnerPosition: 'a' | 'b',
  reason: string,
  enteredBy: string,
) {
  const matchId = match.id as string;

  const winnerId = (doubles
    ? (winnerPosition === 'a' ? match.pair_a_id : match.pair_b_id)
    : (winnerPosition === 'a' ? match.participant_a_id : match.participant_b_id)) as string | null;
  const loserId = (doubles
    ? (winnerPosition === 'a' ? match.pair_b_id : match.pair_a_id)
    : (winnerPosition === 'a' ? match.participant_b_id : match.participant_a_id)) as string | null;

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  await adminClient.from('tournament_matches').update({
    status: 'walkover',
    walkover_winner: winnerPosition,
    walkover_reason: reason,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: enteredBy,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  // Rate BEFORE advancing. Advancing can cascade into another forfeit further
  // up the bracket, and a player's later matches must be rated against the
  // rating their earlier ones left them on, not the other way round.
  await applyTournamentMatchElo(matchId);

  if (winnerId) await advanceWinner(adminClient, match, doubles, winnerId, enteredBy);
}

/**
 * Move `winnerId` into the match this one feeds, then decide that match's
 * state. Callers used to inline this; the withdrawal cascade needs the exact
 * same rule, and a slot filled by a slightly different one is how a bracket
 * ends up disagreeing with itself.
 */
export async function advanceWinner(
  adminClient: ReturnType<typeof createAdminClient>,
  match: Record<string, unknown>,
  doubles: boolean,
  winnerId: string,
  enteredBy: string,
) {
  const nextMatchId = match.winner_to_match_id as string | null;
  if (!nextMatchId) return;

  const advanceField = doubles
    ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
    : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

  await adminClient.from('tournament_matches')
    .update({ [advanceField]: winnerId })
    .eq('id', nextMatchId);

  await settleAdvancedMatch(adminClient, nextMatchId, doubles, enteredBy);
}

/**
 * A match becomes READY once both slots are filled — but only if both
 * occupants are still in the event. Someone who withdrew after the draw was
 * published is still sitting in their slot, so without this check the arriving
 * winner is shown a live match against a player who is not coming. That is the
 * half of a late withdrawal the withdrawal itself cannot fix: at the time they
 * pulled out their next opponent was still TBD.
 */
async function settleAdvancedMatch(
  adminClient: ReturnType<typeof createAdminClient>,
  matchId: string,
  doubles: boolean,
  enteredBy: string,
) {
  const { data: next } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('id', matchId)
    .single();
  if (!next) return;

  const aId = (doubles ? next.pair_a_id : next.participant_a_id) as string | null;
  const bId = (doubles ? next.pair_b_id : next.participant_b_id) as string | null;
  if (!aId || !bId) return;

  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { data: entries } = await adminClient.from(table)
    .select('id, status')
    .in('id', [aId, bId]);

  const statusOf = (id: string) => entries?.find(e => e.id === id)?.status as string | undefined;
  const aOut = isOutOfEvent(statusOf(aId));
  const bOut = isOutOfEvent(statusOf(bId));

  // Exactly one side gone → the other walks over. Both gone is a draw an admin
  // has to unpick by hand, so it still surfaces as READY rather than silently
  // awarding a win to someone who is also not playing.
  if (aOut !== bOut) {
    const goneStatus = statusOf(aOut ? aId : bId) as DrawExitStatus;
    await recordWalkover(adminClient, next, doubles, aOut ? 'b' : 'a', FORFEIT_REASON[goneStatus], enteredBy);
    return;
  }

  await adminClient.from('tournament_matches')
    .update({ status: 'ready' })
    .eq('id', matchId);
}

/**
 * Forfeit every still-playable match belonging to `entryId` to its opponent.
 * Called when an entry is withdrawn or disqualified after the draw exists —
 * bracket generation only ever saw a point-in-time snapshot of who was in, so
 * without this the entry stays seeded and their matches stay READY.
 *
 * Finished matches are left exactly as they are: a walkover cannot rewrite a
 * result that was actually played, and a first-round bye is unrated, so it
 * carries no Elo to unwind.
 */
export async function forfeitOpenMatchesForEntry(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  entryId: string,
  doubles: boolean,
  reason: string,
  enteredBy: string,
): Promise<{ forfeited: number; unresolved: number }> {
  const { data: candidates } = await adminClient.from('tournament_matches')
    .select('id, round_number, participant_a_id, participant_b_id, pair_a_id, pair_b_id')
    .eq('event_id', eventId)
    .in('status', [...OPEN_MATCH_STATUSES])
    .order('round_number', { ascending: true });

  let forfeited = 0;
  let unresolved = 0;

  for (const candidate of candidates ?? []) {
    if (!forfeitOutcome(candidate, entryId, doubles)) continue;

    // Re-read before acting: an earlier forfeit in this loop advances an
    // opponent, which can settle a later match on this very list.
    const { data: match } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', candidate.id)
      .single();
    if (!match || !isOpenMatch(match.status as string) || match.is_bye) continue;

    const outcome = forfeitOutcome(match, entryId, doubles);
    if (!outcome) continue;

    // Opponent slot still TBD — there is nobody to award the walkover to.
    // settleAdvancedMatch forfeits it the moment the feeder match resolves.
    if (!outcome.winnerId) { unresolved++; continue; }

    await recordWalkover(adminClient, match, doubles, outcome.winnerSide, reason, enteredBy);
    forfeited++;
  }

  return { forfeited, unresolved };
}

/**
 * Forfeit the open matches of everyone who is no longer in the event.
 *
 * Run when an event goes live. Between the draw being published and the first
 * serve, a withdrawal deliberately does NOT touch the bracket — nothing has
 * been played, so the honest remedy is to regenerate the draw without them,
 * and a walkover recorded then would be unrated AND would block that
 * regeneration. Go-live is the moment that stops being true: the draw is now
 * the draw, and a forfeit finally carries the Elo it is supposed to.
 */
export async function forfeitOutOfEventEntries(
  adminClient: ReturnType<typeof createAdminClient>,
  eventId: string,
  doubles: boolean,
  enteredBy: string,
): Promise<{ forfeited: number; unresolved: number }> {
  const table = doubles ? 'tournament_pairs' : 'tournament_participants';
  const { data: entries } = await adminClient.from(table)
    .select('id, status')
    .eq('event_id', eventId)
    .in('status', ['withdrawn', 'disqualified']);

  let forfeited = 0;
  let unresolved = 0;

  for (const entry of entries ?? []) {
    const outcome = await forfeitOpenMatchesForEntry(
      adminClient,
      eventId,
      entry.id,
      doubles,
      FORFEIT_REASON[entry.status as DrawExitStatus],
      enteredBy,
    );
    forfeited += outcome.forfeited;
    unresolved += outcome.unresolved;
  }

  return { forfeited, unresolved };
}

// ============================================================
// Round Robin Standings (utility)
// ============================================================

export async function computeRoundRobinStandings(eventId: string) {
  const adminClient = createAdminClient();

  const { data: event } = await adminClient.from('tournament_events').select('*').eq('id', eventId).single();
  if (!event) return [];

  const doubles = isDoublesEvent(event.event_type);

  // Get all completed matches
  const { data: matches } = await adminClient.from('tournament_matches')
    .select('*')
    .eq('event_id', eventId)
    .in('status', ['completed', 'walkover']);

  // Get all entries
  let entries: Array<{ id: string; name: string }> = [];
  if (doubles) {
    const { data: pairs } = await adminClient.from('tournament_pairs')
      .select('id, pair_name')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    entries = (pairs ?? []).map(p => ({ id: p.id, name: p.pair_name ?? 'Unnamed' }));
  } else {
    const { data: participants } = await adminClient.from('tournament_participants')
      .select('id, player:players(full_name)')
      .eq('event_id', eventId)
      .not('status', 'in', '("withdrawn","disqualified")');
    entries = (participants ?? []).map(p => ({
      id: p.id,
      name: ((p.player as unknown as Record<string, unknown>)?.full_name as string) ?? 'Unknown',
    }));
  }

  // Build standings
  const stats: Record<string, {
    id: string;
    name: string;
    wins: number;
    losses: number;
    pointsFor: number;
    pointsAgainst: number;
    gamesFor: number;
    gamesAgainst: number;
    // Head-to-head wins against every other entry — used as a tiebreaker
    // before resorting to point differentials.
    h2h: Record<string, number>;
  }> = {};

  for (const e of entries) {
    stats[e.id] = { id: e.id, name: e.name, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, gamesFor: 0, gamesAgainst: 0, h2h: {} };
  }

  for (const m of matches ?? []) {
    const aId = doubles ? m.pair_a_id : m.participant_a_id;
    const bId = doubles ? m.pair_b_id : m.participant_b_id;
    if (!aId || !bId || !stats[aId] || !stats[bId]) continue;

    const winnerId = doubles ? m.winner_pair_id : m.winner_participant_id;
    if (winnerId === aId) {
      stats[aId].wins++;
      stats[bId].losses++;
      stats[aId].h2h[bId] = (stats[aId].h2h[bId] ?? 0) + 1;
    } else if (winnerId === bId) {
      stats[bId].wins++;
      stats[aId].losses++;
      stats[bId].h2h[aId] = (stats[bId].h2h[aId] ?? 0) + 1;
    }

    // Sum points from scores
    const scores = (m.scores as Array<{ a: number; b: number }>) ?? [];
    for (const g of scores) {
      stats[aId].pointsFor += g.a;
      stats[aId].pointsAgainst += g.b;
      stats[bId].pointsFor += g.b;
      stats[bId].pointsAgainst += g.a;

      if (g.a > g.b) {
        stats[aId].gamesFor++;
        stats[bId].gamesAgainst++;
      } else if (g.b > g.a) {
        stats[bId].gamesFor++;
        stats[aId].gamesAgainst++;
      }
    }
  }

  // Sort: wins desc, head-to-head wins desc (pairwise), games differential desc,
  // point differential desc, points for desc. Head-to-head only breaks ties
  // between the two entries being compared — it's not transitive, so multi-way
  // ties fall through to the differential tiebreakers.
  return Object.values(stats).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const h2h = (b.h2h[a.id] ?? 0) - (a.h2h[b.id] ?? 0);
    if (h2h !== 0) return h2h;
    const aGameDiff = a.gamesFor - a.gamesAgainst;
    const bGameDiff = b.gamesFor - b.gamesAgainst;
    if (bGameDiff !== aGameDiff) return bGameDiff - aGameDiff;
    const aDiff = a.pointsFor - a.pointsAgainst;
    const bDiff = b.pointsFor - b.pointsAgainst;
    if (bDiff !== aDiff) return bDiff - aDiff;
    return b.pointsFor - a.pointsFor;
  });
}
