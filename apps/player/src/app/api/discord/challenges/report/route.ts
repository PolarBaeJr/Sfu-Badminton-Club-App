import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import { isExpectedFailure, matchResultSchema } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import { resolveDiscordPlayer, type PlayRefusal } from '@/lib/discord-member';
import { submitMatchResultCore } from '@/lib/challenges-core';

export const dynamic = 'force-dynamic';

// /challenge report: the caller reports the result of an accepted challenge.
//
// A REPORT IS NEVER A CONFIRMATION. It lands exactly as a web report does, as
// pending_confirmation, and the other side confirms or disputes on the web.
// Nothing on this surface can confirm a result.
//
// The caller is the Discord id the bot read off the interaction, resolved
// through player_discord_links (discord-member.ts), and the body is
// submitMatchResultCore, which the web action calls too. The RPC is
// submit_match_result_for with that player as p_actor, the service-role twin of
// submit_match_result (00280), and it carries the duration the web does not ask
// for yet.
//
// THE SCORE ARRIVES AS THE CALLER SAW IT, their side first, because that is
// how somebody types a score. It is turned into side a and side b here, from
// the caller's team_side, and the winner is derived from the games rather than
// asked for.

type Refusal = PlayRefusal | 'not_participant' | 'not_accepted' | 'invalid_score' | 'invalid_duration' | 'rule';

function refuse(refusal: Refusal, message?: string) {
  return NextResponse.json({ ok: false, refusal, ...(message ? { message } : {}) });
}

const SNOWFLAKE = /^\d{5,25}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_DURATION = 1;
const MAX_DURATION = 300;

type ReportedGame = { mine: number; theirs: number };

function isReportedGames(value: unknown): value is ReportedGame[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (game) =>
        typeof game === 'object' &&
        game !== null &&
        Number.isInteger((game as ReportedGame).mine) &&
        Number.isInteger((game as ReportedGame).theirs)
    )
  );
}

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const discordUserId = typeof payload.discordUserId === 'string' ? payload.discordUserId.trim() : '';
  const challengeId = typeof payload.challengeId === 'string' ? payload.challengeId.trim() : '';
  const durationMinutes = payload.durationMinutes;

  if (!SNOWFLAKE.test(discordUserId)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  // A challenge id the picker did not offer (typed by hand, or stale) reads
  // as "not one of yours", the same answer a real stranger's id gets.
  if (!UUID.test(challengeId)) return refuse('not_participant');
  if (
    typeof durationMinutes !== 'number' ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < MIN_DURATION ||
    durationMinutes > MAX_DURATION
  ) {
    return refuse('invalid_duration');
  }
  if (!isReportedGames(payload.games)) return refuse('invalid_score', 'Enter at least one game score.');
  const reported = payload.games;

  const supabase = createServiceRoleClient();
  const caller = await resolveDiscordPlayer(supabase, discordUserId);
  if (!caller.ok) {
    if (caller.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return refuse(caller.refusal);
  }
  const player = caller.player;

  // Read for the caller's side, and to answer the two common mistakes with a
  // code before the shared body reads it again and enforces the same rules.
  const { data: challenge, error: challengeError } = await supabase
    .from('challenges')
    .select('id, status, challenge_participants(player_id, team_side, player:players(full_name))')
    .eq('id', challengeId)
    .maybeSingle();
  if (challengeError) {
    console.error('[discord] report challenge read failed:', challengeError.message);
    return NextResponse.json({ error: 'challenge_unavailable' }, { status: 503 });
  }
  const participants = ((challenge?.challenge_participants ?? []) as unknown) as {
    player_id: string;
    team_side: 'a' | 'b';
    player: { full_name: string | null } | null;
  }[];
  const mine = participants.find((cp) => cp.player_id === player.id);
  if (!challenge || !mine) return refuse('not_participant');
  if (challenge.status !== 'accepted') return refuse('not_accepted');

  const games = reported.map((game, index) => ({
    game_number: index + 1,
    side_a_score: mine.team_side === 'a' ? game.mine : game.theirs,
    side_b_score: mine.team_side === 'a' ? game.theirs : game.mine,
  }));
  const sideAWins = games.filter((game) => game.side_a_score > game.side_b_score).length;
  const sideBWins = games.filter((game) => game.side_b_score > game.side_a_score).length;
  const parsed = matchResultSchema.safeParse({
    winner_side: sideAWins > sideBWins ? 'a' : 'b',
    games,
    completed: true,
  });
  if (!parsed.success) {
    return refuse('invalid_score', parsed.error.issues[0]?.message ?? 'That score is not valid.');
  }

  let matchId: string;
  try {
    ({ matchId } = await submitMatchResultCore(supabase, player, challengeId, parsed.data, (params) =>
      supabase.rpc('submit_match_result_for', {
        p_actor: player.id,
        ...params,
        p_duration_minutes: durationMinutes,
      }),
    ));
  } catch (err) {
    if (isExpectedFailure(err)) return refuse('rule', (err as Error).message);
    throw err;
  }

  try {
    revalidatePath('/challenges');
    revalidatePath(`/challenges/${challengeId}`);
  } catch (err) {
    Sentry.captureException(err, { extra: { step: 'discord-report-revalidate', challengeId } });
  }

  const opponents = participants
    .filter((cp) => cp.team_side !== mine.team_side)
    .map((cp) => cp.player?.full_name ?? 'Your opponent')
    .join(' & ');
  return NextResponse.json({ ok: true, matchId, opponents });
}
