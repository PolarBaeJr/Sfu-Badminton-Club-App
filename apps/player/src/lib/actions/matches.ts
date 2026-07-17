'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import {
  sendResultPendingEmail,
  sendDisputeOpenedEmail,
  sendWalkoverReportedEmail,
  getFormatWeight,
  getEventMultiplier,
  pickOne,
  matchResultSchema,
  disputeSchema,
  walkoverReportSchema,
  parseOrThrow,
  type MatchResultInput,
  type WalkoverReportInput,
} from '@badminton/shared';
import { requirePlayer, getPlayerProps, trackServerEvent, notifyPlayers } from './_shared';

export async function submitMatchResult(challengeId: string, input: MatchResultInput) {
  const parsed = matchResultSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid match result');

  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('*, challenge_participants(*, player:players(*, ratings(*)))')
    .eq('id', challengeId)
    .single();

  if (!challenge) throw new Error('Challenge not found');
  if (challenge.status !== 'accepted') throw new Error('Challenge not accepted');

  const isParticipant = (challenge.challenge_participants as { player_id: string }[] | null)?.some(
    (cp) => cp.player_id === player.id
  );
  if (!isParticipant) throw new Error('Not a participant');

  // Guard against double-submission. The matches_challenge_id_unique index
  // (migration 00002_indexes.sql) is the hard backstop; this pre-check gives a friendlier error.
  const { data: existingMatch } = await supabase
    .from('matches')
    .select('id')
    .eq('challenge_id', challengeId)
    .maybeSingle();
  if (existingMatch) throw new Error('A match has already been submitted for this challenge');

  if (challenge.session_id) {
    const { data: capOk } = await supabase.rpc('check_session_caps', {
      p_player_id: player.id,
      p_session_id: challenge.session_id,
      p_match_type: challenge.type,
    });
    if (capOk === false) throw new Error('Session match cap reached');
  }

  const { data: season } = await supabase.from('seasons').select('id').eq('active_flag', true).single();

  const formatWeight = getFormatWeight(challenge.format);
  const eventMult = getEventMultiplier(challenge.event_type);

  const { data: match, error: matchError } = await supabase
    .from('matches')
    .insert({
      challenge_id: challengeId,
      session_id: challenge.session_id,
      season_id: season?.id,
      match_type: challenge.type,
      event_type: challenge.event_type,
      rated_flag: challenge.rated_flag,
      format: challenge.format,
      format_weight: formatWeight,
      event_multiplier: eventMult,
      completed_flag: input.completed,
      winner_side: input.winner_side,
      score_summary: input.games.map((g) => `${g.side_a_score}-${g.side_b_score}`).join(', '),
      played_at: new Date().toISOString(),
      submitted_by: player.id,
      result_status: input.completed ? 'pending_confirmation' : 'incomplete',
    })
    .select()
    .single();

  if (matchError) throw new Error(matchError.message);

  const isDoubles = challenge.type === 'doubles';
  const matchParticipants = challenge.challenge_participants.map((cp: Record<string, unknown>) => {
    const playerData = cp.player as Record<string, unknown>;
    const ratingsData = pickOne(playerData?.ratings);
    const preRating = isDoubles
      ? ((ratingsData as Record<string, unknown>)?.doubles_elo as number) ?? 1200
      : ((ratingsData as Record<string, unknown>)?.singles_elo as number) ?? 1200;

    const side = cp.team_side as string;
    let pointsScored = 0;
    let pointsAllowed = 0;
    let gamesWon = 0;
    let gamesLost = 0;
    for (const g of input.games) {
      if (side === 'a') {
        pointsScored += g.side_a_score;
        pointsAllowed += g.side_b_score;
        if (g.side_a_score > g.side_b_score) gamesWon++;
        else gamesLost++;
      } else {
        pointsScored += g.side_b_score;
        pointsAllowed += g.side_a_score;
        if (g.side_b_score > g.side_a_score) gamesWon++;
        else gamesLost++;
      }
    }

    return {
      match_id: match.id,
      player_id: cp.player_id,
      team_side: cp.team_side,
      pre_rating: preRating,
      points_scored: pointsScored,
      points_allowed: pointsAllowed,
      games_won: gamesWon,
      games_lost: gamesLost,
    };
  });

  const { error: mpError } = await supabase.from('match_participants').insert(matchParticipants);
  if (mpError) throw new Error(mpError.message);

  const gameRows = input.games.map((g) => ({
    match_id: match.id,
    game_number: g.game_number,
    side_a_score: g.side_a_score,
    side_b_score: g.side_b_score,
  }));
  const { error: gamesError } = await supabase.from('match_games').insert(gameRows);
  if (gamesError) throw new Error(gamesError.message);

  // Notify other participants — batch insert + parallel email lookup.
  const otherPlayers = (challenge.challenge_participants as Record<string, unknown>[]).filter(
    (cp) => cp.player_id !== player.id
  );
  const otherPlayerIds = otherPlayers.map((cp) => cp.player_id as string);

  if (otherPlayerIds.length > 0) {
    await notifyPlayers(
      otherPlayerIds.map((pid) => ({
        player_id: pid,
        type: 'result_pending',
        title: 'Confirm Match Result',
        body: `${player.full_name} submitted a result. Please confirm.`,
        metadata: { match_id: match.id, challenge_id: challengeId },
      })),
      {
        title: 'Confirm Match Result',
        body: `${player.full_name} submitted a result. Please confirm.`,
        url: `/challenges/${challengeId}`,
      }
    );

    const { data: emails } = await supabase
      .from('players')
      .select('id, email')
      .in('id', otherPlayerIds);
    const score = input.games.map((g) => `${g.side_a_score}-${g.side_b_score}`).join(', ');
    for (const row of emails ?? []) {
      if (row.email) {
        sendResultPendingEmail(row.email, player.full_name, score, match.id).catch((err) => {
          Sentry.captureException(err, { extra: { email: 'result_pending', matchId: match.id } });
        });
      }
    }
  }

  trackServerEvent(player.id, 'match_result_submitted', {
    ...getPlayerProps(player),
    match_id: match.id,
    challenge_id: challengeId,
    format: challenge.format,
    winner_side: input.winner_side,
  });

  revalidatePath('/challenges');
  revalidatePath(`/challenges/${challengeId}`);
  return match.id;
}

export async function confirmMatchResult(matchId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: mp } = await supabase
    .from('match_participants')
    .select('player_id')
    .eq('match_id', matchId);
  if (!mp?.some((row) => row.player_id === player.id)) throw new Error('Not a participant');

  const { error } = await supabase.rpc('apply_match_result', {
    p_match_id: matchId,
    p_confirmed_by: player.id,
  });

  if (error) {
    Sentry.captureException(new Error(`Match confirmation failed: ${error.message}`), {
      extra: { matchId, playerId: player.id },
    });
    throw new Error(error.message);
  }

  trackServerEvent(player.id, 'match_result_confirmed', { ...getPlayerProps(player), match_id: matchId });
  revalidatePath('/challenges');
  revalidatePath('/leaderboard');
  revalidatePath('/my-stats');
}

export async function disputeMatchResult(matchId: string, reason: string, category: string) {
  parseOrThrow(disputeSchema, { match_id: matchId, reason_category: category, description: reason });
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: mp } = await supabase
    .from('match_participants')
    .select('player_id')
    .eq('match_id', matchId);
  if (!mp?.some((row) => row.player_id === player.id)) throw new Error('Not a participant');

  await supabase.from('matches').update({ result_status: 'disputed' }).eq('id', matchId);

  await supabase.from('disputes').insert({
    match_id: matchId,
    opened_by: player.id,
    reason_category: category,
    description: reason,
    status: 'open',
  });

  const [adminsRes, matchRes] = await Promise.all([
    supabase.from('players').select('email').eq('role', 'admin'),
    supabase.from('matches').select('score_summary').eq('id', matchId).single(),
  ]);
  const score = matchRes.data?.score_summary || 'N/A';
  for (const admin of adminsRes.data || []) {
    if (admin.email) {
      sendDisputeOpenedEmail(admin.email, score, reason, matchId).catch((err) => {
        Sentry.captureException(err, { extra: { email: 'dispute_opened', matchId } });
      });
    }
  }

  revalidatePath('/challenges');
}

export async function reportWalkover(input: WalkoverReportInput) {
  parseOrThrow(walkoverReportSchema, input);
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('status, challenge_participants(player_id, team_side)')
    .eq('id', input.challenge_id)
    .single();
  if (!challenge) throw new Error('Challenge not found');
  if (!['accepted', 'partially_confirmed'].includes(challenge.status)) {
    throw new Error('Challenge is not in a state that can be forfeited');
  }
  const cps = (challenge.challenge_participants as { player_id: string; team_side: string }[] | null) ?? [];
  const reporter = cps.find((cp) => cp.player_id === player.id);
  if (!reporter) throw new Error('Not a participant');
  const forfeit = cps.find((cp) => cp.player_id === input.forfeit_player_id);
  if (!forfeit) throw new Error('Forfeit player is not in this challenge');

  // For withdrawal the reporter forfeits (their team); for no_show the reporter
  // accuses the opposing team. Either way the forfeit player must be on the
  // opposite team from whomever is staying in the match.
  const reporterIsForfeiting = input.walkover_type === 'withdrawal';
  if (reporterIsForfeiting && forfeit.team_side !== reporter.team_side) {
    throw new Error('Withdrawal must name a teammate (or yourself)');
  }
  if (!reporterIsForfeiting && forfeit.team_side === reporter.team_side) {
    throw new Error('No-show must name a player on the opposing team');
  }

  const { error } = await supabase.from('walkovers').insert({
    challenge_id: input.challenge_id,
    reported_by: player.id,
    forfeit_player_id: input.forfeit_player_id,
    walkover_type: input.walkover_type,
    notice_hours: input.notice_hours,
  });
  if (error) throw new Error(error.message);

  // Service-role for the same RLS reason as acceptChallenge.
  const adminClient = createServiceRoleClient();
  await adminClient.from('challenges').update({ status: 'walkover_pending' }).eq('id', input.challenge_id);

  const otherParticipants = cps.filter((cp) => cp.player_id !== player.id);
  await notifyPlayers(
    otherParticipants.map((cp) => ({
      player_id: cp.player_id,
      type: 'walkover_reported',
      title: 'Walkover Reported',
      body: `${player.full_name} reported a ${input.walkover_type === 'withdrawal' ? 'withdrawal' : 'no-show'} for your challenge.`,
      metadata: { challenge_id: input.challenge_id },
    })),
    {
      title: 'Walkover Reported',
      body: `${player.full_name} reported a ${input.walkover_type === 'withdrawal' ? 'withdrawal' : 'no-show'} for your challenge.`,
      url: `/challenges/${input.challenge_id}`,
    }
  );

  const [adminsRes, forfeitRes] = await Promise.all([
    supabase.from('players').select('email').eq('role', 'admin'),
    supabase.from('players').select('full_name').eq('id', input.forfeit_player_id).single(),
  ]);
  const forfeitName = forfeitRes.data?.full_name || 'Unknown';
  for (const admin of adminsRes.data || []) {
    if (admin.email) {
      sendWalkoverReportedEmail(admin.email, forfeitName, input.walkover_type, input.challenge_id).catch((err) => {
        Sentry.captureException(err, { extra: { email: 'walkover_reported', challengeId: input.challenge_id } });
      });
    }
  }

  revalidatePath('/challenges');
}
