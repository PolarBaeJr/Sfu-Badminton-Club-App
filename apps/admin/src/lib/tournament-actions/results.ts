'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { isDoublesEvent, getMaxGamesForFormat } from '@badminton/shared';
import type { TournamentEventType, TournamentMatchFormat } from '@badminton/shared';
import {
  getAdminPlayer,
  revalidateEventPaths,
  notifyPlayers,
  applyTournamentMatchElo,
  reverseEloSnapshot,
} from './_internal';

// ============================================================
// Score Entry & Advancement
// ============================================================

export async function enterMatchResult(
  matchId: string,
  scores: Array<{ a: number; b: number }>,
  winnerSide: 'a' | 'b'
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'pending' && match.status !== 'ready' && match.status !== 'live') {
    throw new Error('Match is not in a playable state');
  }

  const event = match.event as Record<string, unknown>;
  const matchFormat = event.match_format as TournamentMatchFormat;
  const maxGames = getMaxGamesForFormat(matchFormat);
  if (scores.length > maxGames) {
    throw new Error(`Too many games for format ${matchFormat}. Max: ${maxGames}`);
  }

  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Determine winner and loser IDs
  let winnerIdField: string;
  let loserIdField: string;
  let winnerId: string;
  let loserId: string;

  if (doubles) {
    winnerId = winnerSide === 'a' ? match.pair_a_id : match.pair_b_id;
    loserId = winnerSide === 'a' ? match.pair_b_id : match.pair_a_id;
    winnerIdField = 'winner_pair_id';
    loserIdField = 'loser_pair_id';
  } else {
    winnerId = winnerSide === 'a' ? match.participant_a_id : match.participant_b_id;
    loserId = winnerSide === 'a' ? match.participant_b_id : match.participant_a_id;
    winnerIdField = 'winner_participant_id';
    loserIdField = 'loser_participant_id';
  }

  // Update match
  const { error } = await adminClient.from('tournament_matches').update({
    scores,
    [winnerIdField]: winnerId,
    [loserIdField]: loserId,
    status: 'completed',
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  // Advance winner to next match (single elimination only)
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);

    // Check if next match now has both sides → set to ready
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch) {
      const hasBoth = doubles
        ? (nextMatch.pair_a_id && nextMatch.pair_b_id)
        : (nextMatch.participant_a_id && nextMatch.participant_b_id);
      if (hasBoth) {
        await adminClient.from('tournament_matches')
          .update({ status: 'ready' })
          .eq('id', match.winner_to_match_id);
      }
    }
  }

  // Apply Elo
  await applyTournamentMatchElo(matchId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_entered',
    performed_by: admin.id,
    details: { scores, winner_side: winnerSide },
  });

  // Notify both players of match result
  const matchPlayerIds: string[] = [];
  if (doubles) {
    for (const pairId of [match.pair_a_id, match.pair_b_id].filter(Boolean)) {
      const { data: pair } = await adminClient.from('tournament_pairs').select('player1_id, player2_id').eq('id', pairId).single();
      if (pair) { matchPlayerIds.push(pair.player1_id, pair.player2_id); }
    }
  } else {
    for (const pid of [match.participant_a_id, match.participant_b_id].filter(Boolean)) {
      const { data: p } = await adminClient.from('tournament_participants').select('player_id').eq('id', pid).single();
      if (p) matchPlayerIds.push(p.player_id);
    }
  }
  await notifyPlayers(adminClient, matchPlayerIds,
    'Match Result Confirmed',
    `Your match result has been recorded. Score: ${scores.map((s: { a: number; b: number }) => `${s.a}-${s.b}`).join(', ')}`,
    { match_id: matchId, event_id: match.event_id },
    'tournament_match_result'
  );

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

export async function enterWalkover(
  matchId: string,
  winnerPosition: 'a' | 'b',
  reason: string
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  let winnerId: string;
  let loserId: string;

  if (doubles) {
    winnerId = winnerPosition === 'a' ? match.pair_a_id : match.pair_b_id;
    loserId = winnerPosition === 'a' ? match.pair_b_id : match.pair_a_id;
  } else {
    winnerId = winnerPosition === 'a' ? match.participant_a_id : match.participant_b_id;
    loserId = winnerPosition === 'a' ? match.participant_b_id : match.participant_a_id;
  }

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  await adminClient.from('tournament_matches').update({
    status: 'walkover',
    walkover_winner: winnerPosition,
    walkover_reason: reason,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  // Advance winner
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);

    // Check if next match is now ready
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('*')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch) {
      const hasBoth = doubles
        ? (nextMatch.pair_a_id && nextMatch.pair_b_id)
        : (nextMatch.participant_a_id && nextMatch.participant_b_id);
      if (hasBoth) {
        await adminClient.from('tournament_matches')
          .update({ status: 'ready' })
          .eq('id', match.winner_to_match_id);
      }
    }
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'walkover_entered',
    performed_by: admin.id,
    details: { winner_position: winnerPosition, reason },
  });

  // Apply Elo for walkovers too — losing party still gets penalised, winner still gains.
  await applyTournamentMatchElo(matchId);

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

export async function voidMatch(matchId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  const event = match.event as Record<string, unknown>;

  await adminClient.from('tournament_matches').update({
    status: 'voided',
    notes: reason,
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'match_voided',
    performed_by: admin.id,
    details: { reason },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

export async function editMatchResult(
  matchId: string,
  newScores: Array<{ a: number; b: number }>,
  newWinnerSide: 'a' | 'b'
) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');

  // Check no downstream matches have been completed
  if (match.winner_to_match_id) {
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('status')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch && nextMatch.status === 'completed') {
      throw new Error('Cannot edit result — downstream match already completed');
    }
  }

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  const winnerId = doubles
    ? (newWinnerSide === 'a' ? match.pair_a_id : match.pair_b_id)
    : (newWinnerSide === 'a' ? match.participant_a_id : match.participant_b_id);
  const loserId = doubles
    ? (newWinnerSide === 'a' ? match.pair_b_id : match.pair_a_id)
    : (newWinnerSide === 'a' ? match.participant_b_id : match.participant_a_id);

  const winnerField = doubles ? 'winner_pair_id' : 'winner_participant_id';
  const loserField = doubles ? 'loser_pair_id' : 'loser_participant_id';

  // Reverse any prior Elo changes so we can recompute with the corrected winner.
  if (match.elo_snapshot) {
    await reverseEloSnapshot(adminClient, match);
  }

  await adminClient.from('tournament_matches').update({
    scores: newScores,
    [winnerField]: winnerId,
    [loserField]: loserId,
    result_entered_by: admin.id,
    result_entered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', matchId);

  // Re-advance winner if changed
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: winnerId })
      .eq('id', match.winner_to_match_id);
  }

  // Reapply Elo with corrected winner. Skipped for walkovers (no Elo impact)
  // and voided matches.
  if (match.status === 'completed') {
    await applyTournamentMatchElo(matchId);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_edited',
    performed_by: admin.id,
    details: { old_scores: match.scores, new_scores: newScores, new_winner_side: newWinnerSide },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}

// ============================================================
// Undo Match Result
// ============================================================

export async function undoMatchResult(matchId: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { data: match } = await adminClient.from('tournament_matches')
    .select('*, event:tournament_events(*)')
    .eq('id', matchId)
    .single();

  if (!match) throw new Error('Match not found');
  if (match.status !== 'completed' && match.status !== 'walkover') {
    throw new Error('Match has no result to undo');
  }

  const event = match.event as Record<string, unknown>;
  const doubles = isDoublesEvent(event.event_type as TournamentEventType);

  // Check no downstream matches have results
  if (match.winner_to_match_id) {
    const { data: nextMatch } = await adminClient.from('tournament_matches')
      .select('status')
      .eq('id', match.winner_to_match_id)
      .single();

    if (nextMatch && (nextMatch.status === 'completed' || nextMatch.status === 'walkover')) {
      throw new Error('Cannot undo — downstream match already has a result. Undo that match first.');
    }
  }

  // Reverse Elo changes (both singles and doubles) using snapshot persisted at apply time.
  // Falls back to legacy elo_before behaviour for singles matches that pre-date the snapshot column.
  if (match.elo_snapshot) {
    await reverseEloSnapshot(adminClient, match);
  } else if (!doubles) {
    const winnerId = match.winner_participant_id;
    const loserId = match.loser_participant_id;

    if (winnerId) {
      const { data: winnerP } = await adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', winnerId).single();
      if (winnerP?.elo_before != null) {
        await adminClient.from('ratings')
          .update({ singles_elo: winnerP.elo_before, updated_at: new Date().toISOString() })
          .eq('player_id', winnerP.player_id);
        await adminClient.from('tournament_participants')
          .update({ elo_after: null, elo_change: null })
          .eq('id', winnerId);
      }
    }

    if (loserId) {
      const { data: loserP } = await adminClient.from('tournament_participants')
        .select('player_id, elo_before')
        .eq('id', loserId).single();
      if (loserP?.elo_before != null) {
        await adminClient.from('ratings')
          .update({ singles_elo: loserP.elo_before, updated_at: new Date().toISOString() })
          .eq('player_id', loserP.player_id);
        await adminClient.from('tournament_participants')
          .update({ elo_after: null, elo_change: null })
          .eq('id', loserId);
      }
    }
  }

  // Remove winner from next match if single elimination
  if (match.winner_to_match_id) {
    const advanceField = doubles
      ? (match.winner_to_position === 'a' ? 'pair_a_id' : 'pair_b_id')
      : (match.winner_to_position === 'a' ? 'participant_a_id' : 'participant_b_id');

    await adminClient.from('tournament_matches')
      .update({ [advanceField]: null, status: 'pending' })
      .eq('id', match.winner_to_match_id);
  }

  // Reset match itself
  const resetData: Record<string, unknown> = {
    scores: null,
    status: 'ready',
    walkover_winner: null,
    walkover_reason: null,
    result_entered_by: null,
    result_entered_at: null,
    updated_at: new Date().toISOString(),
  };

  if (doubles) {
    resetData.winner_pair_id = null;
    resetData.loser_pair_id = null;
  } else {
    resetData.winner_participant_id = null;
    resetData.loser_participant_id = null;
  }

  const { error } = await adminClient.from('tournament_matches')
    .update(resetData)
    .eq('id', matchId);

  if (error) {
    Sentry.captureException(error);
    throw new Error(error.message);
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id as string,
    event_id: match.event_id,
    match_id: matchId,
    action: 'result_undone',
    performed_by: admin.id,
    details: { previous_scores: match.scores },
  });

  revalidateEventPaths(event.tournament_id as string, match.event_id as string);
}
