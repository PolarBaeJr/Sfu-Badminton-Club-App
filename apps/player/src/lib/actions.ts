'use server';

import * as Sentry from '@sentry/nextjs';
import { createServerSupabaseClient, createServiceRoleClient, getCurrentPlayer } from './supabase-server';
import { revalidatePath } from 'next/cache';
import type { ChallengeCreateInput, MatchResultInput, WalkoverReportInput } from '@badminton/shared';
import { getFormatWeight, getEventMultiplier, MATCH_FORMAT_LABELS } from '@badminton/shared';
import {
  sendChallengeReceivedEmail,
  sendChallengeAcceptedEmail,
  sendChallengeRejectedEmail,
  sendResultPendingEmail,
  sendDisputeOpenedEmail,
  sendWalkoverReportedEmail,
} from '@badminton/shared';
import { PostHog } from 'posthog-node';

let posthogServer: PostHog | null = null;
function getPostHog(): PostHog | null {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;
  if (!posthogServer) {
    posthogServer = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogServer;
}

function trackServerEvent(
  playerId: string,
  event: string,
  properties: Record<string, unknown>
) {
  const ph = getPostHog();
  if (!ph) return;
  ph.capture({ distinctId: playerId, event, properties });
}

async function requirePlayer() {
  const player = await getCurrentPlayer();
  if (!player) {
    // Clear any Sentry user context left over from a previous request handler
    // sharing this Node process — avoids misattributing the next error.
    Sentry.setUser(null);
    throw new Error('Not authenticated');
  }
  if (player.status === 'pending_approval') {
    Sentry.setUser(null);
    throw new Error('Account pending approval');
  }
  if (player.status === 'suspended') {
    Sentry.setUser(null);
    throw new Error('Account suspended');
  }
  Sentry.setUser({ id: player.id });
  return player;
}

function getPlayerProps(player: Record<string, unknown>) {
  const ratings = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;
  return {
    player_id: player.id as string,
    player_status: player.status as string,
    singles_elo: (ratings as Record<string, unknown>)?.singles_elo as number ?? 1200,
    doubles_elo: (ratings as Record<string, unknown>)?.doubles_elo as number ?? 1200,
  };
}

// ============================================================
// Challenges
// ============================================================

export async function createChallenge(input: ChallengeCreateInput) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  // Validate via DB function
  const { data: validation } = await supabase.rpc('validate_challenge_creation', {
    p_creator_id: player.id,
    p_opponent_id: input.opponent_id,
    p_type: input.type,
    p_partner_id: input.partner_id || null,
    p_opponent_partner_id: input.opponent_partner_id || null,
  });

  if (validation && !validation.valid) {
    const errors = validation.errors as string[];
    throw new Error(errors.join(', '));
  }

  const eventType = input.rated_flag ? 'rated_challenge' : 'casual';

  // Create challenge
  const { data: challenge, error } = await supabase
    .from('challenges')
    .insert({
      type: input.type,
      rated_flag: input.rated_flag,
      format: input.format,
      event_type: eventType,
      session_id: input.session_id || null,
      scheduled_date: input.scheduled_date || null,
      scheduled_time: input.scheduled_time || null,
      created_by: player.id,
      status: 'proposed',
      note: input.note || null,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  // Add participants
  const participants: { challenge_id: string; player_id: string; role: string; team_side: string; confirmation_status: string }[] = [
    { challenge_id: challenge.id, player_id: player.id, role: 'challenger', team_side: 'a', confirmation_status: 'accepted' },
    { challenge_id: challenge.id, player_id: input.opponent_id, role: 'opponent', team_side: 'b', confirmation_status: 'pending' },
  ];

  if (input.type === 'doubles') {
    if (input.partner_id) {
      participants.push({
        challenge_id: challenge.id, player_id: input.partner_id, role: 'partner', team_side: 'a', confirmation_status: 'pending',
      });
    }
    if (input.opponent_partner_id) {
      participants.push({
        challenge_id: challenge.id, player_id: input.opponent_partner_id, role: 'opponent_partner', team_side: 'b', confirmation_status: 'pending',
      });
    }
  }

  const { error: partError } = await supabase.from('challenge_participants').insert(participants);
  if (partError) throw new Error(partError.message);

  // Create notification for opponent
  await supabase.from('notifications').insert({
    player_id: input.opponent_id,
    type: 'challenge_received',
    title: 'New Challenge',
    body: `${player.full_name} has challenged you!`,
    metadata: { challenge_id: challenge.id },
  });

  // Send email
  const { data: opponent } = await supabase.from('players').select('email').eq('id', input.opponent_id).single();
  if (opponent?.email) {
    const formatLabel = MATCH_FORMAT_LABELS[input.format as keyof typeof MATCH_FORMAT_LABELS] || input.format;
    sendChallengeReceivedEmail(opponent.email, player.full_name, formatLabel, input.type, challenge.id).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_received', challengeId: challenge.id } });
    });
  }

  // Update reliability (atomic via RPC)
  await supabase.rpc('increment_challenges_issued', { p_player_id: player.id });

  const props = getPlayerProps(player);
  trackServerEvent(player.id, 'challenge_created', {
    ...props,
    challenge_id: challenge.id,
    challenge_type: input.type,
    format: input.format,
    rated: input.rated_flag,
  });

  revalidatePath('/challenges');
  revalidatePath('/feed');
  return challenge.id;
}

export async function acceptChallenge(challengeId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('created_by, challenge_participants(player_id, confirmation_status)')
    .eq('id', challengeId)
    .single();
  if (!challenge) throw new Error('Challenge not found');
  if (challenge.created_by === player.id) throw new Error('Cannot accept your own challenge');

  const cps = (challenge.challenge_participants as { player_id: string; confirmation_status: string }[] | null) ?? [];
  const myParticipant = cps.find((cp) => cp.player_id === player.id);
  if (!myParticipant) throw new Error('Not a participant');
  if (myParticipant.confirmation_status !== 'pending') throw new Error('Already responded to this challenge');

  const { error } = await supabase
    .from('challenge_participants')
    .update({ confirmation_status: 'accepted', responded_at: new Date().toISOString() })
    .eq('challenge_id', challengeId)
    .eq('player_id', player.id);
  if (error) throw new Error(error.message);

  // Recompute aggregate status from latest snapshot (still racy across concurrent accepts;
  // the canonical fix is a DB function — see TODO). Use service role for the
  // challenges.status update — challenges_update_own RLS only allows the creator
  // to write, so a non-creator participant's accept silently no-ops without it.
  const allAccepted = cps.every((cp) =>
    cp.player_id === player.id ? true : cp.confirmation_status === 'accepted'
  );
  const adminClient = createServiceRoleClient();
  await adminClient
    .from('challenges')
    .update({ status: allAccepted ? 'accepted' : 'partially_confirmed' })
    .eq('id', challengeId);

  // Notify challenger
  await supabase.from('notifications').insert({
    player_id: challenge.created_by,
    type: 'challenge_accepted',
    title: 'Challenge Accepted',
    body: `${player.full_name} accepted your challenge!`,
    metadata: { challenge_id: challengeId },
  });

  const { data: creator } = await supabase.from('players').select('email').eq('id', challenge.created_by).single();
  if (creator?.email) {
    sendChallengeAcceptedEmail(creator.email, player.full_name, challengeId).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_accepted', challengeId } });
    });
  }

  const props = getPlayerProps(player);
  trackServerEvent(player.id, 'challenge_accepted', { ...props, challenge_id: challengeId });

  revalidatePath('/challenges');
}

export async function rejectChallenge(challengeId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('created_by, challenge_participants(player_id, confirmation_status)')
    .eq('id', challengeId)
    .single();
  if (!challenge) throw new Error('Challenge not found');
  if (challenge.created_by === player.id) throw new Error('Cannot reject your own challenge');

  const cps = (challenge.challenge_participants as { player_id: string; confirmation_status: string }[] | null) ?? [];
  const myParticipant = cps.find((cp) => cp.player_id === player.id);
  if (!myParticipant) throw new Error('Not a participant');
  if (myParticipant.confirmation_status !== 'pending') throw new Error('Already responded to this challenge');

  await supabase
    .from('challenge_participants')
    .update({ confirmation_status: 'rejected', responded_at: new Date().toISOString() })
    .eq('challenge_id', challengeId)
    .eq('player_id', player.id);

  // Any single rejection terminates the challenge for everyone — intentional in doubles too,
  // since a partner declining means the matchup can't go ahead as proposed.
  // Service-role client: challenges_update_own RLS only lets the creator update;
  // a rejecting participant otherwise can't flip the aggregate status.
  const adminClient = createServiceRoleClient();
  await adminClient.from('challenges').update({ status: 'rejected' }).eq('id', challengeId);

  await supabase.from('notifications').insert({
    player_id: challenge.created_by,
    type: 'challenge_rejected',
    title: 'Challenge Rejected',
    body: `${player.full_name} rejected your challenge.`,
    metadata: { challenge_id: challengeId },
  });

  const { data: creator } = await supabase.from('players').select('email').eq('id', challenge.created_by).single();
  if (creator?.email) {
    sendChallengeRejectedEmail(creator.email, player.full_name, challengeId).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_rejected', challengeId } });
    });
  }

  const props = getPlayerProps(player);
  trackServerEvent(player.id, 'challenge_rejected', { ...props, challenge_id: challengeId });

  revalidatePath('/challenges');
}

export async function cancelChallenge(challengeId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('*, challenge_participants(player_id)')
    .eq('id', challengeId)
    .single();

  if (!challenge) throw new Error('Challenge not found');
  if (challenge.created_by !== player.id) throw new Error('Only the creator can cancel');
  if (!['proposed', 'partially_confirmed'].includes(challenge.status)) {
    throw new Error('Challenge cannot be cancelled in its current state');
  }

  await supabase.from('challenges').update({ status: 'cancelled' }).eq('id', challengeId);

  const otherParticipants = (challenge.challenge_participants as { player_id: string }[] | null)?.filter(
    (cp) => cp.player_id !== player.id
  ) || [];

  if (otherParticipants.length > 0) {
    await supabase.from('notifications').insert(
      otherParticipants.map((cp) => ({
        player_id: cp.player_id,
        type: 'challenge_cancelled',
        title: 'Challenge Cancelled',
        body: `${player.full_name} cancelled the challenge.`,
        metadata: { challenge_id: challengeId },
      }))
    );
  }

  trackServerEvent(player.id, 'challenge_cancelled', {
    ...getPlayerProps(player),
    challenge_id: challengeId,
  });

  revalidatePath('/challenges');
  revalidatePath(`/challenges/${challengeId}`);
}

// ============================================================
// Match Results
// ============================================================

export async function submitMatchResult(challengeId: string, input: MatchResultInput) {
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

  // Guard against double-submission. matches.challenge_id has no unique constraint yet,
  // so we rely on this check until the migration lands.
  const { data: existingMatch } = await supabase
    .from('matches')
    .select('id')
    .eq('challenge_id', challengeId)
    .maybeSingle();
  if (existingMatch) throw new Error('A match has already been submitted for this challenge');

  // Check session caps if session-based
  if (challenge.session_id) {
    const { data: capOk } = await supabase.rpc('check_session_caps', {
      p_player_id: player.id,
      p_session_id: challenge.session_id,
      p_match_type: challenge.type,
    });
    if (capOk === false) throw new Error('Session match cap reached');
  }

  // Get active season
  const { data: season } = await supabase.from('seasons').select('id').eq('active_flag', true).single();

  const formatWeight = getFormatWeight(challenge.format);
  const eventMult = getEventMultiplier(challenge.event_type);

  // Create match
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

  // Add match participants with pre-ratings
  const isDoubles = challenge.type === 'doubles';
  const matchParticipants = challenge.challenge_participants.map((cp: Record<string, unknown>) => {
    const playerData = cp.player as Record<string, unknown>;
    const ratingsData = Array.isArray(playerData?.ratings) ? playerData.ratings[0] : playerData?.ratings;
    const preRating = isDoubles
      ? (ratingsData as Record<string, unknown>)?.doubles_elo as number ?? 1200
      : (ratingsData as Record<string, unknown>)?.singles_elo as number ?? 1200;

    // Calculate points from games
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

  // Add match games
  const gameRows = input.games.map((g) => ({
    match_id: match.id,
    game_number: g.game_number,
    side_a_score: g.side_a_score,
    side_b_score: g.side_b_score,
  }));
  const { error: gamesError } = await supabase.from('match_games').insert(gameRows);
  if (gamesError) throw new Error(gamesError.message);

  // Notify other participants to confirm — batched insert + parallel email lookup
  const otherPlayers = (challenge.challenge_participants as Record<string, unknown>[]).filter(
    (cp) => cp.player_id !== player.id
  );
  const otherPlayerIds = otherPlayers.map((cp) => cp.player_id as string);

  if (otherPlayerIds.length > 0) {
    await supabase.from('notifications').insert(
      otherPlayerIds.map((pid) => ({
        player_id: pid,
        type: 'result_pending',
        title: 'Confirm Match Result',
        body: `${player.full_name} submitted a result. Please confirm.`,
        metadata: { match_id: match.id, challenge_id: challengeId },
      }))
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

  const mProps = getPlayerProps(player);
  trackServerEvent(player.id, 'match_result_submitted', {
    ...mProps,
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

  // Call the DB function for atomic Elo update
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

  const cProps = getPlayerProps(player);
  trackServerEvent(player.id, 'match_result_confirmed', { ...cProps, match_id: matchId });

  revalidatePath('/challenges');
  revalidatePath('/leaderboard');
  revalidatePath('/my-stats');
}

export async function disputeMatchResult(matchId: string, reason: string, category: string) {
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

  // Email admins about dispute (admin list and match score are independent — fetch in parallel)
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

// ============================================================
// Session Check-in
// ============================================================

export async function checkInToSession(sessionId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.from('session_attendance').insert({
    session_id: sessionId,
    player_id: player.id,
  });

  if (error) {
    if (error.code === '23505') throw new Error('Already checked in');
    throw new Error(error.message);
  }

  await supabase.from('players').update({ last_active_at: new Date().toISOString() }).eq('id', player.id);

  const sProps = getPlayerProps(player);
  trackServerEvent(player.id, 'session_checked_in', { ...sProps, session_id: sessionId });

  revalidatePath('/sessions');
  revalidatePath(`/sessions/${sessionId}`);
}

// ============================================================
// Walkover
// ============================================================

export async function reportWalkover(input: WalkoverReportInput) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  // Verify caller is a participant and the named forfeit player is on the opposing team.
  // Without this, any authenticated user could trigger a walkover for any challenge.
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

  // For withdrawal the reporter forfeits (their team); for no_show the reporter accuses
  // the opposing team. Either way the forfeit player must be on the opposite team from
  // whomever is staying in the match.
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

  // Service-role client: challenges_update_own RLS only lets the creator update;
  // a walkover can be reported by either side, so the non-creator path needs the bypass.
  const adminClient = createServiceRoleClient();
  await adminClient.from('challenges').update({ status: 'walkover_pending' }).eq('id', input.challenge_id);

  // Admin list and forfeit-player name are independent — fetch in parallel
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

// ============================================================
// Profile
// ============================================================

export async function updateProfile(data: {
  full_name: string;
  display_name?: string;
  phone?: string;
  bio?: string;
  hide_from_leaderboard?: boolean;
  show_activity_status?: boolean;
}) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const update: Record<string, unknown> = { full_name: data.full_name };
  if (data.display_name !== undefined) {
    // Empty string -> null so the column isn't stuck with ''
    update.display_name = data.display_name === '' ? null : data.display_name;
  }
  if (data.phone !== undefined) update.phone = data.phone;
  if (data.bio !== undefined) update.bio = data.bio;
  if (data.hide_from_leaderboard !== undefined) update.hide_from_leaderboard = data.hide_from_leaderboard;
  if (data.show_activity_status !== undefined) update.show_activity_status = data.show_activity_status;

  const { error } = await supabase
    .from('players')
    .update(update)
    .eq('id', player.id);

  if (error) throw new Error(error.message);
  revalidatePath('/settings');
}

export async function completeOnboarding(data: { full_name: string; display_name?: string; phone?: string }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Check if player record already exists
  const existingPlayer = await getCurrentPlayer();

  if (existingPlayer) {
    // Update existing player record
    const update: Record<string, unknown> = {
      full_name: data.full_name,
      onboarding_completed: true,
    };
    if (data.display_name) update.display_name = data.display_name;
    if (data.phone) update.phone = data.phone;

    const { error } = await supabase
      .from('players')
      .update(update)
      .eq('id', existingPlayer.id);

    if (error) throw new Error(error.message);
  } else {
    // Create new player record. RLS policy `players_self_insert` (00018) enforces
    // that user_id = auth.uid(), status = 'pending_approval', and role = 'player',
    // so the regular client is sufficient — no service role bypass required.
    const insert: Record<string, unknown> = {
      user_id: user.id,
      email: user.email!,
      full_name: data.full_name,
      onboarding_completed: true,
      status: 'pending_approval',
      role: 'player',
    };
    if (data.display_name) insert.display_name = data.display_name;
    if (data.phone) insert.phone = data.phone;

    const { data: newPlayer, error } = await supabase
      .from('players')
      .insert(insert)
      .select('id')
      .single();

    if (error) throw new Error(error.message);

    if (newPlayer) {
      const { error: ratingsError } = await supabase.from('ratings').insert({
        player_id: newPlayer.id,
        singles_elo: 1200,
        doubles_elo: 1200,
        singles_provisional: true,
        doubles_provisional: true,
        singles_k_factor: 40,
        doubles_k_factor: 40,
      });
      if (ratingsError) throw new Error(ratingsError.message);
    }
  }

  revalidatePath('/');
}

// ============================================================
// Notifications
// ============================================================

export async function markNotificationRead(notificationId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await supabase
    .from('notifications')
    .update({ read_flag: true })
    .eq('id', notificationId)
    .eq('player_id', player.id);
  revalidatePath('/notifications');
}

export async function markAllNotificationsRead() {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await supabase.from('notifications').update({ read_flag: true }).eq('player_id', player.id).eq('read_flag', false);
  revalidatePath('/notifications');
}

// ============================================================
// Announcement Read Tracking
// ============================================================

export async function markAnnouncementRead(announcementId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase
    .from('announcement_reads')
    .select('id')
    .eq('announcement_id', announcementId)
    .eq('player_id', player.id)
    .single();

  if (existing) return;

  await supabase.from('announcement_reads').insert({
    announcement_id: announcementId,
    player_id: player.id,
  });

  revalidatePath('/announcements');
}
