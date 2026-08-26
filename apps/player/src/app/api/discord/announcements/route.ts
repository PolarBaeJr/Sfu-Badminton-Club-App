import { NextResponse } from 'next/server';
import { getClientIp, rateLimit } from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Which announcements owe Discord a message, and what to do about each.
//
// THE APP DECIDES, THE BOT POSTS. Same split as the session pings and the
// tournament events: the bot holds a Discord token and nothing else, so "who
// may see this" is settled once, here, next to the rule it has to obey.
//
// ONLY target_audience = 'all' IS EVER RELAYED, and this is the whole design.
//
// src/lib/announcement-visibility.ts is the club's answer to "who can see this
// announcement", and its audience rule is a PER-VIEWER predicate: 'competitive'
// is matched against the reader's own players.status, and 'eligible_only'
// against their eligibility_flag. A Discord channel is not a viewer. Relaying a
// competitive-only notice into a #competitive channel would not apply that rule
// — it would ASSERT that everyone who can read the channel has status =
// 'competitive', and nothing in this system checks the assertion. The two sets
// are known to drift: the role reconcile sweep exists because they do, and a
// member can hold @Competitive Team in Discord while the app says otherwise.
// eligibility_flag has no Discord analogue at all.
//
// So a narrowly-addressed announcement is SKIPPED WITH A REASON rather than
// posted to an approximation of its audience, and stays on the website where
// the rule is enforced against the actual member.
//
// THE SEASON FILTER IS DELIBERATELY ABSENT, unlike the three website screens.
// The lookback below subsumes it: a row touched in the last three days belongs
// to the current season by construction, and between terms — when there is no
// active season — the website drops the filter too (see the visibility module's
// note on why a blank feed is the worse failure).

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  type: string;
  status: string;
  target_audience: string;
  expires_at: string | null;
}

interface MappingRow {
  announcement_id: string;
  channel_id: string;
  discord_message_id: string;
  synced_title: string;
  synced_body: string;
  synced_type: string;
}

// Nothing published longer ago than this is relayed, and the reason is about
// the FIRST run rather than the steady state: without a floor, switching the
// relay on posts the club's entire announcement history into the channel at
// once. It also protects the test server — this mapping table is an idempotency
// record, and the nightly prod -> staging snapshot copies it, so a staging
// database re-seeded without one must not replay a week of prod's notices.
//
// Three days rather than one so a bot down over a weekend delays the relay
// instead of dropping it.
const LOOKBACK_HOURS = 72;

// Discord truncates an embed description at 4096 characters and refuses the
// message outright past it. Built to fit rather than sent hopefully.
const MAX_BODY = 4000;

// How many mapped messages one tick will look at, and it is a SAFETY BOUND
// rather than a performance one.
//
// Production sets PGRST_DB_MAX_ROWS=1000 (see 00152). The orphan sweep below
// reads the mapped announcements back with .in('id', ...) and treats anything
// that does not come back as deleted-from-the-website — so if that read were
// ever truncated at the ceiling, every mapping past row 1000 would look like a
// deletion and the tick would retract the whole channel. Keeping the mapping
// read well under the ceiling makes the second read unable to truncate, because
// it can never be asked for more ids than this.
//
// The SAME number is also a URL-length bound. That second read spells its ids
// out in the query string, at ~37 bytes each, and nginx in front of PostgREST
// stops reading a request line long before an unbounded list would end. The
// failure there is a 414 the client reports as an error, so it 503s rather than
// retracting anything — but it 503s on EVERY tick from then on, which is the
// relay simply not working. 150 ids is ~5.5KB, inside any default buffer, and
// still an order of magnitude more announcements than the club has ever had.
//
// Newest first, so the cap starves the settled end rather than the live one: an
// announcement relayed months ago is the one least likely to still be changing.
// Hitting it is reported, not swallowed.
const MAX_MAPPED = 150;

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:announcements:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const now = Date.now();

  const [settingsResult, mappedResult] = await Promise.all([
    supabase.from('discord_settings').select('key, value'),
    supabase
      .from('discord_announcement_posts')
      .select(
        'announcement_id, channel_id, discord_message_id, synced_title, synced_body, synced_type'
      )
      .eq('guild_id', guildId)
      .order('updated_at', { ascending: false })
      .limit(MAX_MAPPED),
  ]);

  // BOTH NAMED, never degraded to an empty list. A failed PostgREST read comes
  // back as data:null with an error rather than throwing, and an empty mapping
  // list means "nothing relayed yet" — which would post a SECOND copy of every
  // announcement that already has one, on every tick, until the read recovered.
  // In a channel members actually read, that is worse than the equivalent
  // duplicate in the Events tab.
  if (settingsResult.error || mappedResult.error) {
    const detail = settingsResult.error?.message ?? mappedResult.error?.message ?? 'unknown';
    console.error('[discord] announcements config read failed:', detail);
    return NextResponse.json({ error: 'config_unavailable', detail }, { status: 503 });
  }

  const settings = new Map(
    ((settingsResult.data ?? []) as { key: string; value: string }[]).map((s) => [s.key, s.value])
  );
  const channelId = settings.get('announcement_channel_id')?.trim() || null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? null;

  const mapped = new Map(
    ((mappedResult.data ?? []) as MappingRow[]).map((m) => [m.announcement_id, m])
  );

  // NO CHANNEL, NO RELAY — but the mapped ones still have to be reachable, or a
  // club that clears the setting to stop the relay would leave every message it
  // had already posted stranded with no way to retract it.
  if (!channelId && mapped.size === 0) {
    return NextResponse.json({ actions: [], skipped: [] });
  }

  const columns = 'id, title, body, type, status, target_audience, expires_at';
  const since = new Date(now - LOOKBACK_HOURS * 3600_000).toISOString();

  // TWO READS, MERGED, for the reason 00169 spells out: the relayable set is
  // recent and published, while the RETRACTABLE set is "already has a message"
  // — and an announcement pulled back to draft, or narrowed to one division
  // after the fact, is in the second and not the first.
  //
  // updated_at rather than created_at is the freshness column because a trigger
  // maintains it (00004): a notice drafted in August and published today reads
  // as today's, which is what an exec means by publishing it.
  const [freshResult, knownResult] = await Promise.all([
    supabase.from('announcements').select(columns).eq('status', 'published').gte('updated_at', since),
    mapped.size > 0
      ? supabase
          .from('announcements')
          .select(columns)
          .in('id', [...mapped.keys()])
      : Promise.resolve({ data: [] as unknown, error: null }),
  ]);

  if (freshResult.error || knownResult.error) {
    const detail = freshResult.error?.message ?? knownResult.error?.message ?? 'unknown';
    console.error('[discord] announcements read failed:', detail);
    return NextResponse.json({ error: 'announcements_unavailable', detail }, { status: 503 });
  }

  const byId = new Map<string, AnnouncementRow>();
  for (const row of [
    ...((freshResult.data ?? []) as AnnouncementRow[]),
    ...((knownResult.data ?? []) as AnnouncementRow[]),
  ]) {
    byId.set(row.id, row);
  }

  const actions: {
    kind: 'post' | 'edit' | 'retract';
    announcementId: string;
    channelId: string;
    discordMessageId: string | null;
    title: string;
    body: string;
    type: string;
    url: string | null;
  }[] = [];
  const skipped: { announcementId: string; reason: string }[] = [];

  if (mapped.size === MAX_MAPPED) {
    // The cap above is doing something, which means the oldest mappings are not
    // being synced this tick. Never silent: "the relay stopped noticing edits"
    // is otherwise a bug with no evidence anywhere.
    console.warn(
      `[discord] announcements: ${MAX_MAPPED} mapped messages in ${guildId} — ` +
        'at the per-tick cap, older ones are not being synced this run.'
    );
    skipped.push({ announcementId: '*', reason: 'mapping_cap_reached' });
  }

  // THE SWEEP FIRES ONLY ON POSITIVE EVIDENCE THAT `announcements` IS READABLE.
  // Zero rows is not that evidence.
  //
  // MAX_MAPPED defends the sweep against a TRUNCATED read. It does nothing
  // against the way reads have actually failed in this codebase three separate
  // times: coming back as an EMPTY LIST with no error at all — a missing SELECT
  // grant, or a PostgREST schema cache that has not seen the table yet. 00170
  // is a brand new table whose first NOTIFY pgrst is still ahead of it.
  //
  // Both reads above hit `announcements`. If that is the read that is broken,
  // byId is empty, mapped is full, and this loop retracts every message the
  // relay has ever posted, in one tick, with the error branch above never
  // firing because there is no error. That is the worst thing this feature can
  // do, and it is reachable without anything appearing to go wrong.
  //
  // A NON-EMPTY byId settles it: the table answered, so an id absent from it is
  // absent because the row is gone. When byId is empty the question is open, and
  // one unfiltered read closes it — if any announcement at all exists, reads
  // work and the absences are real. If none does, an emptied table and a broken
  // one look identical from here and the honest answer is to refuse. Refusing
  // costs a tick of syncing and clears itself the moment one row exists.
  let sweepable = byId.size > 0;

  if (!sweepable && mapped.size > 0) {
    const { data: anyRow, error: livenessError } = await supabase
      .from('announcements')
      .select('id')
      .limit(1);

    sweepable = !livenessError && ((anyRow ?? []) as { id: string }[]).length > 0;

    if (!sweepable) {
      console.error(
        `[discord] announcements: all ${mapped.size} mapped announcement(s) look deleted ` +
          'and public.announcements reads as empty — refusing to retract on evidence ' +
          'this weak. Check the SELECT grant (read pg_class.relacl, not ' +
          'information_schema) and whether the PostgREST schema cache has been ' +
          `reloaded. ${livenessError?.message ?? ''}`
      );
      return NextResponse.json({ error: 'announcements_unverified' }, { status: 503 });
    }
  }

  // DELETED FROM THE WEBSITE ALTOGETHER, which is the one retraction the rest of
  // this loop cannot see.
  //
  // The console's delete is a hard DELETE (deleteAnnouncement), and it is what
  // an exec reaches for when the club is taking back what it said — it demands a
  // typed reason and audits it. There is no row left to iterate, so without this
  // the Discord copy would be the single case that survives: unpublishing,
  // expiry and narrowing the audience all take it down, and the most emphatic
  // retraction available would leave it standing.
  //
  // 00170 leaves announcement_id un-referenced precisely so the mapping outlives
  // the announcement and this is reachable. "Absent from byId" is only allowed
  // to mean "deleted" because of the two guards above: MAX_MAPPED, so it cannot
  // mean "past PGRST_DB_MAX_ROWS", and the liveness check, so it cannot mean
  // "the read came back empty and said nothing about it".
  for (const [announcementId, existing] of mapped) {
    if (byId.has(announcementId)) continue;
    actions.push({
      kind: 'retract',
      announcementId,
      channelId: existing.channel_id,
      discordMessageId: existing.discord_message_id,
      title: existing.synced_title,
      body: '',
      type: existing.synced_type,
      url: null,
    });
  }

  for (const a of byId.values()) {
    const existing = mapped.get(a.id) ?? null;

    const expired = a.expires_at !== null && Date.parse(a.expires_at) <= now;
    const addressedToEveryone = a.target_audience === 'all';
    const relayable = a.status === 'published' && addressedToEveryone && !expired;

    if (!relayable) {
      if (existing) {
        // RETRACT. An announcement pulled back to draft, expired, or narrowed
        // to one division after the fact has stopped being something the whole
        // server may read — and the second of those is the one that matters:
        // leaving the message up would keep publishing exactly what the
        // audience change was meant to stop.
        actions.push({
          kind: 'retract',
          announcementId: a.id,
          channelId: existing.channel_id,
          discordMessageId: existing.discord_message_id,
          title: existing.synced_title,
          body: '',
          type: existing.synced_type,
          url: null,
        });
      } else if (a.status === 'published' && !addressedToEveryone) {
        // Named rather than dropped in silence. "I published it and nothing
        // appeared" is otherwise an unanswerable question, and the answer here
        // is a decision rather than a fault.
        skipped.push({ announcementId: a.id, reason: 'narrow_audience' });
      } else if (a.status === 'published' && expired) {
        skipped.push({ announcementId: a.id, reason: 'expired' });
      }
      continue;
    }

    // Reachable only through the mapping read once the setting is cleared, and
    // there is nowhere to post it to.
    if (!channelId && !existing) {
      skipped.push({ announcementId: a.id, reason: 'no_channel_configured' });
      continue;
    }

    const body = a.body.slice(0, MAX_BODY);
    const url = appUrl ? `${appUrl}/announcements` : null;

    if (!existing) {
      actions.push({
        kind: 'post',
        announcementId: a.id,
        channelId: channelId as string,
        discordMessageId: null,
        title: a.title,
        body,
        type: a.type,
        url,
      });
      continue;
    }

    const changed =
      existing.synced_title !== a.title ||
      existing.synced_body !== body ||
      existing.synced_type !== a.type;

    if (changed) {
      actions.push({
        kind: 'edit',
        announcementId: a.id,
        // The channel the message is IN, not the currently configured one. A
        // club that moves the setting to a new channel has not moved the
        // messages already posted, and editing them at the new address would
        // simply fail.
        channelId: existing.channel_id,
        discordMessageId: existing.discord_message_id,
        title: a.title,
        body,
        type: a.type,
        url,
      });
    }
  }

  return NextResponse.json({ actions, skipped });
}

// Record a message the bot has ALREADY posted or edited.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:announcements:write:${ip}`, 60, 60_000);
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
  const announcementId = str('announcementId');
  const guildId = str('guildId');
  const channelId = str('channelId');
  const discordMessageId = str('discordMessageId');
  const title = str('title');
  const type = str('type');
  // The only field that may legitimately be empty — an announcement is allowed
  // a title and no body (00001: body DEFAULT ''), so a blank one is content,
  // not an omission, and rejecting it would leave the message unrecorded and
  // reposted on the next tick.
  const syncedBody = typeof body.body === 'string' ? (body.body as string) : null;

  if (
    !announcementId ||
    !guildId ||
    !channelId ||
    !discordMessageId ||
    !title ||
    !type ||
    syncedBody === null
  ) {
    return NextResponse.json({ error: 'incomplete_mapping' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_announcement_posts')
    .upsert(
      {
        announcement_id: announcementId,
        guild_id: guildId,
        channel_id: channelId,
        discord_message_id: discordMessageId,
        synced_title: title,
        synced_body: syncedBody,
        synced_type: type,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'announcement_id,guild_id' }
    );

  if (error) {
    // Loud, and for a worse reason than the tournament equivalent: a post that
    // landed but did not record leaves a club announcement in a channel members
    // read with no mapping, and the next tick posts a SECOND copy of it.
    console.error('[discord] announcement record failed:', error.message);
    return NextResponse.json({ error: 'record_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}

// Forget a mapping, after the Discord message is gone.
export async function DELETE(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:announcements:write:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const params = new URL(request.url).searchParams;
  const announcementId = params.get('announcementId');
  const guildId = params.get('guildId');
  if (!announcementId || !guildId) {
    return NextResponse.json({ error: 'announcement_and_guild_required' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_announcement_posts')
    .delete()
    .eq('announcement_id', announcementId)
    .eq('guild_id', guildId);

  if (error) {
    console.error('[discord] announcement mapping delete failed:', error.message);
    return NextResponse.json({ error: 'delete_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
