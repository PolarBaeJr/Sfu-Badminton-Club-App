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
      .eq('guild_id', guildId),
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
