'use server';

import * as Sentry from '@sentry/nextjs';
import { createServerSupabaseClient, createServiceRoleClient, getCurrentPlayer } from './supabase-server';
import { revalidatePath } from 'next/cache';
import type { ChallengeCreateInput, MatchResultInput, WalkoverReportInput } from '@badminton/shared';
import { getFormatWeight, getEventMultiplier, MATCH_FORMAT_LABELS, rateLimit, toClientError } from '@badminton/shared';
import type { Database } from '@badminton/shared/database';

type PlayerPreferencesRow = Database['public']['Tables']['player_preferences']['Row'];
type PlayerPreferencesUpdate = Database['public']['Tables']['player_preferences']['Update'];

// Small helper: throttle sensitive actions per player. Uses the in-memory
// limiter from @badminton/shared (best-effort on serverless — swap for Upstash
// when multi-region guarantees are needed).
function enforceLimit(playerId: string, action: string, limit: number, windowMs: number) {
  const res = rateLimit(`player:${playerId}:${action}`, limit, windowMs);
  if (!res.success) {
    throw new Error('Too many requests — please slow down and try again in a moment.');
  }
}
import {
  sendChallengeReceivedEmail,
  sendChallengeAcceptedEmail,
  sendChallengeRejectedEmail,
  sendResultPendingEmail,
  sendDisputeOpenedEmail,
  sendWalkoverReportedEmail,
} from '@badminton/shared';
import { PostHog } from 'posthog-node';

const posthogServer = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY || 'dummy', {
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
  flushAt: 20,
  flushInterval: 5000,
  disableGeoip: true,
});

function trackServerEvent(
  playerId: string,
  event: string,
  properties: Record<string, unknown>
) {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
  posthogServer.capture({
    distinctId: playerId,
    event,
    properties,
  });
}

async function requirePlayer() {
  const player = await getCurrentPlayer();
  if (!player) throw new Error('Not authenticated');
  if (player.status === 'pending_approval') throw new Error('Account pending approval');
  if (player.status === 'suspended') throw new Error('Account suspended');
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
// Profile — avatar
// ============================================================

// URL must be an HTTPS link under the configured Supabase project host and
// under the `avatars/` bucket path. Anything else is rejected.
function isAllowedAvatarUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!base) return false;
    const baseHost = new URL(base).host;
    if (u.host !== baseHost) return false;
    // Public storage URLs look like /storage/v1/object/public/avatars/<id>.<ext>
    return u.pathname.includes('/storage/v1/object/public/avatars/');
  } catch {
    return false;
  }
}

export async function updateAvatarUrl(rawUrl: string) {
  const player = await requirePlayer();
  enforceLimit(player.id, 'avatar', 10, 60_000);

  // Trim cache-buster query string before validating the URL itself, then
  // persist the original (with ?t=...) so the browser refreshes properly.
  const toValidate = rawUrl.split('?')[0] ?? rawUrl;
  if (!isAllowedAvatarUrl(toValidate) || rawUrl.length > 1024) {
    throw new Error('Invalid avatar URL.');
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from('players')
    .update({ avatar_url: rawUrl })
    .eq('id', player.id); // server-enforced ownership — never trust client id

  if (error) throw toClientError(error, 'player.avatar.update');

  revalidatePath('/settings');
  revalidatePath('/');
}

// ============================================================
// Challenges
// ============================================================

export async function createChallenge(input: ChallengeCreateInput) {
  const player = await requirePlayer();
  enforceLimit(player.id, 'challenge.create', 20, 60 * 60_000);
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

  if (error) throw toClientError(error, 'player.action');

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
  if (partError) throw toClientError(partError, 'player.action');

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
    sendChallengeReceivedEmail(opponent.email, player.full_name, formatLabel, input.type, challenge.id).catch(() => {});
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

  const { data: existing } = await supabase.from('challenges').select('created_by').eq('id', challengeId).single();
  if (!existing) throw new Error('Challenge not found');
  if (existing.created_by === player.id) throw new Error('Cannot accept your own challenge');

  const { error } = await supabase
    .from('challenge_participants')
    .update({ confirmation_status: 'accepted', responded_at: new Date().toISOString() })
    .eq('challenge_id', challengeId)
    .eq('player_id', player.id);

  if (error) throw toClientError(error, 'player.action');

  // Check if all participants accepted
  const { data: participants } = await supabase
    .from('challenge_participants')
    .select('*')
    .eq('challenge_id', challengeId);

  const allAccepted = participants?.every((p) => p.confirmation_status === 'accepted');

  if (allAccepted) {
    await supabase.from('challenges').update({ status: 'accepted' }).eq('id', challengeId);
  } else {
    await supabase.from('challenges').update({ status: 'partially_confirmed' }).eq('id', challengeId);
  }

  // Notify challenger
  const { data: challenge } = await supabase.from('challenges').select('created_by').eq('id', challengeId).single();
  if (challenge) {
    await supabase.from('notifications').insert({
      player_id: challenge.created_by,
      type: 'challenge_accepted',
      title: 'Challenge Accepted',
      body: `${player.full_name} accepted your challenge!`,
      metadata: { challenge_id: challengeId },
    });

    // Send email
    const { data: creator } = await supabase.from('players').select('email').eq('id', challenge.created_by).single();
    if (creator?.email) {
      sendChallengeAcceptedEmail(creator.email, player.full_name, challengeId).catch(() => {});
    }
  }

  const props = getPlayerProps(player);
  trackServerEvent(player.id, 'challenge_accepted', { ...props, challenge_id: challengeId });

  revalidatePath('/challenges');
}

export async function rejectChallenge(challengeId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase.from('challenges').select('created_by').eq('id', challengeId).single();
  if (!existing) throw new Error('Challenge not found');
  if (existing.created_by === player.id) throw new Error('Cannot reject your own challenge');

  await supabase
    .from('challenge_participants')
    .update({ confirmation_status: 'rejected', responded_at: new Date().toISOString() })
    .eq('challenge_id', challengeId)
    .eq('player_id', player.id);

  await supabase.from('challenges').update({ status: 'rejected' }).eq('id', challengeId);

  const { data: challengeData } = await supabase.from('challenges').select('created_by').eq('id', challengeId).single();
  if (challengeData) {
    await supabase.from('notifications').insert({
      player_id: challengeData.created_by,
      type: 'challenge_rejected',
      title: 'Challenge Rejected',
      body: `${player.full_name} rejected your challenge.`,
      metadata: { challenge_id: challengeId },
    });

    // Send email
    const { data: creator } = await supabase.from('players').select('email').eq('id', challengeData.created_by).single();
    if (creator?.email) {
      sendChallengeRejectedEmail(creator.email, player.full_name, challengeId).catch(() => {});
    }
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

// QR submission — same match create logic as submitMatchResult, but the
// caller does not have the matchId yet (no match row exists until this runs),
// stamps submitted_via='qr' on the challenge, and is rate-limited separately.
export async function submitQrMatchResult(
  challengeId: string,
  input: { winner_side: 'a' | 'b'; games: { game_number: number; side_a_score: number; side_b_score: number }[] },
) {
  const player = await requirePlayer();
  enforceLimit(player.id, 'match.submit.qr', 10, 60 * 60_000);
  if (!Array.isArray(input.games) || input.games.length === 0 || input.games.length > 5) {
    throw new Error('Invalid match result.');
  }
  const supabase = await createServerSupabaseClient();

  const { data: challenge } = await supabase
    .from('challenges')
    .select('*, challenge_participants(*, player:players(*, ratings(*)))')
    .eq('id', challengeId)
    .single();

  if (!challenge) throw new Error('Challenge not found');
  if (challenge.status !== 'accepted') throw new Error('Challenge not accepted');

  // QR path double-check: token must still exist and be unexpired.
  if (!challenge.qr_token) throw new Error('QR code has been revoked');
  if (challenge.qr_expires_at && new Date(challenge.qr_expires_at) < new Date()) {
    throw new Error('QR code expired');
  }

  const isParticipant = (challenge.challenge_participants as { player_id: string }[] | null)?.some(
    (cp) => cp.player_id === player.id,
  );
  if (!isParticipant) throw new Error('Not a participant');

  // No match can already exist.
  const { data: existingMatch } = await supabase
    .from('matches')
    .select('id')
    .eq('challenge_id', challengeId)
    .maybeSingle();
  if (existingMatch) throw new Error('Result already submitted');

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
      completed_flag: true,
      winner_side: input.winner_side,
      score_summary: input.games.map((g) => `${g.side_a_score}-${g.side_b_score}`).join(', '),
      played_at: new Date().toISOString(),
      submitted_by: player.id,
      result_status: 'pending_confirmation',
    })
    .select()
    .single();

  if (matchError) throw toClientError(matchError, 'player.qr.submit');

  const isDoubles = challenge.type === 'doubles';
  const matchParticipants = challenge.challenge_participants.map((cp: Record<string, unknown>) => {
    const playerData = cp.player as Record<string, unknown>;
    const ratingsData = Array.isArray(playerData?.ratings) ? playerData.ratings[0] : playerData?.ratings;
    const preRating = isDoubles
      ? ((ratingsData as Record<string, unknown>)?.doubles_elo as number) ?? 1200
      : ((ratingsData as Record<string, unknown>)?.singles_elo as number) ?? 1200;
    const side = cp.team_side as string;
    let pointsScored = 0,
      pointsAllowed = 0,
      gamesWon = 0,
      gamesLost = 0;
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

  await supabase.from('match_participants').insert(matchParticipants);
  await supabase.from('match_games').insert(
    input.games.map((g) => ({
      match_id: match.id,
      game_number: g.game_number,
      side_a_score: g.side_a_score,
      side_b_score: g.side_b_score,
    })),
  );

  // Stamp the QR submission marker.
  await supabase
    .from('challenges')
    .update({ submitted_via: 'qr' })
    .eq('id', challengeId);

  const otherPlayers = challenge.challenge_participants.filter(
    (cp: Record<string, unknown>) => cp.player_id !== player.id,
  );
  for (const cp of otherPlayers) {
    await supabase.from('notifications').insert({
      player_id: cp.player_id as string,
      type: 'result_pending',
      title: 'Confirm Match Result',
      body: `${player.full_name} submitted a result via QR. Please confirm.`,
      metadata: { match_id: match.id, challenge_id: challengeId },
    });
    const { data: otherPlayer } = await supabase
      .from('players')
      .select('email')
      .eq('id', cp.player_id as string)
      .single();
    if (otherPlayer?.email) {
      const score = input.games.map((g) => `${g.side_a_score}-${g.side_b_score}`).join(', ');
      sendResultPendingEmail(otherPlayer.email, player.full_name, score, match.id).catch(() => {});
    }
  }

  trackServerEvent(player.id, 'match_result_submitted_qr', {
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

export async function submitMatchResult(
  challengeId: string,
  input: Omit<MatchResultInput, 'match_id'>,
) {
  const player = await requirePlayer();
  enforceLimit(player.id, 'match.submit', 15, 60 * 60_000);
  // Defensive input bounds — schemas already validate, but fail-closed here too.
  if (!Array.isArray(input.games) || input.games.length === 0 || input.games.length > 5) {
    throw new Error('Invalid match result.');
  }
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

  if (matchError) throw toClientError(matchError, 'player.action');

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

  await supabase.from('match_participants').insert(matchParticipants);

  // Add match games
  const gameRows = input.games.map((g) => ({
    match_id: match.id,
    game_number: g.game_number,
    side_a_score: g.side_a_score,
    side_b_score: g.side_b_score,
  }));
  await supabase.from('match_games').insert(gameRows);

  // Notify other participants to confirm
  const otherPlayers = challenge.challenge_participants.filter(
    (cp: Record<string, unknown>) => cp.player_id !== player.id
  );
  for (const cp of otherPlayers) {
    await supabase.from('notifications').insert({
      player_id: cp.player_id as string,
      type: 'result_pending',
      title: 'Confirm Match Result',
      body: `${player.full_name} submitted a result. Please confirm.`,
      metadata: { match_id: match.id, challenge_id: challengeId },
    });

    // Send email
    const { data: otherPlayer } = await supabase.from('players').select('email').eq('id', cp.player_id as string).single();
    if (otherPlayer?.email) {
      const score = input.games.map((g) => `${g.side_a_score}-${g.side_b_score}`).join(', ');
      sendResultPendingEmail(otherPlayer.email, player.full_name, score, match.id).catch(() => {});
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
    throw toClientError(error, 'player.action');
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

  // Email admins about dispute. Skip soft-deleted admin accounts so we
  // don't blast email to anonymized inboxes.
  // TODO: Phase 10 — scope by organization_id once multi-club is supported.
  const { data: admins } = await supabase
    .from('players')
    .select('email')
    .eq('role', 'admin')
    .is('deleted_at', null);
  const { data: matchData } = await supabase.from('matches').select('score_summary').eq('id', matchId).single();
  for (const admin of admins || []) {
    if (admin.email) {
      sendDisputeOpenedEmail(admin.email, matchData?.score_summary || 'N/A', reason, matchId).catch(() => {});
    }
  }

  revalidatePath('/challenges');
}

// ============================================================
// Session Check-in
// ============================================================

export async function checkInToSession(sessionId: string) {
  const player = await requirePlayer();
  enforceLimit(player.id, 'session.checkin', 5, 60 * 60_000);
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.from('session_attendance').insert({
    session_id: sessionId,
    player_id: player.id,
  });

  if (error) {
    if (error.code === '23505') throw new Error('Already checked in');
    throw toClientError(error, 'player.action');
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
  enforceLimit(player.id, 'walkover.report', 5, 60 * 60_000);
  const supabase = await createServerSupabaseClient();

  const { error } = await supabase.from('walkovers').insert({
    challenge_id: input.challenge_id,
    reported_by: player.id,
    forfeit_player_id: input.forfeit_player_id,
    walkover_type: input.walkover_type,
    notice_hours: input.notice_hours,
  });

  if (error) throw toClientError(error, 'player.action');

  await supabase.from('challenges').update({ status: 'walkover_pending' }).eq('id', input.challenge_id);

  // Email admins about walkover. Skip soft-deleted admin accounts.
  // TODO: Phase 10 — scope by organization_id once multi-club is supported.
  const { data: admins } = await supabase
    .from('players')
    .select('email')
    .eq('role', 'admin')
    .is('deleted_at', null);
  const { data: forfeitPlayer } = await supabase.from('players').select('full_name').eq('id', input.forfeit_player_id).single();
  for (const admin of admins || []) {
    if (admin.email) {
      sendWalkoverReportedEmail(admin.email, forfeitPlayer?.full_name || 'Unknown', input.walkover_type, input.challenge_id).catch(() => {});
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
  dominant_hand?: 'left' | 'right' | 'ambidextrous' | null;
  years_playing?: string | null;
  favourite_shot?: string | null;
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
  if (data.dominant_hand !== undefined) update.dominant_hand = data.dominant_hand;
  if (data.years_playing !== undefined) update.years_playing = data.years_playing;
  if (data.favourite_shot !== undefined) update.favourite_shot = data.favourite_shot;

  const { error } = await supabase
    .from('players')
    .update(update)
    .eq('id', player.id);

  if (error) throw toClientError(error, 'player.action');
  revalidatePath('/settings');
}

// ============================================================
// Player preferences — backed by the player_preferences table
// (Phase 2). Strongly typed against the generated Database type.
//
// Reads return the player's preferences row. Phase 2 backfill +
// auto-create trigger guarantee a row exists for every player; the
// defensive INSERT below handles a never-supposed-to-happen race
// rather than throwing an opaque error in the UI.
//
// Writes apply a partial patch over the row. We rely on RLS (Phase 2
// policies permit own-row INSERT/UPDATE) — no service role needed.
// player_id, created_at, updated_at are always derived from the
// authenticated session and the table defaults, never from caller input.
//
// TODO: Phase 10 — once the platform supports multiple clubs, scope
// the preferences row by (player_id, organization_id).
// ============================================================

export async function getPlayerPreferences(): Promise<PlayerPreferencesRow> {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from('player_preferences')
    .select('*')
    .eq('player_id', player.id)
    .maybeSingle();

  if (error) throw toClientError(error, 'pref.get');
  if (data) return data as PlayerPreferencesRow;

  // Should be unreachable per Phase 2 backfill + auto-create trigger,
  // but materialize a default row if it ever isn't.
  const { data: created, error: insertError } = await supabase
    .from('player_preferences')
    .insert({ player_id: player.id })
    .select('*')
    .single();

  if (insertError || !created) {
    throw toClientError(insertError ?? new Error('preferences row missing'), 'pref.get');
  }
  return created as PlayerPreferencesRow;
}

export async function updatePlayerPreferences(
  patch: PlayerPreferencesUpdate
): Promise<PlayerPreferencesRow> {
  const player = await requirePlayer();
  enforceLimit(player.id, 'pref-update', 60, 60_000);

  // Strip caller-provided values for fields the server owns.
  const {
    player_id: _player_id,
    created_at: _created_at,
    updated_at: _updated_at,
    ...safe
  } = patch;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('player_preferences')
    .update(safe)
    .eq('player_id', player.id)
    .select('*')
    .single();

  if (error || !data) {
    throw toClientError(error ?? new Error('update returned no row'), 'pref.update');
  }
  revalidatePath('/settings');
  return data as PlayerPreferencesRow;
}

// ============================================================
// Account lifecycle — self-delete (Phase 4.5)
//
// Anonymizes the players row (display_name, email, avatar_url, bio,
// phone, deleted_at) so foreign-key references in matches / challenges
// / ratings stay intact and opponent history is preserved. Then
// hard-deletes the auth.users row via the admin API so the user can
// never sign in again.
//
// Service role is required for auth.admin.deleteUser; the soft-delete
// UPDATE could go through RLS but uses the same service-role client
// for a single transactional surface and to simplify error handling.
//
// If the auth.admin.deleteUser call fails AFTER the players row has
// been anonymized, we log to Sentry and return success anyway — the
// user-visible result (account anonymized, session ends) is achieved.
// An orphan auth.users row is a server-side cleanup task, not a UX
// issue.
//
// Rate-limited to 3 attempts per 24h per player to prevent griefing.
//
// TODO: Phase 10 — notify org admin when a member deletes their account.
// ============================================================

export async function deleteAccount(): Promise<{ success: true }> {
  const player = await requirePlayer();
  enforceLimit(player.id, 'delete-account', 3, 24 * 60 * 60_000);

  const userId = (player as { user_id?: string | null }).user_id;
  if (!userId) {
    // Defensive: every player row should have a user_id FK to auth.users.
    throw new Error('Account is not linked to a sign-in identity.');
  }

  const admin = createServiceRoleClient();

  // 1. Anonymize the players row. PII is cleared; deleted_at is the
  //    canonical "this account is gone" marker. The row itself stays so
  //    matches/challenges/ratings keep their FKs.
  const { error: updateError } = await admin
    .from('players')
    .update({
      display_name: 'Deleted Player',
      email: null,
      avatar_url: null,
      bio: null,
      phone: null,
      deleted_at: new Date().toISOString(),
    })
    .eq('id', player.id);

  if (updateError) {
    // Anonymization failed — abort BEFORE deleting the auth user. Better
    // to leave the account intact than to strand the auth identity.
    Sentry.captureException(updateError, {
      tags: { action: 'deleteAccount', step: 'anonymize' },
      extra: { player_id: player.id },
    });
    throw toClientError(updateError, 'account.delete');
  }

  // 2. Hard-delete the auth.users row. If this fails after step 1, the
  //    user-visible state is still "account anonymized + signed out" so
  //    we log and proceed.
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);

  if (deleteError) {
    Sentry.captureException(deleteError, {
      tags: { action: 'deleteAccount', step: 'auth-delete' },
      extra: { player_id: player.id, user_id: userId },
    });
    // Intentionally swallowed: the players row is already anonymized
    // and the client will sign out + redirect after this returns.
  }

  trackServerEvent(player.id, 'account_deleted', {
    player_id: player.id,
    auth_delete_failed: !!deleteError,
  });

  return { success: true };
}

// ============================================================
// Legacy preferences JSONB — players.notification_preferences
// ============================================================
// Persists arbitrary preference keys into players.notification_preferences (JSONB).
// Used by Settings → Preferences/Notifications/Challenges/Account tabs to save
// toggles and segmented controls that don't have their own column yet.
//
// Status: still in use for the desktop-only orphans
// (leaderboardDefault, emailChannel) that don't have a player_preferences
// column. Notification + privacy + match-pref toggles now write to
// player_preferences via updatePlayerPreferences.
export async function updatePreferences(prefs: Record<string, unknown>) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: current } = await supabase
    .from('players')
    .select('notification_preferences')
    .eq('id', player.id)
    .single();

  const merged = {
    ...((current?.notification_preferences as Record<string, unknown>) ?? {}),
    ...prefs,
  };

  const { error } = await supabase
    .from('players')
    .update({ notification_preferences: merged })
    .eq('id', player.id);

  if (error) throw toClientError(error, 'player.action');
  revalidatePath('/settings');
}

export async function completeOnboarding(data: {
  full_name: string;
  display_name?: string;
  phone?: string;
  skill_level?: 'beginner' | 'casual' | 'intermediate' | 'advanced';
  format_preference?: 'singles' | 'doubles' | 'both';
  goal?: string;
  sfu_student_id?: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Check if player record already exists
  const existingPlayer = await getCurrentPlayer();

  // Onboarding skill -> starting ELO bucket
  const STARTING_ELO: Record<string, number> = {
    beginner: 1100,
    casual: 1300,
    intermediate: 1500,
    advanced: 1700,
  };
  const startingElo = data.skill_level ? STARTING_ELO[data.skill_level] : null;

  if (existingPlayer) {
    // Update existing player record
    const update: Record<string, unknown> = {
      full_name: data.full_name,
      onboarding_completed: true,
    };
    if (data.display_name) update.display_name = data.display_name;
    if (data.phone) update.phone = data.phone;
    if (data.skill_level) update.skill_level = data.skill_level;
    if (data.format_preference) update.format_preference = data.format_preference;
    if (data.goal) update.goal = data.goal;
    if (data.sfu_student_id) update.sfu_student_id = data.sfu_student_id;

    const { error } = await supabase
      .from('players')
      .update(update)
      .eq('id', existingPlayer.id);

    if (error) throw toClientError(error, 'player.action');
  } else {
    // Create new player record using service role to bypass RLS
    const adminClient = createServiceRoleClient();
    const insert: Record<string, unknown> = {
      user_id: user.id,
      email: user.email!,
      full_name: data.full_name,
      onboarding_completed: true,
      status: 'pending_approval',
    };
    if (data.display_name) insert.display_name = data.display_name;
    if (data.phone) insert.phone = data.phone;
    if (data.skill_level) insert.skill_level = data.skill_level;
    if (data.format_preference) insert.format_preference = data.format_preference;
    if (data.goal) insert.goal = data.goal;
    if (data.sfu_student_id) insert.sfu_student_id = data.sfu_student_id;

    const { data: newPlayer, error } = await adminClient
      .from('players')
      .insert(insert)
      .select('id')
      .single();

    if (error) throw toClientError(error, 'player.action');

    // Create initial ratings record (skill-driven starting ELO if provided)
    if (newPlayer) {
      const seedElo = startingElo ?? 1200;
      await adminClient.from('ratings').insert({
        player_id: newPlayer.id,
        singles_elo: seedElo,
        doubles_elo: seedElo,
        singles_provisional: true,
        doubles_provisional: true,
        singles_k_factor: 40,
        doubles_k_factor: 40,
      });
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
  // Phase 7: also set read_at so we can show "read 12 minutes ago" later
  // and so analytics can compare delivered-vs-read latency.
  await supabase
    .from('notifications')
    .update({ read_flag: true, read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('player_id', player.id)
    .is('read_at', null);
  revalidatePath('/notifications');
}

export async function markAllNotificationsRead() {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await supabase
    .from('notifications')
    .update({ read_flag: true, read_at: new Date().toISOString() })
    .eq('player_id', player.id)
    .eq('read_flag', false);
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
