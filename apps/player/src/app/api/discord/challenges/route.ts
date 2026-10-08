import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import { challengeCreateSchema, describeMatchShape, isExpectedFailure } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';
import {
  resolveDiscordMember,
  resolveDiscordPlayer,
  resolveLinkedPlayerIds,
  type PlayRefusal,
} from '@/lib/discord-member';
import { createChallengeCore } from '@/lib/challenges-core';

export const dynamic = 'force-dynamic';

// /challenge send, and the picker behind /challenge report.
//
// THE CALLER IS THE ACTOR, and the caller is the Discord id the bot read off
// the interaction, resolved through player_discord_links. Nothing in the body
// names a club player: the opponent and partners arrive as Discord ids and are
// resolved through the same table, so a body carrying a player id (a creator,
// say) is ignored rather than trusted.
//
// THE SAME RULES AS THE WEB, through the same code. The standing, feature and
// waiver checks are the ones requirePlayer, assertFeatureOn and
// assertCurrentWaiver run (discord-member.ts), and the body is
// createChallengeCore, which the web action calls too. The one difference is
// the RPC: create_challenge_for with the resolved player as p_creator, the
// service-role twin of create_challenge_atomic (00280).
//
// NOBODY IS PINGED IN A CHANNEL. The opponent hears about it the way a web
// challenge reaches them (in-app, push, email), and the bot's reply is
// ephemeral.
//
// A REFUSAL IS A 200 WITH A CODE, for the reason the announce route gives: the
// app was reached and answered a specific no. 'rule' is the one code that
// carries a sentence, because it is the club's own rule refusing (too many
// open challenges, same opponent too soon) and the sentence is the app's own.

type Refusal =
  | PlayRefusal
  | 'opponent_not_linked'
  | 'partner_not_linked'
  | 'opponent_partner_not_linked'
  | 'invalid'
  | 'rule';

function refuse(refusal: Refusal, message?: string) {
  return NextResponse.json({ ok: false, refusal, ...(message ? { message } : {}) });
}

const SNOWFLAKE = /^\d{5,25}$/;
const MAX_CHOICES = 25;

// The four presets the web form offers by name. Any other shape is sent the
// way the web sends a custom one: the enum as the fallback, the columns set.
const PRESETS: Record<string, 'bo3_21' | 'single_21' | 'single_15' | 'single_11'> = {
  '3:21': 'bo3_21',
  '1:21': 'single_21',
  '1:15': 'single_15',
  '1:11': 'single_11',
};

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string).trim() : '');
  const int = (key: string, fallback: number) =>
    typeof payload[key] === 'number' && Number.isInteger(payload[key]) ? (payload[key] as number) : fallback;

  const discordUserId = str('discordUserId');
  const opponentDiscordId = str('opponentDiscordId');
  const partnerDiscordId = str('partnerDiscordId');
  const opponentPartnerDiscordId = str('opponentPartnerDiscordId');
  const type = str('type') === 'doubles' ? 'doubles' : 'singles';
  // The web form starts with Rated ticked, so an absent answer is rated.
  const rated = payload.rated !== false;
  const bestOf = int('bestOf', 3);
  const points = int('points', 21);
  const note = str('note');

  if (!SNOWFLAKE.test(discordUserId) || !SNOWFLAKE.test(opponentDiscordId)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  if (type === 'doubles' && (!SNOWFLAKE.test(partnerDiscordId) || !SNOWFLAKE.test(opponentPartnerDiscordId))) {
    return refuse('invalid', 'A doubles challenge needs your partner and the opponent\'s partner.');
  }
  if (type === 'singles' && (partnerDiscordId || opponentPartnerDiscordId)) {
    return refuse('invalid', 'A singles challenge takes no partners. Pick doubles to add them.');
  }

  const supabase = createServiceRoleClient();
  const caller = await resolveDiscordPlayer(supabase, discordUserId);
  if (!caller.ok) {
    if (caller.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return refuse(caller.refusal);
  }
  const player = caller.player;

  const named = type === 'doubles'
    ? [opponentDiscordId, partnerDiscordId, opponentPartnerDiscordId]
    : [opponentDiscordId];
  const linked = await resolveLinkedPlayerIds(supabase, named);
  if (linked === 'unavailable') {
    return NextResponse.json({ error: 'players_unavailable' }, { status: 503 });
  }
  const opponentId = linked.get(opponentDiscordId);
  if (!opponentId) return refuse('opponent_not_linked');
  const partnerId = type === 'doubles' ? linked.get(partnerDiscordId) : undefined;
  const opponentPartnerId = type === 'doubles' ? linked.get(opponentPartnerDiscordId) : undefined;
  if (type === 'doubles' && !partnerId) return refuse('partner_not_linked');
  if (type === 'doubles' && !opponentPartnerId) return refuse('opponent_partner_not_linked');

  const preset = PRESETS[`${bestOf}:${points}`];
  const input = {
    type,
    rated_flag: rated,
    event_type: rated ? 'rated_challenge' : 'casual',
    format: preset ?? (bestOf > 1 ? 'bo3_21' : 'single_21'),
    ...(preset ? {} : { games_per_match: bestOf, points_per_game: points }),
    opponent_id: opponentId,
    partner_id: partnerId,
    opponent_partner_id: opponentPartnerId,
    note: note || undefined,
  };
  const parsed = challengeCreateSchema.safeParse(input);
  if (!parsed.success) {
    return refuse('invalid', parsed.error.issues[0]?.message ?? 'That challenge is not valid.');
  }

  let challengeId: string;
  try {
    challengeId = await createChallengeCore(player, parsed.data, (params) =>
      supabase.rpc('create_challenge_for', { p_creator: player.id, ...params }),
    );
  } catch (err) {
    if (isExpectedFailure(err)) return refuse('rule', (err as Error).message);
    throw err;
  }

  try {
    revalidatePath('/challenges');
    revalidatePath('/feed');
  } catch (err) {
    Sentry.captureException(err, { extra: { step: 'discord-challenge-revalidate', challengeId } });
  }

  return NextResponse.json({ ok: true, challengeId });
}

type OpenChallengeRow = {
  id: string;
  created_at: string;
  scheduled_date: string | null;
  format: string;
  games_per_match: number | null;
  points_per_game: number | null;
  matches: { id: string } | { id: string }[] | null;
  challenge_participants: {
    player_id: string;
    team_side: 'a' | 'b';
    player: { full_name: string | null } | null;
  }[];
};

/**
 * The caller's accepted challenges with no result yet, for the /challenge
 * report picker. A refusal answers an empty list, never an error: the picker
 * has nowhere to show one.
 */
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const discordUserId = request.headers.get('x-discord-user-id') ?? '';
  if (!SNOWFLAKE.test(discordUserId)) return NextResponse.json({ challenges: [] });

  // The link alone, not the whole play gate: this lists the caller's own
  // challenges and writes nothing, and it runs on every keystroke inside a
  // one-second budget. The report it feeds runs the full gate.
  const supabase = createServiceRoleClient();
  const caller = await resolveDiscordMember(supabase, discordUserId);
  if (!caller.ok) {
    if (caller.refusal === 'unavailable') {
      return NextResponse.json({ error: 'caller_unavailable' }, { status: 503 });
    }
    return NextResponse.json({ challenges: [] });
  }

  // `mine` is the same relation embedded a second time, as the filter: it
  // narrows the challenges to the caller's while the unfiltered embed keeps
  // every participant, which is what names the opponent.
  const { data, error } = await supabase
    .from('challenges')
    .select(
      'id, created_at, scheduled_date, format, games_per_match, points_per_game, matches(id), ' +
        'mine:challenge_participants!inner(player_id), ' +
        'challenge_participants(player_id, team_side, player:players(full_name))'
    )
    .eq('status', 'accepted')
    .eq('mine.player_id', caller.player.id)
    .order('created_at', { ascending: false })
    .limit(MAX_CHOICES);

  if (error) {
    console.error('[discord] open challenges read failed:', error.message);
    return NextResponse.json({ error: 'challenges_unavailable' }, { status: 503 });
  }

  const rows = (data ?? []) as unknown as OpenChallengeRow[];
  const challenges = rows
    // A challenge stays 'accepted' until its result is confirmed, so one with a
    // match row already has a report waiting on the other side.
    .filter((row) => (Array.isArray(row.matches) ? row.matches.length === 0 : !row.matches))
    .map((row) => {
      const mySide = row.challenge_participants.find((cp) => cp.player_id === caller.player.id)?.team_side;
      const opponents = row.challenge_participants
        .filter((cp) => cp.team_side !== mySide)
        .map((cp) => cp.player?.full_name ?? 'a member')
        .join(' & ');
      const date = row.scheduled_date ?? row.created_at.slice(0, 10);
      const shape = describeMatchShape({
        match_format: row.format,
        games_per_match: row.games_per_match,
        points_per_game: row.points_per_game,
      });
      return { id: row.id, label: `vs ${opponents} - ${date} - ${shape}` };
    });

  return NextResponse.json({ challenges });
}
