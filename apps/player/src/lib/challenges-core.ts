// The body of creating a challenge and of reporting a result, shared by the
// web actions and the Discord routes. NOT a 'use server' module: nothing here
// may be reachable as a Server Action, because every function takes the acting
// player as a parameter.
//
// The two doors differ in exactly one thing, how the RPC learns who is acting.
// The web calls the member function with the member's own client, which reads
// the actor from auth.uid(). Discord has no member session, so it calls the
// service-role twin and passes the player it resolved from the linked Discord
// id (00280). Each caller hands its RPC in as `rpc`; the rules, the refusals and
// everything that happens afterwards are written once, here.
//
// The checks that come BEFORE the body (standing, the feature flag, the
// waiver) stay with the callers, since each door resolves its player
// differently. revalidatePath stays with the callers too.
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  sendChallengeReceivedEmail,
  sendResultPendingEmail,
  describeMatchShape,
  ExpectedError,
  dbError,
  getRulesFor,
  validateGamesForRules,
  type ChallengeCreateInput,
  type MatchResultInput,
} from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';
import { getPlayerProps, trackServerEvent, notifyPlayers } from './actions/_shared';

type RpcResult = PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

export type CorePlayer = Record<string, unknown> & { id: string; full_name: string };

export type CreateChallengeParams = {
  p_type: string;
  p_rated_flag: boolean;
  p_format: string;
  p_opponent_id: string;
  p_partner_id: string | null;
  p_opponent_partner_id: string | null;
  p_games_per_match: number | null;
  p_points_per_game: number | null;
  p_session_id: string | null;
  p_scheduled_date: string | null;
  p_scheduled_time: string | null;
  p_note: string | null;
};

export type SubmitResultParams = {
  p_challenge_id: string;
  p_games: { side_a_score: number; side_b_score: number }[];
  p_completed: boolean;
};

export async function createChallengeCore(
  player: CorePlayer,
  input: ChallengeCreateInput,
  rpc: (params: CreateChallengeParams) => RpcResult,
): Promise<string> {
  // ONE STATEMENT, and it is the fix for F-014. This used to be a validate
  // call, an insert of the challenge, and an insert of the participants with a
  // second client: three round trips. A failure at the third left a 'proposed'
  // challenge with NO participants, which nothing can ever accept, reject or
  // cancel (all three look the actor up in the participant list) and which
  // counts against max_active_challenges for good. Three of those and the
  // member cannot challenge anybody again.
  //
  // The cap check moved inside for the same reason: it used to be a read
  // milliseconds before the insert, so two tabs submitted together both passed
  // a cap of 3 at 2. 00183 holds an advisory lock on the creator across both.
  //
  // From the web this is the member's own client, not the service role: 00183
  // takes no player id and resolves the creator from auth.uid(), so there is
  // nothing there to impersonate with (00126). From Discord it is the
  // service-role twin create_challenge_for, which no browser key can reach.
  const { data, error } = await rpc({
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
  const created = data as { valid?: boolean; errors?: string[]; challenge_id?: string } | null;

  // Fail closed: an RPC error or a null result must block creation. Before
  // 00126-era hardening the error was discarded and a falsy validation skipped
  // the guard entirely, letting a caller bypass every check.
  if (error) throw new Error(error.message);
  if (!created) throw new Error('Could not create this challenge. Please try again.');
  if (!created.valid) {
    // The club's own rules saying no (self-challenge, suspended opponent, too
    // many open challenges, same opponent too soon). The rules working is not a
    // fault; only `error` above is.
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
    const formatLabel = describeMatchShape({ match_format: input.format, games_per_match: input.games_per_match, points_per_game: input.points_per_game });
    sendChallengeReceivedEmail(opponent.email, player.full_name, formatLabel, input.type, challengeId).catch((err) => {
      Sentry.captureException(err, { extra: { email: 'challenge_received', challengeId } });
    });
  }

  // Service-role, not the user's client: 00126 revokes EXECUTE on this
  // SECURITY DEFINER function from anon and authenticated. It takes the player
  // id as a parameter and checks nothing internally, so while it was reachable
  // over PostgREST any caller could inflate anyone's reliability counter. The
  // counter is server-derived bookkeeping, never something the browser asks
  // for, so moving the one call site to the trusted key is the fix; the
  // alternative was rewriting a SECURITY DEFINER body, which 00049 warns about.
  // `player.id` is the verified session on the web and the linked member from
  // Discord, never a value the caller typed.
  await createServiceRoleClient().rpc('increment_challenges_issued', { p_player_id: player.id });

  trackServerEvent(player.id, 'challenge_created', {
    ...getPlayerProps(player),
    challenge_id: challengeId,
    challenge_type: input.type,
    format: input.format,
    rated: input.rated_flag,
  });

  return challengeId;
}

export async function submitMatchResultCore(
  client: SupabaseClient,
  player: CorePlayer,
  challengeId: string,
  input: MatchResultInput,
  rpc: (params: SubmitResultParams) => RpcResult,
): Promise<{ matchId: string; format: string }> {
  // No players embed: 00032 revoked blanket SELECT on players and granted a
  // safe column subset, so `players(*)` is refused outright, and because the
  // error used to be discarded, that surfaced as "Challenge not found" on a
  // challenge that plainly existed. Nothing below this ever read the embedded
  // player or its ratings; submit_match_result derives participants itself.
  const { data: challenge, error: challengeError } = await client
    .from('challenges')
    .select('id, status, format, games_per_match, points_per_game, challenge_participants(player_id)')
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

  // The DB still decides (00236), but judged here against the challenge's own
  // target and best-of, a bad score reads as a sentence, not a raw RAISE.
  const check = validateGamesForRules(
    input.games,
    getRulesFor(challenge.format, challenge.games_per_match, challenge.points_per_game),
  );
  if (!check.ok) throw new ExpectedError(check.message);

  // One RPC replaces what used to be three separate writes (match ->
  // participants -> games). Those were non-atomic: a crash between the match
  // insert and the compensating delete wedged the challenge permanently, since
  // matches_challenge_id_unique blocks any resubmit. Just as importantly, the
  // participant rows used to be built client-side, so a submitter could enrol
  // any player they liked; the function derives them from challenge_participants
  // instead. `authenticated` no longer holds INSERT on these tables (00027), so
  // this is also the only way in.
  const { data: newMatchId, error: submitError } = await rpc({
    p_challenge_id: challengeId,
    p_games: input.games.map((g) => ({ side_a_score: g.side_a_score, side_b_score: g.side_b_score })),
    p_completed: input.completed,
  });
  if (submitError) throw dbError(submitError);
  const matchId = newMatchId as string;

  // Notify other participants: batch insert + parallel email lookup.
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

  return { matchId, format: challenge.format as string };
}
