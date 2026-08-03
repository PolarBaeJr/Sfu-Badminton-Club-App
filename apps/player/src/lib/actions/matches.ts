'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import {
  sendResultPendingEmail,
  sendDisputeOpenedEmail,
  sendWalkoverReportedEmail,
  matchResultSchema,
  disputeSchema,
  walkoverReportSchema,
  parseOrThrow,
  ExpectedError,
  dbError,
  type MatchResultInput,
  type WalkoverReportInput,
} from '@badminton/shared';
import { requirePlayer, getPlayerProps, trackServerEvent, notifyPlayers, runAction, type ActionResult } from './_shared';

export async function submitMatchResult(challengeId: string, input: MatchResultInput): Promise<ActionResult<string>> {
  return runAction(() => submitMatchResultImpl(challengeId, input));
}

async function submitMatchResultImpl(challengeId: string, input: MatchResultInput) {
  // parseOrThrow, not a hand-rolled safeParse: the hand-rolled version rethrew
  // the Zod message as a plain Error, so ordinary score-entry mistakes ("winner
  // side does not match game scores") were filed in Sentry as faults.
  parseOrThrow(matchResultSchema, input);

  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  // No players embed: 00032 revoked blanket SELECT on players and granted a
  // safe column subset, so `players(*)` is refused outright — and because the
  // error used to be discarded, that surfaced as "Challenge not found" on a
  // challenge that plainly existed. Nothing below this ever read the embedded
  // player or its ratings; submit_match_result derives participants itself.
  const { data: challenge, error: challengeError } = await supabase
    .from('challenges')
    .select('id, status, format, challenge_participants(player_id)')
    .eq('id', challengeId)
    .single();

  // PGRST116 is genuinely "no rows"; anything else (a permission error, say) is
  // a real fault and must not be flattened into a misleading "not found".
  if (challengeError && challengeError.code !== 'PGRST116') throw new Error(challengeError.message);
  // A challenge that has moved on, or that this player isn't on, is a stale page
  // — not a fault. (A genuine permission error still throws above.)
  if (!challenge) throw new ExpectedError('Challenge not found');
  if (challenge.status !== 'accepted') throw new ExpectedError('Challenge not accepted');

  const isParticipant = (challenge.challenge_participants as { player_id: string }[] | null)?.some(
    (cp) => cp.player_id === player.id
  );
  if (!isParticipant) throw new ExpectedError('Not a participant');

  // One RPC replaces what used to be three separate writes (match ->
  // participants -> games). Those were non-atomic: a crash between the match
  // insert and the compensating delete wedged the challenge permanently, since
  // matches_challenge_id_unique blocks any resubmit. Just as importantly, the
  // participant rows used to be built client-side, so a submitter could enrol
  // any player they liked; the function derives them from challenge_participants
  // instead. `authenticated` no longer holds INSERT on these tables (00027), so
  // this is also the only way in.
  const { data: newMatchId, error: submitError } = await supabase.rpc('submit_match_result', {
    p_challenge_id: challengeId,
    p_games: input.games.map((g) => ({ side_a_score: g.side_a_score, side_b_score: g.side_b_score })),
    p_completed: input.completed,
  });
  if (submitError) throw dbError(submitError);
  const matchId = newMatchId as string;

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
        metadata: { match_id: matchId, challenge_id: challengeId },
      })),
      {
        title: 'Confirm Match Result',
        body: `${player.full_name} submitted a result. Please confirm.`,
        url: `/challenges/${challengeId}`,
      },
      'matches'
    );

    const { data: emails } = await createServiceRoleClient() /* 00032 */
      .from('players')
      .select('id, email')
      .in('id', otherPlayerIds);
    const score = input.games.map((g) => `${g.side_a_score}-${g.side_b_score}`).join(', ');
    for (const row of emails ?? []) {
      if (row.email) {
        sendResultPendingEmail(row.email, player.full_name, score, matchId).catch((err) => {
          Sentry.captureException(err, { extra: { email: 'result_pending', matchId: matchId } });
        });
      }
    }
  }

  trackServerEvent(player.id, 'match_result_submitted', {
    ...getPlayerProps(player),
    match_id: matchId,
    challenge_id: challengeId,
    format: challenge.format,
    winner_side: input.winner_side,
  });

  revalidatePath('/challenges');
  revalidatePath(`/challenges/${challengeId}`);
  return matchId;
}

export async function confirmMatchResult(matchId: string): Promise<ActionResult> {
  return runAction(() => confirmMatchResultImpl(matchId));
}

async function confirmMatchResultImpl(matchId: string) {
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: mp } = await supabase
    .from('match_participants')
    .select('player_id')
    .eq('match_id', matchId);
  if (!mp?.some((row) => row.player_id === player.id)) throw new ExpectedError('Not a participant');

  const { error } = await supabase.rpc('apply_match_result', {
    p_match_id: matchId,
    p_confirmed_by: player.id,
  });

  // No captureException here: runAction already reports whatever this throws,
  // so capturing as well filed every confirm failure in Sentry twice — once as
  // "Match confirmation failed: X" and once as bare "X". dbError decides which
  // ones are faults at all; confirming a match that someone already confirmed
  // or disputed is a stale button, not a defect.
  if (error) throw dbError(error);

  trackServerEvent(player.id, 'match_result_confirmed', { ...getPlayerProps(player), match_id: matchId });
  revalidatePath('/challenges');
  revalidatePath('/leaderboard');
  revalidatePath('/my-stats');
}

export async function disputeMatchResult(matchId: string, reason: string, category: string): Promise<ActionResult> {
  return runAction(() => disputeMatchResultImpl(matchId, reason, category));
}

async function disputeMatchResultImpl(matchId: string, reason: string, category: string) {
  parseOrThrow(disputeSchema, { match_id: matchId, reason_category: category, description: reason });
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  // One RPC instead of a participant check + match UPDATE + dispute INSERT.
  // `authenticated` no longer holds UPDATE on matches (migration 00027), so the
  // write has to happen inside the definer function anyway — and doing it there
  // makes the whole thing atomic and adds the checks this path was missing: the
  // match must actually be disputable (not already voided/disputed) and only one
  // open dispute may exist per match.
  const { error } = await supabase.rpc('dispute_match_result', {
    p_match_id: matchId,
    p_reason_category: category,
    p_description: reason,
  });
  if (error) throw dbError(error);

  const [adminsRes, matchRes] = await Promise.all([
    createServiceRoleClient() /* 00032: email is not readable by `authenticated` */.from('players').select('email').eq('role', 'admin'),
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

export async function reportWalkover(input: WalkoverReportInput): Promise<ActionResult> {
  return runAction(() => reportWalkoverImpl(input));
}

async function reportWalkoverImpl(input: WalkoverReportInput) {
  parseOrThrow(walkoverReportSchema, input);
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  const { data: challenge, error: challengeError } = await supabase
    .from('challenges')
    .select('status, challenge_participants(player_id, team_side)')
    .eq('id', input.challenge_id)
    .single();
  if (challengeError && challengeError.code !== 'PGRST116') throw new Error(challengeError.message);
  if (!challenge) throw new ExpectedError('Challenge not found');
  if (!['accepted', 'partially_confirmed'].includes(challenge.status)) {
    throw new ExpectedError('Challenge is not in a state that can be forfeited');
  }

  // A challenge keeps status 'accepted' while a submitted result waits to be
  // confirmed, so the status check above passes and a walkover could be filed
  // on a match that had already been played and reported — flipping the
  // challenge to walkover_pending and burying the pending result. Someone who
  // disagrees with a submitted result has the dispute flow; forfeiting is for
  // a match that did not happen.
  //
  // Service-role read: the answer must be authoritative. Under RLS a row the
  // caller cannot see would look like no match at all, and the guard would fail
  // open exactly when it matters.
  const { data: existingMatch } = await createServiceRoleClient()
    .from('matches')
    .select('id, result_status')
    .eq('challenge_id', input.challenge_id)
    .maybeSingle();
  if (existingMatch) {
    throw new ExpectedError(
      existingMatch.result_status === 'pending_confirmation'
        ? 'A result has already been submitted for this match — confirm or dispute it instead'
        : 'This match already has a result and cannot be forfeited'
    );
  }
  const cps = (challenge.challenge_participants as { player_id: string; team_side: string }[] | null) ?? [];
  const reporter = cps.find((cp) => cp.player_id === player.id);
  if (!reporter) throw new ExpectedError('Not a participant');
  const forfeit = cps.find((cp) => cp.player_id === input.forfeit_player_id);
  if (!forfeit) throw new ExpectedError('Forfeit player is not in this challenge');

  // For withdrawal the reporter forfeits (their team); for no_show the reporter
  // accuses the opposing team. Either way the forfeit player must be on the
  // opposite team from whomever is staying in the match.
  const reporterIsForfeiting = input.walkover_type === 'withdrawal';
  if (reporterIsForfeiting && forfeit.team_side !== reporter.team_side) {
    throw new ExpectedError('Withdrawal must name a teammate (or yourself)');
  }
  if (!reporterIsForfeiting && forfeit.team_side === reporter.team_side) {
    throw new ExpectedError('No-show must name a player on the opposing team');
  }

  const { error } = await supabase.from('walkovers').insert({
    challenge_id: input.challenge_id,
    reported_by: player.id,
    forfeit_player_id: input.forfeit_player_id,
    walkover_type: input.walkover_type,
    notice_hours: input.notice_hours,
  });
  if (error) throw dbError(error);

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
    },
    'matches'
  );

  const [adminsRes, forfeitRes] = await Promise.all([
    createServiceRoleClient() /* 00032: email is not readable by `authenticated` */.from('players').select('email').eq('role', 'admin'),
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
