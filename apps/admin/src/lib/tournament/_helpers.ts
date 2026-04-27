// Internal helpers shared across the tournament action files. Not marked
// 'use server' because Next.js Server Actions modules require every export
// to be an async function — these helpers include constants, sync utilities,
// and internal-only async functions.

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '../supabase-server';
import {
  calculateEloUpdate,
  getKFactor,
  getFormatWeight,
  isDoublesEvent,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentMatchFormat,
  MatchFormat,
} from '@badminton/shared';

// Revalidate both the tournament page and the event detail page so admin UIs
// reflect mutations immediately. Pass eventId whenever it is in scope.
export function revalidateEventPaths(tournamentId: string, eventId?: string) {
  revalidatePath(`/tournaments/${tournamentId}`);
  if (eventId) revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}

// Map tournament match format to the shared elo engine's MatchFormat
export function toEloFormat(mf: TournamentMatchFormat): MatchFormat {
  switch (mf) {
    case 'best_of_3_to_21': return 'bo3_21';
    case 'one_game_21': return 'single_21';
    case 'one_game_15': return 'single_15';
    case 'one_game_11': return 'single_11';
  }
}

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

export async function logAudit(
  adminClient: ReturnType<typeof createAdminClient>,
  params: {
    tournament_id?: string;
    event_id?: string;
    match_id?: string;
    action: string;
    performed_by: string;
    details?: Record<string, unknown>;
  }
) {
  await adminClient.from('tournament_audit_log').insert({
    tournament_id: params.tournament_id ?? null,
    event_id: params.event_id ?? null,
    match_id: params.match_id ?? null,
    action: params.action,
    performed_by: params.performed_by,
    details: params.details ?? null,
  });
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

// Apply Elo for a completed/walkover match. Snapshots the per-player change
// onto the match row so undo/edit can perfectly reverse it later.
export async function applyTournamentMatchElo(matchId: string) {
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match || match.status === 'voided' || match.is_bye) return;

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);
  const matchFormat = event.match_format as TournamentMatchFormat;
  const eloMultiplier = Number(event.elo_multiplier) || 1.25;
  const eloFormat = toEloFormat(matchFormat);
  const formatWeight = getFormatWeight(eloFormat);

  const snapshotEntries: Array<{
    player_id: string;
    before: number;
    after: number;
    delta: number;
  }> = [];
  const snapshotDiscipline: 'singles' | 'doubles' = doubles ? 'doubles' : 'singles';

  const nowIso = new Date().toISOString();

  if (doubles) {
    const winnerId = match.winner_pair_id;
    const loserId = match.loser_pair_id;
    if (!winnerId || !loserId) return;

    const [{ data: winnerPair }, { data: loserPair }] = await Promise.all([
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_pairs')
        .select('player1_id, player2_id, combined_elo')
        .eq('id', loserId).single(),
    ]);

    if (!winnerPair || !loserPair) return;

    const winnerElo = winnerPair.combined_elo ?? 1200;
    const loserElo = loserPair.combined_elo ?? 1200;

    const allPlayerIds = [winnerPair.player1_id, winnerPair.player2_id, loserPair.player1_id, loserPair.player2_id];
    const { data: ratings } = await adminClient.from('ratings')
      .select('player_id, doubles_elo, doubles_provisional, doubles_matches_played')
      .in('player_id', allPlayerIds);

    const computeFor = (playerId: string, opponentElo: number, won: boolean) => {
      const rating = ratings?.find(r => r.player_id === playerId);
      const before = rating?.doubles_elo ?? 1200;
      const k = getKFactor('doubles', rating?.doubles_provisional ?? true, rating?.doubles_matches_played);
      const result = calculateEloUpdate({
        playerRating: before,
        opponentRating: opponentElo,
        kFactor: k,
        formatWeight,
        eventMultiplier: eloMultiplier,
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

    const updateResults = await Promise.allSettled(
      computed.map(c => adminClient.from('ratings')
        .update({ doubles_elo: c.newRating, updated_at: nowIso })
        .eq('player_id', c.playerId))
    );
    for (const r of updateResults) {
      if (r.status === 'rejected') Sentry.captureException(r.reason);
    }
  } else {
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;
    if (!winnerId || !loserId) return;

    const [{ data: winnerP }, { data: loserP }] = await Promise.all([
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', winnerId).single(),
      adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', loserId).single(),
    ]);

    if (!winnerP || !loserP) return;

    const { data: ratings } = await adminClient.from('ratings')
      .select('player_id, singles_elo, singles_provisional, singles_matches_played')
      .in('player_id', [winnerP.player_id, loserP.player_id]);

    const winnerRating = ratings?.find(r => r.player_id === winnerP.player_id);
    const loserRating = ratings?.find(r => r.player_id === loserP.player_id);

    const winnerElo = winnerRating?.singles_elo ?? winnerP.elo_before ?? 1200;
    const loserElo = loserRating?.singles_elo ?? loserP.elo_before ?? 1200;

    const winK = getKFactor('singles', winnerRating?.singles_provisional ?? true, winnerRating?.singles_matches_played);
    const loseK = getKFactor('singles', loserRating?.singles_provisional ?? true, loserRating?.singles_matches_played);

    const winResult = calculateEloUpdate({
      playerRating: winnerElo,
      opponentRating: loserElo,
      kFactor: winK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      won: true,
    });

    const loseResult = calculateEloUpdate({
      playerRating: loserElo,
      opponentRating: winnerElo,
      kFactor: loseK,
      formatWeight,
      eventMultiplier: eloMultiplier,
      won: false,
    });

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

  // Apply inverse delta regardless of drift so net effect is zero even if
  // intermediate matches moved the rating.
  const updatePromises = snapshot.entries
    .filter(e => currentMap.has(e.player_id))
    .map(e => adminClient.from('ratings')
      .update({ [ratingColumn]: (currentMap.get(e.player_id) as number) - e.delta, updated_at: nowIso })
      .eq('player_id', e.player_id));

  if (snapshot.discipline === 'singles') {
    const participantIds = [match.winner_participant_id, match.loser_participant_id]
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (participantIds.length > 0) {
      updatePromises.push(adminClient.from('tournament_participants')
        .update({ elo_after: null, elo_change: null })
        .in('id', participantIds));
    }
  }

  updatePromises.push(adminClient.from('tournament_matches')
    .update({ elo_snapshot: null })
    .eq('id', match.id as string));

  const results = await Promise.allSettled(updatePromises);
  for (const r of results) {
    if (r.status === 'rejected') Sentry.captureException(r.reason);
  }
}
