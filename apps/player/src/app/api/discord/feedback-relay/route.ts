import { NextResponse } from 'next/server';
import { getClientIp, rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { getServerSupabaseUrl } from '@badminton/shared';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Feedback, relayed to the channels the execs read. See 00173.
//
// TWO SOURCES, ONE RELAY, TWO CHANNELS:
//
//   report          feedback_reports — /bug and /feedback filed in Discord.
//                   Goes to feedback_channel_id.
//   event_feedback  the star rating and comment on a tournament page.
//                   Goes to event_feedback_channel_id.
//
// ============================================================================
// WHY THE TWO CHANNEL SETTINGS ARE SEPARATE AND NEITHER DEFAULTS TO THE OTHER
// ============================================================================
//
// The tournament feedback form tells the member, on screen, that the exec team
// is who sees their comment. It is a named survey response and people write
// things in it they would not post in a channel.
//
// A single setting would mean somebody configuring "where do bug reports go"
// silently also decides "where do survey responses go", and one wrong channel
// id turns a private comment into a public post naming its author, with no
// takedown path. Two keys make the second one a decision somebody had to make
// on purpose. Pointing both at the same private channel is the expected
// configuration; what is prevented is inheriting one from the other.
//
// ============================================================================
// WHY event_feedback CARRIES A SWEEP AND feedback_reports DOES NOT
// ============================================================================
//
// event_feedback IS HARD-DELETED — not on its own, but deleteTournament
// (apps/admin/src/lib/actions/tournaments.ts) removes the tournament row and
// event_feedback cascades with it. A deleted tournament has to take its
// feedback posts down, so that source gets the orphan sweep from 00169/00170
// AND 00170's liveness guard: a mapping whose row is absent is retracted only
// on positive evidence that event_feedback reads at all. An empty read is not
// that evidence — this codebase has had three silent empty reads (a missing
// SELECT grant, a stale PostgREST cache), and treating one as a mass delete
// would wipe the channel in a single tick.
//
// NOTHING DELETES FROM feedback_reports. player_id is ON DELETE SET NULL by
// 00172's design precisely so a report outlives its reporter. So that half has
// no sweep, and adding one would be dangerous rather than thorough: it would
// read "outside the window" as "deleted" and retract live reports. If a delete
// path is ever added, this route needs a sweep for it before that ships.
// ============================================================================

// Rows pulled per tick, per source. Ordered by the SAME column the window
// filters on — see the match relay's MAX_WINDOW note for what ordering by
// anything else costs. 150 uuids is ~5.7KB of URL in the `.in(...)` below,
// comfortably inside what the proxy will carry.
const MAX_WINDOW = 150;

// The cap on mappings read back per tick, and here it is a SAFETY bound, not a
// paging one: the sweep treats a mapped row that does not come back as deleted,
// so a truncated mapping read would look like a mass deletion. Keeping it well
// under PGRST_DB_MAX_ROWS (1000, see 00152) makes the second read unable to
// truncate, because it can never be asked for more ids than this.
const MAX_MAPPED = 150;

// How far back a row stays eligible. Long enough that a report filed on Friday
// still posts if the bot was down for the weekend, short enough that turning
// the relay on does not dump the club's whole history into the channel at once.
//
// A REPORT OLDER THAN THIS IS NEVER RELAYED. It is not lost — the row is in the
// table and psql finds it — but the channel will not learn about it. That bound
// is why a failed post must never be recorded as done.
const LOOKBACK_HOURS = 72;

// Discord refuses an embed description past 4096 and a title past 256.
const MAX_BODY = 4000;
const MAX_TITLE = 200;

interface MappingRow {
  source: string;
  source_id: string;
  channel_id: string;
  discord_message_id: string;
  synced_summary: string;
}

interface ReportRow {
  id: string;
  kind: string;
  title: string | null;
  body: string;
  image_url: string | null;
  image_path: string | null;
  discord_user_id: string | null;
  created_at: string;
  players: { full_name: string | null; handle: string | null } | null;
}

interface SurveyRow {
  id: string;
  rating: number | null;
  body: string | null;
  created_at: string;
  updated_at: string;
  tournaments: { name: string | null } | null;
  players: { full_name: string | null; handle: string | null } | null;
}

export interface FeedbackAction {
  kind: 'post' | 'edit' | 'retract';
  source: 'report' | 'event_feedback';
  sourceId: string;
  channelId: string;
  discordMessageId: string | null;
  /** Rendered body. Doubles as the change-detection key stored in the mapping. */
  summary: string;
  title: string;
  body: string;
  author: string;
  context: string;
  rating: number | null;
  imageUrl: string | null;
  createdAt: string | null;
}

/**
 * Free text on its way into a channel message.
 *
 * Newlines survive: a reproduction is written as a numbered list and flattening
 * it destroys the most useful reports. Everything else in the control range
 * becomes a space — an embedded escape sequence garbles a terminal, and this
 * text is read in psql as often as in Discord.
 *
 * Mention syntax is NOT stripped. The bot sends allowed_mentions:{parse:[]} and
 * puts this in an embed rather than content, so an @everyone in a bug report
 * cannot ping anybody, and mangling what somebody wrote to defend against a
 * ping that cannot happen would make the report harder to read for no gain.
 */
function cleanText(raw: string | null, cap: number): string {
  return (raw ?? '')
    .replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : ' '))
    .trim()
    .slice(0, cap);
}

/** A title is a single line, always: it becomes an embed title, which does not wrap. */
function cleanTitle(raw: string | null, cap: number): string {
  return (raw ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

function playerName(p: { full_name: string | null; handle: string | null } | null): string {
  return p?.full_name?.trim() || p?.handle?.trim() || '';
}

/**
 * Who filed it, rendered.
 *
 * A LINKED REPORTER GETS BOTH: their club name, so an exec knows who it is
 * without leaving the channel, and <@id>, so replying to them is one click. The
 * mention is inert — allowed_mentions:{parse:[]} on the bot's side — which
 * matters, because a relayed report that pinged its author would turn a quiet
 * complaint into a notification about a room they cannot see.
 *
 * An UNLINKED reporter has only the Discord id, and it is said out loud rather
 * than left blank: "not linked" is the difference between "we cannot reply
 * through the app" and "we do not know who this is".
 */
// Screenshots from the in-app form live in a PRIVATE bucket, so the bot cannot
// fetch them by path — it gets a URL signed here, at the moment we post.
//
// Two details that are easy to get wrong:
//
//  - The lifetime is short on purpose. This is the same trust model the bot's
//    host allowlist already assumes for Discord's CDN links: fetch promptly,
//    treat an expired one as an ordinary miss. The row keeps the PATH, so a
//    later triage page can always sign a fresh one (00174).
//  - The base has to be rewritten. This client is built with
//    getServerSupabaseUrl(), which on prod is SUPABASE_INTERNAL_URL — a hostname
//    that only resolves inside the app's own network. Handing that to the bot,
//    a separate container, produces a fetch that fails for a reason nothing in
//    the log would explain. NEXT_PUBLIC_SUPABASE_URL is the reachable one.
const SCREENSHOT_URL_TTL_SECONDS = 60 * 30;

async function signScreenshot(
  supabase: ReturnType<typeof createServiceRoleClient>,
  path: string | null,
): Promise<string | null> {
  if (!path) return null;

  const { data, error } = await supabase.storage
    .from('feedback-screenshots')
    .createSignedUrl(path, SCREENSHOT_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    // Best effort by design: the words are the report, the screenshot is a
    // bonus. Losing the image must never hold back the post.
    console.error('[discord] feedback relay: could not sign screenshot:', error?.message);
    return null;
  }

  const internal = getServerSupabaseUrl();
  const publicBase = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (publicBase && data.signedUrl.startsWith(internal)) {
    return publicBase.replace(/\/$/, '') + data.signedUrl.slice(internal.replace(/\/$/, '').length);
  }
  return data.signedUrl;
}

function reportAuthor(row: ReportRow): string {
  const name = playerName(row.players);
  const mention = row.discord_user_id ? `<@${row.discord_user_id}>` : '';
  if (name && mention) return `${name} (${mention})`;
  if (name) return name;
  if (mention) return `${mention} — not linked to a club account`;
  return 'Anonymous';
}

const KIND_LABELS: Record<string, string> = {
  bug: 'Bug report',
  feedback: 'Feedback',
  tournament_feedback: 'Tournament feedback',
  other: 'Other',
};

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:feedback-relay:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();

  const [settingsResult, mappedResult] = await Promise.all([
    supabase.from('discord_settings').select('key, value'),
    supabase
      .from('discord_feedback_posts')
      .select('source, source_id, channel_id, discord_message_id, synced_summary')
      .eq('guild_id', guildId)
      .order('updated_at', { ascending: false })
      .limit(MAX_MAPPED),
  ]);

  if (settingsResult.error || mappedResult.error) {
    // 503 rather than an empty action list: an empty list is indistinguishable
    // from "nothing to do", and this relay going quiet is invisible.
    console.error(
      '[discord] feedback relay: config read failed:',
      settingsResult.error?.message ?? mappedResult.error?.message
    );
    return NextResponse.json({ error: 'config_unavailable' }, { status: 503 });
  }

  const settings = new Map(
    ((settingsResult.data ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value])
  );
  const reportChannel = settings.get('feedback_channel_id') ?? null;
  const surveyChannel = settings.get('event_feedback_channel_id') ?? null;

  const mapped = new Map<string, MappingRow>();
  for (const row of (mappedResult.data ?? []) as MappingRow[]) {
    mapped.set(`${row.source}:${row.source_id}`, row);
  }

  const actions: FeedbackAction[] = [];
  const skipped: { sourceId: string; reason: string }[] = [];

  // SAID OUT LOUD, once per tick. Not an error — the club has simply not opted
  // that half in — but "we set the bug channel and the survey comments never
  // showed up" needs an answer, and an unset key is otherwise indistinguishable
  // from a relay that is quietly broken. Edits and retractions still run either
  // way: those take the channel from the mapping, not from the setting.
  if (!reportChannel) skipped.push({ sourceId: '*', reason: 'no_feedback_channel' });
  if (!surveyChannel) skipped.push({ sourceId: '*', reason: 'no_event_feedback_channel' });

  if (mapped.size === MAX_MAPPED) {
    // The cap is doing something, which means the oldest mappings are not being
    // synced this tick. Never silent: "the relay stopped noticing edits" is
    // otherwise a bug with no evidence anywhere.
    console.warn(
      `[discord] feedback relay: ${MAX_MAPPED} mapped messages in ${guildId} — ` +
        'at the per-tick cap, older ones are not being synced this run.'
    );
    skipped.push({ sourceId: '*', reason: 'mapping_cap_reached' });
  }

  // ---- REPORTS ------------------------------------------------------------
  //
  // Windowed on created_at, not updated_at, and that is a statement about the
  // table: NOTHING EDITS A REPORT. /bug files it and is done, and the only
  // writable column is `status`, which is triage state and not something the
  // channel should re-post about. Keying on updated_at would mean a report
  // marked 'triaged' six weeks later re-entering the window and — since the
  // mapping already exists and the summary has not changed — doing nothing,
  // every tick, forever. created_at says what is meant: new reports only.

  let reports: ReportRow[] = [];
  if (reportChannel) {
    const { data, error } = await supabase
      .from('feedback_reports')
      .select(
        'id, kind, title, body, image_url, image_path, discord_user_id, created_at, ' +
          'players(full_name, handle)'
      )
      // EXCLUDED, and this is load-bearing since 00175 merged the survey into
      // this table: without it every survey response is picked up twice — once
      // here as a report and once by the survey branch below — and posted to
      // both channels under two different mappings.
      .neq('kind', 'tournament_feedback')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_WINDOW);

    if (error) {
      console.error('[discord] feedback relay: report read failed:', error.message);
      return NextResponse.json({ error: 'reports_unavailable' }, { status: 503 });
    }
    reports = (data ?? []) as unknown as ReportRow[];
  }

  for (const r of reports) {
    // Already relayed. The summary is never compared for a report, because it
    // can never differ — see the window note above.
    if (mapped.has(`report:${r.id}`)) continue;

    const body = cleanText(r.body, MAX_BODY);
    if (!body) {
      // 00172's CHECK makes an empty body impossible, so this is a row that
      // was all control characters. Skipped rather than posted blank.
      skipped.push({ sourceId: r.id, reason: 'empty_body' });
      continue;
    }

    const label = KIND_LABELS[r.kind] ?? 'Feedback';
    actions.push({
      kind: 'post',
      source: 'report',
      sourceId: r.id,
      channelId: reportChannel as string,
      discordMessageId: null,
      summary: `${r.title ?? ''}\n${body}`,
      title: cleanTitle(r.title, MAX_TITLE) || label,
      body,
      author: reportAuthor(r),
      context: label,
      rating: null,
      imageUrl: r.image_url ?? (await signScreenshot(supabase, r.image_path)),
      createdAt: r.created_at,
    });
  }

  // ---- TOURNAMENT SURVEY RESPONSES ----------------------------------------
  //
  // Windowed on updated_at, because this source IS editable: submitEventFeedback
  // upserts on (tournament_id, player_id) and bumps updated_at explicitly, so a
  // revised comment re-enters the window under its own steam and edits its own
  // message.

  const mappedSurveyIds = [...mapped.values()]
    .filter((m) => m.source === 'event_feedback')
    .map((m) => m.source_id);

  const surveySelect =
    'id, rating, body, created_at, updated_at, tournaments(name), players(full_name, handle)';

  const [freshResult, knownResult] = await Promise.all([
    surveyChannel
      ? supabase
          .from('feedback_reports')
          .select(surveySelect)
          .eq('kind', 'tournament_feedback')
          .gte('updated_at', since)
          .order('updated_at', { ascending: false })
          .limit(MAX_WINDOW)
      : Promise.resolve({ data: [], error: null }),
    // The mapped rows, whether or not they are in the window: without this a
    // response relayed last month is absent from `byId` and the sweep reads
    // that as a deletion. Aimed at exactly the mapped ids, which MAX_MAPPED
    // keeps small enough that this read cannot itself truncate.
    mappedSurveyIds.length
      ? supabase
          .from('feedback_reports')
          .select(surveySelect)
          .eq('kind', 'tournament_feedback')
          .in('id', mappedSurveyIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (freshResult.error || knownResult.error) {
    console.error(
      '[discord] feedback relay: survey read failed:',
      freshResult.error?.message ?? knownResult.error?.message
    );
    return NextResponse.json({ error: 'survey_unavailable' }, { status: 503 });
  }

  const byId = new Map<string, SurveyRow>();
  for (const row of [
    ...((freshResult.data ?? []) as unknown as SurveyRow[]),
    ...((knownResult.data ?? []) as unknown as SurveyRow[]),
  ]) {
    byId.set(row.id, row);
  }

  // THE SWEEP FIRES ONLY ON POSITIVE EVIDENCE THAT feedback_reports IS READABLE.
  // Zero rows is not that evidence — see the header. A non-empty byId settles
  // it: the table answered, so an id absent from it is absent because the row is
  // gone. When byId is empty the question is open, and one unfiltered read
  // closes it. If no response exists at all, an emptied table and a broken one
  // look identical from here and the honest answer is to refuse; that costs one
  // tick and clears itself the moment a row exists.
  let sweepable = byId.size > 0;

  if (!sweepable && mappedSurveyIds.length > 0) {
    const { data: anyRow, error: livenessError } = await supabase
      .from('feedback_reports')
      .select('id')
      .limit(1);

    sweepable = !livenessError && ((anyRow ?? []) as { id: string }[]).length > 0;

    if (!sweepable) {
      console.error(
        `[discord] feedback relay: all ${mappedSurveyIds.length} mapped survey response(s) ` +
          'look deleted and public.feedback_reports reads as empty — refusing to retract on ' +
          'evidence this weak. Check the SELECT grant (read pg_class.relacl, not ' +
          'information_schema) and whether the PostgREST schema cache has been reloaded. ' +
          `${livenessError?.message ?? ''}`
      );
      return NextResponse.json({ error: 'survey_unverified' }, { status: 503 });
    }
  }

  // Deleted outright, which is only reachable by deleting the tournament.
  if (sweepable) {
    for (const [key, existing] of mapped) {
      if (existing.source !== 'event_feedback') continue;
      if (byId.has(existing.source_id)) continue;
      actions.push({
        kind: 'retract',
        source: 'event_feedback',
        sourceId: existing.source_id,
        channelId: existing.channel_id,
        discordMessageId: existing.discord_message_id,
        summary: existing.synced_summary,
        title: '',
        body: '',
        author: '',
        context: '',
        rating: null,
        imageUrl: null,
        createdAt: null,
      });
      skipped.push({ sourceId: key, reason: 'source_deleted' });
    }
  }

  for (const s of byId.values()) {
    const existing = mapped.get(`event_feedback:${s.id}`) ?? null;
    const comment = cleanText(s.body, MAX_BODY);

    // A BARE RATING IS NOT RELAYED. It is a number for the stats page, not
    // something for a human to read, and relaying them would bury the responses
    // that have words in them. An emptied comment is therefore also the
    // retraction path — the only one a member has, since the form offers no
    // delete.
    if (!comment) {
      if (existing) {
        actions.push({
          kind: 'retract',
          source: 'event_feedback',
          sourceId: s.id,
          channelId: existing.channel_id,
          discordMessageId: existing.discord_message_id,
          summary: existing.synced_summary,
          title: '',
          body: '',
          author: '',
          context: '',
          rating: null,
          imageUrl: null,
          createdAt: null,
        });
      } else {
        skipped.push({ sourceId: s.id, reason: 'rating_only' });
      }
      continue;
    }

    const tournament = cleanTitle(s.tournaments?.name ?? null, MAX_TITLE) || 'A tournament';
    const author = playerName(s.players) || 'Unknown player';
    const summary = `${s.rating ?? ''}|${comment}`;

    if (!existing) {
      // Nothing to post into; already reported once above.
      if (!surveyChannel) continue;
      actions.push({
        kind: 'post',
        source: 'event_feedback',
        sourceId: s.id,
        channelId: surveyChannel,
        discordMessageId: null,
        summary,
        title: tournament,
        body: comment,
        author,
        context: tournament,
        rating: s.rating,
        imageUrl: null,
        createdAt: s.created_at,
      });
      continue;
    }

    if (existing.synced_summary !== summary) {
      actions.push({
        kind: 'edit',
        source: 'event_feedback',
        sourceId: s.id,
        // The channel the message IS in, which is not necessarily the
        // configured one: repointing the setting does not move what is posted.
        channelId: existing.channel_id,
        discordMessageId: existing.discord_message_id,
        summary,
        title: tournament,
        body: comment,
        author,
        context: tournament,
        rating: s.rating,
        imageUrl: null,
        createdAt: s.created_at,
      });
    }
  }

  return NextResponse.json({
    actions,
    skipped,
    ...(reports.length >= MAX_WINDOW || (freshResult.data ?? []).length >= MAX_WINDOW
      ? { windowCapReached: MAX_WINDOW }
      : {}),
  });
}

// Record a message Discord has ALREADY accepted. Never called beforehand: a
// mapping written first, for a post that then fails, is a report the relay
// believes it published and never will.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:feedback-relay:write:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null);
  const source = str('source');
  const sourceId = str('sourceId');
  const guildId = str('guildId');
  const channelId = str('channelId');
  const discordMessageId = str('discordMessageId');
  // Required and non-empty. An empty summary would make every subsequent tick
  // see a difference and edit the same message forever.
  const summary = str('summary');

  if (
    (source !== 'report' && source !== 'event_feedback') ||
    !sourceId ||
    !guildId ||
    !channelId ||
    !discordMessageId ||
    !summary
  ) {
    return NextResponse.json({ error: 'incomplete_mapping' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_feedback_posts')
    .upsert(
      {
        source,
        source_id: sourceId,
        guild_id: guildId,
        channel_id: channelId,
        discord_message_id: discordMessageId,
        synced_summary: summary,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source,source_id,guild_id' }
    );

  if (error) {
    // A post that landed but did not record leaves a report in the exec channel
    // with no mapping, and the next tick posts a SECOND copy.
    console.error('[discord] feedback relay record failed:', error.message);
    return NextResponse.json({ error: 'record_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}

// Forget a mapping, after the Discord message is gone.
export async function DELETE(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:feedback-relay:write:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const params = new URL(request.url).searchParams;
  const source = params.get('source');
  const sourceId = params.get('sourceId');
  const guildId = params.get('guildId');
  if ((source !== 'report' && source !== 'event_feedback') || !sourceId || !guildId) {
    return NextResponse.json({ error: 'source_and_guild_required' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_feedback_posts')
    .delete()
    .eq('source', source)
    .eq('source_id', sourceId)
    .eq('guild_id', guildId);

  if (error) {
    console.error('[discord] feedback mapping delete failed:', error.message);
    return NextResponse.json({ error: 'delete_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
