'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, adminMatchCreateSchema } from '@badminton/shared';
import { getAdminPlayer } from './_shared';

// ============================================================
// Match Management
// ============================================================

export async function voidMatch(matchId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  // Reverse Elo
  const { error: reverseError } = await adminClient.rpc('reverse_match_result', { p_match_id: matchId });
  if (reverseError) {
    Sentry.captureException(new Error(`Elo reversal failed: ${reverseError.message}`), {
      extra: { matchId, action: 'void_match' },
    });
    throw new Error(reverseError.message);
  }

  const { error } = await adminClient
    .from('matches')
    .update({ result_status: 'voided', admin_note: reason })
    .eq('id', matchId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'match_voided',
    target_type: 'match',
    target_id: matchId,
    reason,
  }, { matchId });

  revalidatePath('/matches');
}

export async function convertMatchToCasual(matchId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error: reverseError } = await adminClient.rpc('reverse_match_result', { p_match_id: matchId });
  if (reverseError) {
    Sentry.captureException(new Error(`Elo reversal failed: ${reverseError.message}`), {
      extra: { matchId, action: 'convert_to_casual' },
    });
    throw new Error(reverseError.message);
  }

  const { error } = await adminClient
    .from('matches')
    .update({ rated_flag: false, event_type: 'casual', admin_note: reason })
    .eq('id', matchId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'match_converted_casual',
    target_type: 'match',
    target_id: matchId,
    reason,
  }, { matchId });

  revalidatePath('/matches');
}

// ============================================================
// Admin Match Entry
// ============================================================

export async function adminCreateMatch(data: {
  match_type: string;
  format: string;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  winner_side: string;
  games: { game_number: number; side_a_score: number; side_b_score: number }[];
  admin_note?: string;
}) {
  parseOrThrow(adminMatchCreateSchema, data);
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();
  const { getFormatWeight } = await import('@badminton/shared');

  const activeSeason = await adminClient.from('seasons').select('id').eq('active_flag', true).single();
  const formatWeight = getFormatWeight(data.format as import('@badminton/shared').MatchFormat);

  const scoreSummary = data.games.map(g => `${g.side_a_score}-${g.side_b_score}`).join(', ');

  const { data: match, error: matchError } = await adminClient.from('matches').insert({
    match_type: data.match_type,
    event_type: 'admin_entered',
    rated_flag: data.rated_flag,
    format: data.format,
    format_weight: formatWeight,
    event_multiplier: 1.0,
    completed_flag: true,
    winner_side: data.winner_side,
    score_summary: scoreSummary,
    played_at: new Date().toISOString(),
    submitted_by: admin.id,
    confirmed_by: admin.id,
    // Rated matches must start as pending_confirmation: apply_match_result
    // rejects anything else, then flips the status to confirmed itself.
    result_status: data.rated_flag ? 'pending_confirmation' : 'confirmed',
    season_id: activeSeason.data?.id || null,
    admin_note: data.admin_note || null,
  }).select().single();

  if (matchError) throw new Error(matchError.message);

  // Get player ratings and build participants
  const allPlayerIds = [...data.side_a_players, ...data.side_b_players];
  const { data: ratings } = await adminClient.from('ratings').select('*').in('player_id', allPlayerIds);
  const ratingsMap = new Map(ratings?.map(r => [r.player_id, r]) || []);

  const isDoubles = data.match_type === 'doubles';
  const participants = allPlayerIds.map(pid => {
    const side = data.side_a_players.includes(pid) ? 'a' : 'b';
    const r = ratingsMap.get(pid);
    const preRating = isDoubles ? (r?.doubles_elo ?? 1200) : (r?.singles_elo ?? 1200);

    let pointsScored = 0, pointsAllowed = 0, gamesWon = 0, gamesLost = 0;
    for (const g of data.games) {
      if (side === 'a') {
        pointsScored += g.side_a_score;
        pointsAllowed += g.side_b_score;
        if (g.side_a_score > g.side_b_score) gamesWon++; else gamesLost++;
      } else {
        pointsScored += g.side_b_score;
        pointsAllowed += g.side_a_score;
        if (g.side_b_score > g.side_a_score) gamesWon++; else gamesLost++;
      }
    }

    return {
      match_id: match.id,
      player_id: pid,
      team_side: side,
      pre_rating: preRating,
      points_scored: pointsScored,
      points_allowed: pointsAllowed,
      games_won: gamesWon,
      games_lost: gamesLost,
    };
  });

  await adminClient.from('match_participants').insert(participants);

  const gameRows = data.games.map(g => ({
    match_id: match.id,
    game_number: g.game_number,
    side_a_score: g.side_a_score,
    side_b_score: g.side_b_score,
  }));
  await adminClient.from('match_games').insert(gameRows);

  // Apply Elo if rated
  if (data.rated_flag) {
    const { error: eloError } = await adminClient.rpc('apply_match_result', {
      p_match_id: match.id,
      p_confirmed_by: admin.id,
    });
    if (eloError) {
      Sentry.captureException(new Error(`Elo application failed for admin match: ${eloError.message}`), {
        extra: { matchId: match.id },
      });
      throw new Error(eloError.message);
    }
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'match_admin_created',
    target_type: 'match',
    target_id: match.id,
    new_value: { ...data, score_summary: scoreSummary },
  }, { matchId: match.id });

  revalidatePath('/matches');
  revalidatePath('/leaderboard');
  return match.id;
}

// ============================================================
// Admin Challenge Creation
// ============================================================

export async function adminCreateChallenge(data: {
  type: string;
  format: string;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  scheduled_date?: string;
  scheduled_time?: string;
  note?: string;
}) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const eventType = data.rated_flag ? 'rated_challenge' : 'casual';

  const { data: challenge, error } = await adminClient.from('challenges').insert({
    type: data.type,
    rated_flag: data.rated_flag,
    format: data.format,
    event_type: eventType,
    scheduled_date: data.scheduled_date || null,
    scheduled_time: data.scheduled_time || null,
    created_by: admin.id,
    status: 'accepted',
    note: data.note || `Created by admin`,
  }).select().single();

  if (error) throw new Error(error.message);

  // All participants auto-accepted since admin created
  const participants: { challenge_id: string; player_id: string; role: string; team_side: string; confirmation_status: string }[] = [];

  data.side_a_players.forEach((pid, i) => {
    participants.push({
      challenge_id: challenge.id,
      player_id: pid,
      role: i === 0 ? 'challenger' : 'partner',
      team_side: 'a',
      confirmation_status: 'accepted',
    });
  });

  data.side_b_players.forEach((pid, i) => {
    participants.push({
      challenge_id: challenge.id,
      player_id: pid,
      role: i === 0 ? 'opponent' : 'opponent_partner',
      team_side: 'b',
      confirmation_status: 'accepted',
    });
  });

  const { error: partError } = await adminClient.from('challenge_participants').insert(participants);
  if (partError) throw new Error(partError.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'challenge_admin_created',
    target_type: 'challenge',
    target_id: challenge.id,
    new_value: data,
  }, { challengeId: challenge.id });

  revalidatePath('/challenges');
  return challenge.id;
}

export async function forceExpireChallenge(challengeId: string, reason: string) {
  const admin = await getAdminPlayer();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('challenges')
    .update({ status: 'expired' })
    .eq('id', challengeId);

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'challenge_force_expired',
    target_type: 'challenge',
    target_id: challengeId,
    reason,
  }, { challengeId });

  revalidatePath('/challenges');
}
