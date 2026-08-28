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
  ExpectedError,
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

  // ONE STATEMENT, and it is the fix for F-014. This used to be a validate
  // call, an insert of the challenge, and an insert of the participants with a
  // second client — three round trips. A failure at the third left a 'proposed'
  // challenge with NO participants, which nothing can ever accept, reject or
  // cancel (all three look the actor up in the participant list) and which
  // counts against max_active_challenges for good. Three of those and the
  // member cannot challenge anybody again.
  //
  // The cap check moved inside for the same reason: it used to be a read
  // milliseconds before the insert, so two tabs submitted together both passed
  // a cap of 3 at 2. 00183 holds an advisory lock on the creator across both.
  //
  // The member's own client, not the service role: 00183 takes no player id and
  // resolves the creator from auth.uid(), so there is nothing here to
  // impersonate with (00126).
  const { data: created, error } = await supabase.rpc('create_challenge_atomic', {
    p_type: input.type,
    p_rated_flag: input.rated_flag,
    p_format: input.format,
    p_opponent_id: input.opponent_id,
    p_partner_id: input.partner_id || null,
    p_opponent_partner_id: input.opponent_partner_id || null,
    // Null unless the player chose a custom shape; submit_match_result and
    // trigger_set_match_weights fall back to the preset when these are null.
    p_games_per_match: input.games_per_match ?? null,
    p_points_per_game: input.points_per_game ?? null,
    p_session_id: input.session_id || null,
    p_scheduled_date: input.scheduled_date || null,
    p_scheduled_time: input.scheduled_time || null,
    p_note: input.note || null,
  });

  // Fail closed: an RPC error or a null result must block creation. Before
  // 00126-era hardening the error was discarded and a falsy validation skipped
  // the guard entirely, letting a caller bypass every check.
  if (error) throw new Error(error.message);
  if (!created) throw new Error('Could not create this challenge — please try again.');
  if (!created.valid) {
    // The club's own rules saying no (self-challenge, suspended opponent, too
    // many open challenges, same opponent too soon). The rules working is not a
    // fault — only `error` above is.
    const errors = (created.errors ?? ['Challenge is not allowed']) as string[];
    throw new ExpectedError(errors.join(', '));
  }
  const challengeId = created.challenge_id as string;

  await notifyPlayers(
    [{
      player_id: input.opponent_id,
      type: 'challenge_received',
      title: 'New Challenge',
      body: `${player.full_name} has challenged you!`,
      metadata: { challenge_id: challengeId },
    }],
    {
      title: 'New Challenge',
      body: `${player.full_name} has challenged you!`,
      url: `/challenges/${challengeId}`,
    },
    'challenges'
  );

  const { data: opponent } = await createServiceRoleClient() /* 00032: email is not readable by `authenticated` */.from('players').select('email').eq('id', input.opponent_id).single();
  if (opponent?.email) {
    const formatLabel = MATCH_FORMAT_LABELS[input.format as keyof typeof MATCH_FORMAT_LABELS] || input.format;
    sendChallengeReceivedEmail(opponent.email, player.full_name, formatLabel, input.type, challengeId).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_received', challengeId } });
    });
  }

  // Service-role, not the user's client: 00126 revokes EXECUTE on this
  // SECURITY DEFINER function from anon and authenticated. It takes the player
  // id as a parameter and checks nothing internally, so while it was reachable
  // over PostgREST any caller could inflate anyone's reliability counter. The
  // counter is server-derived bookkeeping, never something the browser asks
  // for, so moving the one call site to the trusted key is the fix — the
  // alternative was rewriting a SECURITY DEFINER body, which 00049 warns about.
  // `player.id` comes from requirePlayer() above, i.e. the verified session.
  await createServiceRoleClient().rpc('increment_challenges_issued', { p_player_id: player.id });

  trackServerEvent(player.id, 'challenge_created', {
    ...getPlayerProps(player),
    challenge_id: challengeId,
    challenge_type: input.type,
    format: input.format,
    rated: input.rated_flag,
  });

  revalidatePath('/challenges');
  revalidatePath('/feed');
  return challengeId;
}

/**
 * Turn a refusal from respond_to_challenge (00183) into the sentence the member
 * used to get from the equivalent read-then-check in this file.
 *
 * `not_found` stays a PLAIN Error on purpose: under RLS an invisible row looks
 * exactly like a deleted one, so keeping it reportable is what surfaces a
 * row-visibility regression (see expected-error.ts). Everything else is a rule
 * working as intended and reaches the member as a sentence.
 */
function challengeResponseError(result: { reason?: string }, verb: 'accept' | 'reject'): Error {
  switch (result.reason) {
    case 'not_found':         return new Error('Challenge not found');
    case 'own_challenge':     return new ExpectedError(`Cannot ${verb} your own challenge`);
    case 'not_participant':   return new ExpectedError('Not a participant');
    case 'already_responded': return new ExpectedError('Already responded to this challenge');
    // Cancelled, expired, or already ended by somebody else's rejection. The
    // status check happens under the row lock, so a cancel racing an accept
    // resolves one way rather than both.
    case 'not_open':          return new ExpectedError('This challenge is no longer open');
    default:                  return new Error('Could not record your answer — please try again.');
  }
}

export async function acceptChallenge(challengeId: string): Promise<ActionResult> {
  return runAction(() => acceptChallengeImpl(challengeId));
}

async function acceptChallengeImpl(challengeId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();
  await assertCurrentWaiver(supabase, player);

  // ONE STATEMENT, and it is the fix for F-008. What was here read the
  // participant list, wrote this member's row, then recomputed the aggregate
  // status from the snapshot taken BEFORE that write — its own comment said
  // "still racy across concurrent accepts; canonical fix is a SECURITY DEFINER
  // RPC". Two partners accepting a doubles challenge in the same second each
  // saw the other still pending, so both wrote 'partially_confirmed' over a
  // challenge every participant had accepted. Stranded: nothing recomputes it
  // again, and neither member did anything wrong.
  //
  // 00183 takes the challenge row FOR UPDATE, so the recompute always runs on a
  // participant list nobody else is midway through changing.
  const { data: result, error: respondError } = await supabase.rpc('respond_to_challenge', {
    p_challenge_id: challengeId,
    p_response: 'accepted',
  });
  if (respondError) throw new Error(respondError.message);
  if (!result) throw new Error('Could not record your answer — please try again.');
  if (!result.ok) throw challengeResponseError(result, 'accept');

  const createdBy = result.created_by as string;

  await notifyPlayers(
    [{
      player_id: createdBy,
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

  const { data: creator } = await createServiceRoleClient() /* 00032: email is not readable by `authenticated` */.from('players').select('email').eq('id', createdBy).single();
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

  // Same RPC as acceptChallenge and the same reason (F-008). Rejection had the
  // milder version of the race — it always wrote 'rejected' — but it shared the
  // read-then-write shape, and it discarded both write errors, so a rejection
  // that never landed still notified the creator and emailed them.
  const { data: result, error: respondError } = await supabase.rpc('respond_to_challenge', {
    p_challenge_id: challengeId,
    p_response: 'rejected',
  });
  if (respondError) throw new Error(respondError.message);
  if (!result) throw new Error('Could not record your answer — please try again.');
  if (!result.ok) throw challengeResponseError(result, 'reject');

  const createdBy = result.created_by as string;

  // Service-role via notifyPlayers — notifications RLS blocks direct inserts
  // for other players.
  await notifyPlayers([{
    player_id: createdBy,
    type: 'challenge_rejected',
    title: 'Challenge Rejected',
    body: `${player.full_name} rejected your challenge.`,
    metadata: { challenge_id: challengeId },
  }]);

  const { data: creator } = await createServiceRoleClient() /* 00032: email is not readable by `authenticated` */.from('players').select('email').eq('id', createdBy).single();
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
  if (challenge.created_by !== player.id) throw new ExpectedError('Only the creator can cancel');
  if (!['proposed', 'partially_confirmed'].includes(challenge.status)) {
    throw new ExpectedError('Challenge cannot be cancelled in its current state');
  }

  // Compare-and-swap on the status the read above saw, and observe the affected
  // rows. Without either, a cancel racing the last participant's accept won a
  // challenge that had just become playable, and a cancel that matched nothing
  // at all still went on to tell everybody it had been cancelled.
  const { data: cancelled, error: cancelError } = await supabase
    .from('challenges')
    .update({ status: 'cancelled' })
    .eq('id', challengeId)
    .in('status', ['proposed', 'partially_confirmed'])
    .select('id');
  if (cancelError) throw new Error(cancelError.message);
  if (!cancelled || cancelled.length === 0) {
    throw new ExpectedError('Challenge cannot be cancelled in its current state');
  }

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
