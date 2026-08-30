'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import {
  sendResultPendingEmail,
  sendDisputeOpenedEmail,
  sendWalkoverReportedEmail,
  sendMatchConfirmedEmail,
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
  // Plain Error, not ExpectedError: under RLS an invisible row looks exactly
  // like a deleted one, so keeping this reportable is what surfaces a
  // row-visibility regression (see expected-error.ts).
  if (!challenge) throw new Error('Challenge not found');
  // A challenge that has moved on, or that this player isn't on, is a stale
  // page, not a fault.
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

  // Tell the OTHER participants it went through, with their own rating change.
  // Only after apply_match_result succeeds: pre/post ratings and rating_delta
  // are written by that RPC, so reading them any earlier gives nulls.
  //
  // Not the confirmer — they are looking at the screen that just did this.
  await notifyMatchConfirmed(matchId, player.id).catch((err) => {
    // Never fail a confirmed match over an email. The rating change is already
    // committed; the notification is a courtesy.
    Sentry.captureException(err, { extra: { step: 'match-confirmed-email', matchId } });
  });

  trackServerEvent(player.id, 'match_result_confirmed', { ...getPlayerProps(player), match_id: matchId });
  revalidatePath('/challenges');
  revalidatePath('/leaderboard');
  revalidatePath('/my-stats');
}

async function notifyMatchConfirmed(matchId: string, confirmerId: string) {
  // Service role: 00032 revoked blanket SELECT on players, so email is not
  // readable by `authenticated` even for a teammate.
  const admin = createServiceRoleClient();

  const [{ data: match }, { data: parts }] = await Promise.all([
    admin.from('matches').select('score_summary, match_type').eq('id', matchId).single(),
    admin
      .from('match_participants')
      .select('player_id, team_side, post_rating, rating_delta, players(full_name, email)')
      .eq('match_id', matchId),
  ]);
  if (!match || !parts?.length) return;

  const nameOf = (p: (typeof parts)[number]) =>
    (p.players as { full_name?: string } | null)?.full_name ?? 'your opponent';

  for (const p of parts) {
    if (p.player_id === confirmerId) continue;
    const email = (p.players as { email?: string } | null)?.email;
    // rating_delta is null for an unrated match — there is no Elo change worth
    // mailing about, so skip rather than send "+null Elo".
    if (!email || p.rating_delta === null || p.post_rating === null) continue;

    const opponents = parts.filter((o) => o.team_side !== p.team_side).map(nameOf);
    await sendMatchConfirmedEmail(
      email,
      opponents.join(' & ') || 'your opponent',
      match.score_summary ?? 'N/A',
      p.rating_delta,
      p.post_rating,
      match.match_type ?? 'match',
    );
  }
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

/**
 * Turn a refusal from report_walkover_atomic (00184) into the sentence the
 * member used to get from the equivalent read-then-check in this file.
 *
 * `not_found` stays a plain Error for the reason expected-error.ts gives: under
 * RLS an invisible challenge looks exactly like a deleted one.
 */
function walkoverReportError(result: { reason?: string; result_status?: string }): Error {
  switch (result.reason) {
    case 'not_found':
      return new Error('Challenge not found');
    case 'not_forfeitable':
      return new ExpectedError('Challenge is not in a state that can be forfeited');
    case 'result_exists':
      return new ExpectedError(
        result.result_status === 'pending_confirmation'
          ? 'A result has already been submitted for this match — confirm or dispute it instead'
          : 'This match already has a result and cannot be forfeited',
      );
    case 'not_participant':
      return new ExpectedError('Not a participant');
    case 'forfeit_not_in_challenge':
      return new ExpectedError('Forfeit player is not in this challenge');
    case 'withdrawal_wrong_side':
      return new ExpectedError('Withdrawal must name a teammate (or yourself)');
    case 'no_show_wrong_side':
      return new ExpectedError('No-show must name a player on the opposing team');
    // The partial unique index refusing a second pending walkover. Reached by a
    // double-tap or an action replay, so it is a sentence, not a fault.
    case 'already_reported':
      return new ExpectedError('A walkover has already been reported for this challenge');
    default:
      return new Error('Could not file this walkover — please try again.');
  }
}

export async function reportWalkover(input: WalkoverReportInput): Promise<ActionResult> {
  return runAction(() => reportWalkoverImpl(input));
}

async function reportWalkoverImpl(input: WalkoverReportInput) {
  parseOrThrow(walkoverReportSchema, input);
  const player = await requirePlayer();
  const supabase = await createServerSupabaseClient();

  // ONE STATEMENT, and it is the fix for F-009. This used to be four reads and
  // then two writes with two different clients: INSERT INTO walkovers, then
  // UPDATE challenges SET status='walkover_pending'. A failure at the second
  // left the walkover filed with the challenge still reading 'accepted', so the
  // member could file the same forfeit again and an exec saw two rows in the
  // queue for one match. A plain retry did the same with both writes landing.
  //
  // Every check was also a read taken milliseconds before the insert. The
  // sharpest was the existing-result check: a result submitted in that window
  // was buried under the walkover, which is precisely what that check exists to
  // prevent. 00184 takes the challenge row FOR UPDATE and does the lot inside
  // it, and a partial unique index makes a second pending walkover per
  // challenge not exist at all, whoever asks for it.
  const { data: reported, error: reportError } = await supabase.rpc('report_walkover_atomic', {
    p_challenge_id: input.challenge_id,
    p_forfeit_player_id: input.forfeit_player_id,
    p_walkover_type: input.walkover_type,
    p_notice_hours: input.notice_hours ?? null,
  });
  if (reportError) throw dbError(reportError);
  if (!reported) throw new Error('Could not file this walkover — please try again.');
  if (!reported.ok) throw walkoverReportError(reported);

  // Read back for the notifications only — the decision is already made and
  // committed above, so a failure here costs an email, not correctness.
  const { data: participantRows } = await createServiceRoleClient()
    .from('challenge_participants')
    .select('player_id')
    .eq('challenge_id', input.challenge_id);
  const cps = (participantRows as { player_id: string }[] | null) ?? [];

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
