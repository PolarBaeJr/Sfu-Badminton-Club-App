'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import {
  sendChallengeReceivedEmail,
  sendChallengeAcceptedEmail,
  sendChallengeRejectedEmail,
  MATCH_FORMAT_LABELS,
  challengeCreateSchema,
  parseOrThrow,
  type ChallengeCreateInput,
} from '@badminton/shared';
import { requirePlayer, getPlayerProps, trackServerEvent, notifyPlayers } from './_shared';

export async function createChallenge(input: ChallengeCreateInput) {
  parseOrThrow(challengeCreateSchema, input);
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

  await notifyPlayers(
    [{
      player_id: input.opponent_id,
      type: 'challenge_received',
      title: 'New Challenge',
      body: `${player.full_name} has challenged you!`,
      metadata: { challenge_id: challenge.id },
    }],
    {
      title: 'New Challenge',
      body: `${player.full_name} has challenged you!`,
      url: `/challenges/${challenge.id}`,
    }
  );

  const { data: opponent } = await supabase.from('players').select('email').eq('id', input.opponent_id).single();
  if (opponent?.email) {
    const formatLabel = MATCH_FORMAT_LABELS[input.format as keyof typeof MATCH_FORMAT_LABELS] || input.format;
    sendChallengeReceivedEmail(opponent.email, player.full_name, formatLabel, input.type, challenge.id).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_received', challengeId: challenge.id } });
    });
  }

  await supabase.rpc('increment_challenges_issued', { p_player_id: player.id });

  trackServerEvent(player.id, 'challenge_created', {
    ...getPlayerProps(player),
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

  // Recompute aggregate status from latest snapshot (still racy across concurrent
  // accepts; canonical fix is a SECURITY DEFINER RPC). Service role for the
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

  await notifyPlayers(
    [{
      player_id: challenge.created_by,
      type: 'challenge_accepted',
      title: 'Challenge Accepted',
      body: `${player.full_name} accepted your challenge!`,
      metadata: { challenge_id: challengeId },
    }],
    {
      title: 'Challenge Accepted',
      body: `${player.full_name} accepted your challenge!`,
      url: `/challenges/${challengeId}`,
    }
  );

  const { data: creator } = await supabase.from('players').select('email').eq('id', challenge.created_by).single();
  if (creator?.email) {
    sendChallengeAcceptedEmail(creator.email, player.full_name, challengeId).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_accepted', challengeId } });
    });
  }

  trackServerEvent(player.id, 'challenge_accepted', { ...getPlayerProps(player), challenge_id: challengeId });
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

  // Any single rejection terminates the challenge — intentional in doubles too,
  // since a partner declining means the matchup can't go ahead as proposed.
  // Service-role for the same RLS reason as acceptChallenge.
  const adminClient = createServiceRoleClient();
  await adminClient.from('challenges').update({ status: 'rejected' }).eq('id', challengeId);

  // Service-role via notifyPlayers — notifications RLS blocks direct inserts
  // for other players.
  await notifyPlayers([{
    player_id: challenge.created_by,
    type: 'challenge_rejected',
    title: 'Challenge Rejected',
    body: `${player.full_name} rejected your challenge.`,
    metadata: { challenge_id: challengeId },
  }]);

  const { data: creator } = await supabase.from('players').select('email').eq('id', challenge.created_by).single();
  if (creator?.email) {
    sendChallengeRejectedEmail(creator.email, player.full_name, challengeId).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_rejected', challengeId } });
    });
  }

  trackServerEvent(player.id, 'challenge_rejected', { ...getPlayerProps(player), challenge_id: challengeId });
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

  // Service-role via notifyPlayers — notifications RLS blocks direct inserts
  // for other players.
  await notifyPlayers(
    otherParticipants.map((cp) => ({
      player_id: cp.player_id,
      type: 'challenge_cancelled',
      title: 'Challenge Cancelled',
      body: `${player.full_name} cancelled the challenge.`,
      metadata: { challenge_id: challengeId },
    }))
  );

  trackServerEvent(player.id, 'challenge_cancelled', {
    ...getPlayerProps(player),
    challenge_id: challengeId,
  });

  revalidatePath('/challenges');
  revalidatePath(`/challenges/${challengeId}`);
}
