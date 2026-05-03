'use server';

import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import { toClientError, logError } from '@badminton/shared';

export async function voidMatch(matchId: string, reason: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { error: reverseError } = await adminClient.rpc('reverse_match_result', { p_match_id: matchId });
  if (reverseError) {
    logError('elo_reverse_void', reverseError, { matchId, action: 'void_match' });
    throw new Error(reverseError.message);
  }

  const { error } = await adminClient
    .from('matches')
    .update({ result_status: 'voided', admin_note: reason })
    .eq('id', matchId);

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'match_voided',
    target_type: 'match',
    target_id: matchId,
    reason,
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'match_voided', matchId });
  }

  revalidatePath('/matches');
}

export async function convertMatchToCasual(matchId: string, reason: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { error: reverseError } = await adminClient.rpc('reverse_match_result', { p_match_id: matchId });
  if (reverseError) {
    logError('elo_reverse_convert_casual', reverseError, { matchId, action: 'convert_to_casual' });
    throw new Error(reverseError.message);
  }

  const { error } = await adminClient
    .from('matches')
    .update({ rated_flag: false, event_type: 'casual', admin_note: reason })
    .eq('id', matchId);

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'match_converted_casual',
    target_type: 'match',
    target_id: matchId,
    reason,
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'match_converted_casual', matchId });
  }

  revalidatePath('/matches');
}

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
  const admin = await getAuthenticatedAdmin();
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
    result_status: 'confirmed',
    season_id: activeSeason.data?.id || null,
    admin_note: data.admin_note || null,
  }).select().single();

  if (matchError) throw new Error(matchError.message);

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

  if (data.rated_flag) {
    const { error: eloError } = await adminClient.rpc('apply_match_result', {
      p_match_id: match.id,
      p_confirmed_by: admin.id,
    });
    if (eloError) {
      logError('elo_apply_admin_match', eloError, { matchId: match.id });
    }
  }

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'match_admin_created',
    target_type: 'match',
    target_id: match.id,
    new_value: { ...data, score_summary: scoreSummary },
  });
  if (auditError) {
    logError('audit_log_write', auditError, { action_type: 'match_admin_created', matchId: match.id });
  }

  revalidatePath('/matches');
  revalidatePath('/leaderboard');
  return match.id;
}
