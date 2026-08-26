import { NextResponse } from 'next/server';
import { rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Bug reports and feedback filed from Discord. See 00172 and 00173.
//
// One endpoint for /bug and /feedback alike, because they differ by a label and
// nothing else. WRITE-ONLY: the row is inserted here and read back by the relay
// (../feedback-relay), which is a separate route on a separate schedule so a
// Discord outage cannot cost the report. Triage is that channel plus a psql
// session; there is still no admin page.

// Discord's own option cap is 6000, and the command declares max_length 1000.
// This is the app's own bound, and 00172 has a CHECK below it again — three
// layers because only the innermost survives a caller that is not this route.
const MAX_BODY = 2000;

const KINDS = new Set(['bug', 'feedback', 'tournament_feedback', 'other']);

// The modal caps the box at 100 and 00173's CHECK stops at 120. This sits
// between them, so a title from the modal is never trimmed and a title from
// anything else is trimmed here rather than rejected by the constraint — a
// CHECK violation would lose the body along with the over-long title.
const MAX_TITLE = 120;

// The screenshot url, if there was one. Only ever a Discord CDN url, and the
// relay refuses to fetch from anywhere else — but the check belongs here too,
// because a stored url that the relay will never fetch is a column full of
// somebody else's addresses.
const IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function cleanImageUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !IMAGE_HOSTS.has(parsed.hostname)) return null;
    // Signed urls are long; 1024 is well clear of a real one and well short of
    // anything worth storing.
    return parsed.toString().slice(0, 1024);
  } catch {
    return null;
  }
}

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
  // THE LAST IN-APP RATE LIMIT IN THE CODEBASE, and it is keyed on the REPORTER
  // rather than on an IP. That is the whole reason it survived the removal of
  // the other ~43: every request to this route arrives from the single bot
  // process, so the per-path edge limit that replaced them would put the entire
  // club in one bucket and let the first member to file a few reports silence
  // everyone else. The edge cannot express "per Discord user".
  //
  // The limiter is in-memory and per-process, so with two player replicas the
  // effective allowance is double this. That is fine for anti-spam and would
  // NOT be fine for an auth gate; it is the reason this route does not lean on
  // the limiter for anything but volume. See docs/ops/rate-limits.md.
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

  // NO NEWLINES AT ALL, unlike the body. This becomes a Discord embed title,
  // which renders a line break as a space anyway, and a title that wraps in the
  // triage query makes the list unreadable.
  const title =
    (str('title') ?? '')
      .replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, MAX_TITLE) || null;

  const imageUrl = cleanImageUrl(str('imageUrl'));

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
    title,
    body: text,
    image_url: imageUrl,
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
