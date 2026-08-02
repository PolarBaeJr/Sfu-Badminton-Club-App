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
import { requirePlayer, getPlayerProps, trackServerEvent, notifyPlayers, assertCurrentWaiver, runAction, type ActionResult } from './_shared';

export async function createChallenge(input: ChallengeCreateInput): Promise<ActionResult<string>> {
  return runAction(() => createChallengeImpl(input));
}

async function createChallengeImpl(input: ChallengeCreateInput) {
  parseOrThrow(challengeCreateSchema, input);
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await assertCurrentWaiver(supabase, player);

  // Validate via DB function. Fail closed: an RPC error or a null/!valid result
  // must block creation. Previously the error was discarded and a falsy
  // `validation` skipped the guard entirely, letting a caller bypass every
  // check (self-challenge, suspended opponent, open-challenge cap, repeat
  // opponent) and then enroll arbitrary player IDs via the service-role insert.
  const { data: validation, error: validationError } = await supabase.rpc('validate_challenge_creation', {
    p_creator_id: player.id,
    p_opponent_id: input.opponent_id,
    p_type: input.type,
    p_partner_id: input.partner_id || null,
    p_opponent_partner_id: input.opponent_partner_id || null,
  });

  if (validationError) throw new Error(validationError.message);
  if (!validation) throw new Error('Could not validate this challenge — please try again.');
  if (!validation.valid) {
    const errors = (validation.errors ?? ['Challenge is not allowed']) as string[];
    throw new Error(errors.join(', '));
  }

  const eventType = input.rated_flag ? 'rated_challenge' : 'casual';

  const { data: challenge, error } = await supabase
    .from('challenges')
    .insert({
      type: input.type,
      rated_flag: input.rated_flag,
      format: input.format,
      // Null unless the player chose a custom shape; submit_match_result and
      // trigger_set_match_weights fall back to the preset when these are null.
      games_per_match: input.games_per_match ?? null,
      points_per_game: input.points_per_game ?? null,
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

  // Service-role for the participant insert: the batch includes rows for the
  // opponent (and partners), whose player_id != the creator's. cp_insert RLS
  // only permits self-rows (or admin), so Postgres' per-row WITH CHECK rejects
  // the whole statement for a non-admin creator. Rows are server-constructed
  // and already gated by validate_challenge_creation above, so this is safe.
  const participantsClient = createServiceRoleClient();
  const { error: partError } = await participantsClient.from('challenge_participants').insert(participants);
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
    },
    'challenges'
  );

  const { data: opponent } = await createServiceRoleClient() /* 00032: email is not readable by `authenticated` */.from('players').select('email').eq('id', input.opponent_id).single();
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

export async function acceptChallenge(challengeId: string): Promise<ActionResult> {
  return runAction(() => acceptChallengeImpl(challengeId));
}

async function acceptChallengeImpl(challengeId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await assertCurrentWaiver(supabase, player);

  const { data: challenge, error: challengeError } = await supabase
    .from('challenges')
    .select('created_by, challenge_participants(player_id, confirmation_status)')
    .eq('id', challengeId)
    .single();
  // PGRST116 is genuinely "no rows". Anything else — a permission error, say —
  // must surface as itself rather than be flattened into a misleading
  // "not found" on a challenge that exists.
  if (challengeError && challengeError.code !== 'PGRST116') throw new Error(challengeError.message);
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
    },
    'challenges'
  );

  const { data: creator } = await createServiceRoleClient() /* 00032: email is not readable by `authenticated` */.from('players').select('email').eq('id', challenge.created_by).single();
  if (creator?.email) {
    sendChallengeAcceptedEmail(creator.email, player.full_name, challengeId).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_accepted', challengeId } });
    });
  }

  trackServerEvent(player.id, 'challenge_accepted', { ...getPlayerProps(player), challenge_id: challengeId });
  revalidatePath('/challenges');
}

export async function rejectChallenge(challengeId: string): Promise<ActionResult> {
  return runAction(() => rejectChallengeImpl(challengeId));
}

async function rejectChallengeImpl(challengeId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: challenge, error: challengeError } = await supabase
    .from('challenges')
    .select('created_by, challenge_participants(player_id, confirmation_status)')
    .eq('id', challengeId)
    .single();
  // PGRST116 is genuinely "no rows". Anything else — a permission error, say —
  // must surface as itself rather than be flattened into a misleading
  // "not found" on a challenge that exists.
  if (challengeError && challengeError.code !== 'PGRST116') throw new Error(challengeError.message);
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

  const { data: creator } = await createServiceRoleClient() /* 00032: email is not readable by `authenticated` */.from('players').select('email').eq('id', challenge.created_by).single();
  if (creator?.email) {
    sendChallengeRejectedEmail(creator.email, player.full_name, challengeId).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_rejected', challengeId } });
    });
  }

  trackServerEvent(player.id, 'challenge_rejected', { ...getPlayerProps(player), challenge_id: challengeId });
  revalidatePath('/challenges');
}

export async function cancelChallenge(challengeId: string): Promise<ActionResult> {
  return runAction(() => cancelChallengeImpl(challengeId));
}

async function cancelChallengeImpl(challengeId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: challenge, error: challengeError } = await supabase
    .from('challenges')
    .select('*, challenge_participants(player_id)')
    .eq('id', challengeId)
    .single();

  // PGRST116 is genuinely "no rows". Anything else — a permission error, say —
  // must surface as itself rather than be flattened into a misleading
  // "not found" on a challenge that exists.
  if (challengeError && challengeError.code !== 'PGRST116') throw new Error(challengeError.message);
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
