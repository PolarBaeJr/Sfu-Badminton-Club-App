import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Confirmed match results, relayed to a Discord channel. See 00171.
//
// WHAT GOES OUT: who played, the score, who won. No rating delta, no post
// rating — this route does not select those columns at all, so there is no
// field for a later edit to leak by accident. Members read their own numbers
// from /my-stats, which answers ephemerally, to the person they are about.
//
// ============================================================================
// WHY THIS ROUTE IS SHAPED DIFFERENTLY FROM /announcements AND /tournament-events
// ============================================================================
//
// Both of those carry two heavy pieces of machinery: an orphan sweep (a mapping
// whose source row no longer resolves means the source was deleted, so retract)
// and a liveness guard (…unless the whole table reads as empty, in which case
// refuse, because a silently failed read is indistinguishable from a mass
// delete and would wipe the channel).
//
// NEITHER BELONGS HERE, and copying them in would make this route worse.
//
// A confirmed match is never hard-deleted. The only .delete() on matches is
// discardIncompleteMatch, scoped `.eq('result_status', expectedStatus)` where
// expectedStatus is never 'confirmed'. Every real retraction is an UPDATE —
// voidMatch, convertMatchToCasual, dispute_match_result — and every one bumps
// updated_at, which is the column this route's window is keyed on. So anything
// needing to come down re-enters the window by itself, and ABSENCE FROM THE
// WINDOW CAN ONLY MEAN "NOT TOUCHED LATELY", i.e. unchanged.
//
// That single fact settles both:
//
//   * No sweep. There is nothing for it to find, and it would be dangerous:
//     it would read absence as deletion and start retracting live results.
//   * No liveness guard. A silently empty read here means "nothing was touched",
//     the route does nothing, and every post stays up. The failure direction is
//     already the safe one. A guard whose rationale does not apply is worse
//     than none, because the next reader trusts it.
//
// It also settles the read cap below, which is a paging bound rather than a
// safety property — truncating the window can only mean a match is not posted
// or not retracted, never that a live one is torn down. What the cap must NOT
// do is truncate by the wrong key; see MAX_WINDOW.
//
// IF AN ADMIN "DELETE MATCH" ACTION IS EVER ADDED that can reach a confirmed
// row, all of the above collapses and this route needs both pieces back before
// that action ships.

// Rows pulled per tick, and the ONLY cap in this route — the mapping read below
// is aimed at exactly these ids, so retraction reach is the window, never a
// separate bound that the window can outrun.
//
// ORDERED BY updated_at, THE SAME COLUMN THE WINDOW FILTERS ON. Ordering by
// played_at instead looks harmless and is not: a match played in April and
// voided this morning has a fresh updated_at (so it belongs in the window) and
// an old played_at (so it sorts last), and a busy club night would push it past
// the cap. It would then be absent from the window, which this route reads as
// "unchanged", and its message would stay up forever — the exact retraction the
// design exists to deliver. Sorting by updated_at means truncation can only
// drop the rows that changed LEAST recently, which is the only safe thing to
// drop.
//
// 150 rather than a rounder number: the mapping read spells these ids into an
// `.in(...)`, and 150 uuids is ~5.7KB of URL, comfortably inside the ~8KB the
// proxy will carry. The other two relays cap at 150 for the same reason.
const MAX_WINDOW = 150;

// How far back a match stays eligible. Long enough that a result confirmed on
// Sunday night still posts if the bot was down for the weekend, short enough
// that turning the relay on does not dump a month of history into the channel
// at once.
const LOOKBACK_HOURS = 72;

// score_summary is TEXT with no constraint and a human types it. Capped and
// stripped rather than trusted: this is the one field here that is free text.
const MAX_SCORE = 120;

// Which matches are the club's business to broadcast.
//
// 'casual' is excluded on purpose — a club night of doubles rotations would
// turn the channel into a firehose — and so is 'trial'.
//
// 'tournament' is on the enum and is NOT here because NOTHING WRITES IT.
// matches.event_type is inherited from challenges.event_type, which is only
// ever 'rated_challenge' or 'casual', plus 'admin_entered' from
// adminCreateMatch. Tournament results live in tournament_matches and never
// become matches rows. Adding it would relay exactly nothing.
const RELAYABLE_EVENT_TYPES = new Set(['rated_challenge', 'admin_entered']);

interface ParticipantRow {
  team_side: string;
  win_flag: boolean | null;
  player: {
    id: string;
    full_name: string | null;
    handle: string | null;
    hide_from_leaderboard: boolean | null;
  } | null;
}

interface MatchRow {
  id: string;
  played_at: string | null;
  match_type: string;
  format: string;
  score_summary: string | null;
  winner_side: string | null;
  result_status: string;
  event_type: string;
  match_participants: ParticipantRow[] | null;
}

interface MappingRow {
  match_id: string;
  channel_id: string;
  discord_message_id: string;
  synced_summary: string;
}

export interface MatchResultAction {
  kind: 'post' | 'edit' | 'retract';
  matchId: string;
  channelId: string;
  discordMessageId: string | null;
  /** Rendered line. Doubles as the change-detection key stored in the mapping. */
  summary: string;
  /** Structured pieces, so the bot can build an embed without re-parsing. */
  teamA: string;
  teamB: string;
  score: string;
  winner: 'a' | 'b' | null;
  matchType: string;
  playedAt: string | null;
}

/** Free text on its way into a channel message. */
function cleanScore(raw: string | null): string {
  return (
    (raw ?? '')
      // Control characters and newlines: a multi-line score would break the
      // single-line render and is never what the field means.
      .replace(/\p{Cc}+/gu, ' ')
      // Markdown and mention syntax. The bot also sends
      // allowed_mentions:{parse:[]} and puts this in an embed rather than
      // content, so this is the third independent layer — but a backtick or an
      // underscore still garbles the render even when it cannot ping anybody.
      .replace(/[`*_~|@<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SCORE)
  );
}

function displayName(p: ParticipantRow): string {
  const player = p.player;
  return player?.full_name?.trim() || player?.handle?.trim() || 'Unknown player';
}

/**
 * Names on one side, in a stable order.
 *
 * GROUPED BY team_side RATHER THAN ASSUMING TWO ROWS. A doubles match has four
 * participants and singles-shaped code would silently render it as one name per
 * side, dropping two members from a result they played in.
 *
 * Sorted, so an unstable row order from PostgREST does not read as a changed
 * roster and trigger a pointless edit on every tick.
 */
function sideNames(participants: ParticipantRow[], side: string): string {
  return participants
    .filter((p) => p.team_side === side)
    .map(displayName)
    .sort((a, b) => a.localeCompare(b))
    .join(' & ');
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });

  const supabase = createServiceRoleClient();

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

  // ONE WINDOWED READ, and the mapping read after it is aimed at what this one
  // returned. The other relays add a second by-id read over the mapped set,
  // because their retractable rows can sit outside the fresh window. Here they
  // cannot: every retraction is an UPDATE that bumps updated_at, so a match that
  // needs taking down is in this window by definition.
  //
  // DELIBERATELY UNFILTERED ON result_status AND event_type. Both are filtered
  // in TypeScript below instead, and that is the whole trick: if the query
  // carried `.eq('result_status','confirmed')` then voiding a match would make
  // its row VANISH from the read, leaving the mapping with no signal and the
  // message up forever. Same for event_type and convertMatchToCasual, which
  // rewrites it to 'casual'. The query filters only on columns that are stable
  // once a result exists — played_at is never nulled, updated_at only moves
  // forward.
  //
  // rating_delta and post_rating are NOT selected. See the header.
  const [settingsResult, windowResult] = await Promise.all([
    supabase.from('discord_settings').select('key, value'),
    supabase
      .from('matches')
      .select(
        'id, played_at, match_type, format, score_summary, winner_side, result_status, event_type, ' +
          'match_participants(team_side, win_flag, ' +
          'player:players(id, full_name, handle, hide_from_leaderboard))'
      )
      .not('played_at', 'is', null)
      .gte('updated_at', since)
      .order('updated_at', { ascending: false })
      .limit(MAX_WINDOW),
  ]);

  if (settingsResult.error) {
    console.error('[discord] match results config read failed:', settingsResult.error.message);
    return NextResponse.json(
      { error: 'config_unavailable', detail: settingsResult.error.message },
      { status: 503 }
    );
  }

  if (windowResult.error) {
    console.error('[discord] match results read failed:', windowResult.error.message);
    return NextResponse.json(
      { error: 'matches_unavailable', detail: windowResult.error.message },
      { status: 503 }
    );
  }

  const settings = new Map(
    ((settingsResult.data ?? []) as { key: string; value: string }[]).map((s) => [s.key, s.value])
  );
  const channelId = settings.get('match_results_channel_id')?.trim() || null;

  // `as unknown` first, because the generated client cannot type a two-level
  // embed (matches -> match_participants -> players) and falls back to
  // GenericStringError[], which does not overlap MatchRow. The shape is
  // asserted by the select string directly above and by the route tests.
  const rows = (windowResult.data ?? []) as unknown as MatchRow[];

  // NOTHING CHANGED, SO NOTHING IS DUE — not "nothing exists". This is where a
  // liveness guard would go and why one is not needed: an empty window, whether
  // it is genuinely quiet or a silently failed read, means every posted message
  // stays exactly where it is. It also spares the mapping read below.
  if (rows.length === 0) {
    return NextResponse.json({ actions: [], skipped: [] });
  }

  // AIMED AT THE WINDOW, not at the guild's whole history. A blanket read with
  // its own limit would bound retraction separately from the window: once more
  // mappings existed than that limit, a match posted last term and voided today
  // would enter the window, find no mapping, and be classified a skip instead of
  // a retract — message still up. Reading exactly the ids in hand makes the two
  // reaches the same by construction, and a mapping outside the window is one
  // whose match is unchanged, which needs nothing done to it.
  const mappedResult = await supabase
    .from('discord_match_posts')
    .select('match_id, channel_id, discord_message_id, synced_summary')
    .eq('guild_id', guildId)
    .in(
      'match_id',
      rows.map((r) => r.id)
    );

  // NAMED, never degraded to an empty list. A failed PostgREST read comes back
  // as data:null with an error rather than throwing, and an empty mapping list
  // means "nothing relayed yet" — which would post a SECOND copy of every result
  // that already has one, on every tick, until the read recovered.
  if (mappedResult.error) {
    console.error('[discord] match results mapping read failed:', mappedResult.error.message);
    return NextResponse.json(
      { error: 'config_unavailable', detail: mappedResult.error.message },
      { status: 503 }
    );
  }

  const mapped = new Map(((mappedResult.data ?? []) as MappingRow[]).map((m) => [m.match_id, m]));

  const actions: MatchResultAction[] = [];
  const skipped: { matchId: string; reason: string }[] = [];

  for (const m of rows) {
    const mapping = mapped.get(m.id);
    const participants = m.match_participants ?? [];

    // A mapped match failing ANY of these is a RETRACTION, not a skip: it was
    // postable when it went out and is not now.
    let reason: string | null = null;

    if (m.result_status !== 'confirmed') {
      // pending_confirmation, disputed, voided, walkover. A walkover in
      // particular names who forfeited, which is not channel material.
      reason = `result_status is ${m.result_status}`;
    } else if (!RELAYABLE_EVENT_TYPES.has(m.event_type)) {
      reason = `event_type ${m.event_type} is not relayed`;
    } else if (m.winner_side !== 'a' && m.winner_side !== 'b') {
      reason = 'no winner_side';
    } else if (participants.length === 0) {
      // A confirmed match with no readable participants is a broken join, not
      // an empty match. Posting "def." with no names is worse than waiting for
      // the next tick.
      reason = 'no participants';
    } else if (participants.some((p) => p.player?.hide_from_leaderboard)) {
      // ANY participant opted out and the WHOLE match is held back — not
      // "posted with that name redacted", which in a two-player match
      // identifies the opt-out by elimination.
      //
      // THIS IS A PRE-PUBLICATION FILTER, NOT A TAKEDOWN. The flag lives on
      // players, so flipping it does not bump matches.updated_at and cannot
      // bring an already-posted result back into this window. A member who
      // opts out today does not have last month's posts pulled down; the
      // remedy for that is deleting the message in Discord by hand, which is
      // permanent because this route only ever posts a match with no mapping.
      reason = 'a participant is hidden from public ranking';
    }

    if (reason) {
      if (mapping) {
        actions.push({
          kind: 'retract',
          matchId: m.id,
          channelId: mapping.channel_id,
          discordMessageId: mapping.discord_message_id,
          summary: mapping.synced_summary,
          teamA: '',
          teamB: '',
          score: '',
          winner: null,
          matchType: m.match_type,
          playedAt: m.played_at,
        });
      } else {
        skipped.push({ matchId: m.id, reason });
      }
      continue;
    }

    const winner = m.winner_side as 'a' | 'b';
    const teamA = sideNames(participants, 'a');
    const teamB = sideNames(participants, 'b');
    const score = cleanScore(m.score_summary);

    const winners = winner === 'a' ? teamA : teamB;
    const losers = winner === 'a' ? teamB : teamA;
    const summary = `${winners} def. ${losers}${score ? ` — ${score}` : ''}`;

    if (!mapping) {
      // Nothing to post to. Not an error: the relay is off until the club sets
      // a channel, and the mapped ones above still had somewhere to go.
      if (!channelId) {
        skipped.push({ matchId: m.id, reason: 'no results channel configured' });
        continue;
      }
      actions.push({
        kind: 'post',
        matchId: m.id,
        channelId,
        discordMessageId: null,
        summary,
        teamA,
        teamB,
        score,
        winner,
        matchType: m.match_type,
        playedAt: m.played_at,
      });
      continue;
    }

    // The rendered line rather than score_summary alone, because the roster is
    // part of what can change: a doubles match whose participants were fixed
    // afterwards has the same score and a different message.
    if (mapping.synced_summary !== summary) {
      actions.push({
        kind: 'edit',
        matchId: m.id,
        channelId: mapping.channel_id,
        discordMessageId: mapping.discord_message_id,
        summary,
        teamA,
        teamB,
        score,
        winner,
        matchType: m.match_type,
        playedAt: m.played_at,
      });
    }
  }

  // MAPPED MATCHES ABSENT FROM THE WINDOW ARE LEFT ALONE, DELIBERATELY. This is
  // where the other two relays run their orphan sweep. Here absence means the
  // match has not been touched since `since`, which means it is unchanged, which
  // means its message is still correct. See the header.

  return NextResponse.json({
    actions,
    skipped,
    // Reported rather than silent: a club night that produced more results than
    // one tick can carry should say so, not look like it relayed everything.
    ...(rows.length >= MAX_WINDOW ? { windowCapReached: MAX_WINDOW } : {}),
  });
}

// Record a message Discord has ALREADY accepted. Never called beforehand: a
// mapping written first, for a post that then fails, is a result the relay
// believes it published and never will.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null);
  const matchId = str('matchId');
  const guildId = str('guildId');
  const channelId = str('channelId');
  const discordMessageId = str('discordMessageId');
  // Required and non-empty, unlike the announcement body it mirrors. A summary
  // always has at least two names and the word "def." in it, so an empty one
  // means the caller lost it — and storing '' would make every subsequent tick
  // see a difference and edit the same message forever.
  const summary = str('summary');

  if (!matchId || !guildId || !channelId || !discordMessageId || !summary) {
    return NextResponse.json({ error: 'incomplete_mapping' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_match_posts')
    .upsert(
      {
        match_id: matchId,
        guild_id: guildId,
        channel_id: channelId,
        discord_message_id: discordMessageId,
        synced_summary: summary,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'match_id,guild_id' }
    );

  if (error) {
    // A post that landed but did not record leaves a result in a channel
    // members read with no mapping, and the next tick posts a SECOND copy.
    console.error('[discord] match result record failed:', error.message);
    return NextResponse.json({ error: 'record_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}

// Forget a mapping, after the Discord message is gone.
export async function DELETE(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const params = new URL(request.url).searchParams;
  const matchId = params.get('matchId');
  const guildId = params.get('guildId');
  if (!matchId || !guildId) {
    return NextResponse.json({ error: 'match_and_guild_required' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_match_posts')
    .delete()
    .eq('match_id', matchId)
    .eq('guild_id', guildId);

  if (error) {
    console.error('[discord] match mapping delete failed:', error.message);
    return NextResponse.json({ error: 'delete_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
