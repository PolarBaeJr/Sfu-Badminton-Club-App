import { NextResponse } from 'next/server';
import { rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Bug reports and feedback filed from Discord. See 00172.
//
// One endpoint for /bug and /feedback alike, because they differ by a label and
// nothing else. Write-only from the app's side: nothing reads this table yet,
// and triage is a psql session. See the migration header.

// Discord's own option cap is 6000, and the command declares max_length 1000.
// This is the app's own bound, and 00172 has a CHECK below it again — three
// layers because only the innermost survives a caller that is not this route.
const MAX_BODY = 2000;

const KINDS = new Set(['bug', 'feedback', 'tournament_feedback', 'other']);

// Per reporter, per hour. Deliberately generous: this is anti-spam, not an auth
// gate, and somebody working through a genuinely broken page may legitimately
// file three or four reports in a row.
const REPORTS_PER_HOUR = 8;

export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null);

  const kind = str('kind');
  const discordUserId = str('discordUserId');
  const guildId = str('guildId');

  if (!kind || !KINDS.has(kind)) {
    return NextResponse.json({ error: 'bad_kind' }, { status: 400 });
  }

  // KEYED ON THE REPORTER, NOT ON THE IP — and this is the whole point rather
  // than a detail. Every request to this route arrives from the bot, so one
  // process, so ONE IP. An IP key would put the entire club in a single bucket
  // and the first member to file three reports would lock out everybody else.
  //
  // A caller with no discord user id gets a shared bucket, which is the correct
  // conservative fallback: it can only ever be the bot failing to pass one
  // through, never a real member.
  //
  // The limiter is in-memory and per-process, so with two player replicas the
  // effective allowance is double this. That is fine for anti-spam and would
  // NOT be fine for an auth gate; it is the reason this route does not lean on
  // the limiter for anything but volume.
  const limited = rateLimit(
    `discord:feedback:${discordUserId ?? 'anonymous'}`,
    REPORTS_PER_HOUR,
    3600_000
  );
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  // Control characters stripped, not because they break the database but
  // because a report is read by a human in a terminal, and an embedded escape
  // sequence in a psql result is somebody else's afternoon. Whitespace is
  // collapsed at the ends only — internal line breaks are how people write a
  // reproduction, and flattening them would destroy the most useful reports.
  const text = (str('body') ?? '')
    .replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : ' '))
    .trim()
    .slice(0, MAX_BODY);

  if (!text) {
    return NextResponse.json({ error: 'empty_body' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // BEST EFFORT, AND A FAILURE HERE MUST NOT LOSE THE REPORT. An unlinked
  // member is exactly the person most likely to have hit an onboarding bug, and
  // a link lookup that errors is not a reason to throw their words away — the
  // row still carries discord_user_id, so it can be attributed by hand later.
  let playerId: string | null = null;
  if (discordUserId) {
    const { data, error } = await supabase
      .from('player_discord_links')
      .select('player_id')
      .eq('discord_user_id', discordUserId)
      .maybeSingle();

    if (error) {
      console.error('[discord] feedback link lookup failed:', error.message);
    } else {
      playerId = (data as { player_id: string } | null)?.player_id ?? null;
    }
  }

  const { error } = await supabase.from('feedback_reports').insert({
    kind,
    body: text,
    player_id: playerId,
    discord_user_id: discordUserId,
    guild_id: guildId,
    source: 'discord',
  });

  if (error) {
    // NAMED AND 503, never a cheerful ok. The bot's reply is the only receipt
    // the reporter gets, so telling them it was filed when it was not is worse
    // than telling them to try again.
    console.error('[discord] feedback insert failed:', error.message);
    return NextResponse.json({ error: 'insert_failed' }, { status: 503 });
  }

  // `linked` so the bot can tell an unlinked reporter that a reply may not
  // reach them. Never the row id: it is of no use in Discord and it is one more
  // thing to leak.
  return NextResponse.json({ ok: true, linked: playerId !== null });
}
