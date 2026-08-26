import { NextResponse } from 'next/server';
import { CLUB_TIMEZONE, wallClockToUtc } from '@badminton/shared';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// Which sessions are due a Discord ping, and which role to ping for each.
//
// THE APP DECIDES WHO AND WHEN; THE BOT ONLY POSTS. Same split as everything
// else on this surface — the bot holds the Discord token and nothing else, so a
// change to what counts as "due" happens in one place and cannot drift between
// the website and Discord.
//
// A PING IS A BROADCAST, WHICH MAKES IT A DIFFERENT PROBLEM FROM /sessions.
// /sessions narrows to the caller because there is a caller. A channel message
// has no viewer to narrow to: everyone who can read the channel reads it. So
// the visibility decision here is a CHANNEL decision, not a filter — a club
// that does not want competitive nights announced server-wide points the
// competitive ping role at a competitive-only channel and lets Discord's own
// permissions do the work. Nothing in this route tries to guess who should see
// what, because at broadcast time there is nobody to guess about.

const DEFAULT_LEAD_MINUTES = 120;

// A ping that is hours late is worse than none: it arrives after the session
// has started and tells people to come to something they have missed. If the
// cron has not run for longer than this, the window has passed and the ping is
// dropped rather than fired stale.
const MAX_LATENESS_MINUTES = 30;

function clubTimeToUtc(date: string, time: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  // wallClockToUtc rather than Intl, for the reason the session-reminder job
  // documents: BC stops changing its clocks on 2026-11-01 (tzdata 2026b) and a
  // Node that predates that release answers an hour out for every session past
  // it. Sessions are already booked past that date.
  return wallClockToUtc(y, mo, d, h, mi);
}

function clubDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
}

export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const guildId = new URL(request.url).searchParams.get('guildId');
  if (!guildId) return NextResponse.json({ error: 'guild_id_required' }, { status: 400 });

  const supabase = createServiceRoleClient();
  const now = new Date();

  const [rolesResult, settingsResult] = await Promise.all([
    supabase
      .from('discord_self_roles')
      .select('role_id, label, track, channel_id')
      .eq('guild_id', guildId)
      .not('track', 'is', null),
    supabase.from('discord_settings').select('key, value'),
  ]);

  // Both NAMED. A failed PostgREST read arrives as data:null with an error
  // rather than a throw, so degrading either to an empty list would report
  // "nothing due" — a cron that looks like it ran fine and pinged nobody.
  if (rolesResult.error || settingsResult.error) {
    const detail = rolesResult.error?.message ?? settingsResult.error?.message ?? 'unknown';
    console.error('[discord] session-pings config read failed:', detail);
    return NextResponse.json({ error: 'config_unavailable', detail }, { status: 503 });
  }

  const pingRoles = (rolesResult.data ?? []) as {
    role_id: string;
    label: string;
    track: string;
    channel_id: string | null;
  }[];

  if (pingRoles.length === 0) return NextResponse.json({ pings: [] });

  const settings = new Map(
    ((settingsResult.data ?? []) as { key: string; value: string }[]).map((s) => [s.key, s.value])
  );
  const defaultChannel = settings.get('session_ping_channel_id') ?? null;
  const leadRaw = Number(settings.get('session_ping_lead_minutes'));
  const leadMinutes = Number.isFinite(leadRaw) && leadRaw > 0 ? leadRaw : DEFAULT_LEAD_MINUTES;

  // Sessions starting between now and the lead time, plus the lateness grace.
  // Filtered on `date` because that is the indexed column; the precise instant
  // comparison happens below, where the club-local wall clock is resolved.
  const horizon = new Date(now.getTime() + (leadMinutes + 1440) * 60_000);
  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('id, name, date, start_time, location, track')
    .eq('status', 'open')
    .gte('date', clubDate(new Date(now.getTime() - 86400000)))
    .lte('date', clubDate(horizon));

  if (error) {
    Sentry.captureException(error, { extra: { route: 'discord/session-pings' } });
    return NextResponse.json({ error: 'sessions_unavailable' }, { status: 502 });
  }

  const rows = (sessions ?? []) as {
    id: string;
    name: string | null;
    date: string;
    start_time: string | null;
    location: string | null;
    track: string;
  }[];

  // Everything already pinged, read in ONE query rather than per session.
  const { data: already, error: pingedError } = await supabase
    .from('discord_session_pings')
    .select('session_id, role_id')
    .in(
      'session_id',
      rows.map((r) => r.id)
    );

  if (pingedError) {
    // FAIL CLOSED, and this is the one place it matters most: treating a failed
    // read as "nothing has been pinged yet" would re-ping every session in the
    // window on every cron tick until the read recovered.
    console.error('[discord] session-pings history read failed:', pingedError.message);
    return NextResponse.json({ error: 'ping_history_unavailable' }, { status: 503 });
  }

  const sent = new Set(
    ((already ?? []) as { session_id: string; role_id: string }[]).map(
      (p) => `${p.session_id}:${p.role_id}`
    )
  );

  // ONE ENTRY PER (SESSION, CHANNEL), not per (session, role).
  //
  // A club-wide night matches every ping role, and two ping roles pointed at
  // the same channel would otherwise produce two messages saying the same
  // thing in the same place — and the (session_id, role_id) idempotency key
  // cannot catch it, because both rows are genuinely distinct. Grouping here
  // is the only place the collision is visible: the bot posts one message per
  // entry mentioning every role in it, and records one row per role, so the
  // key still does its job across ticks.
  const pings: {
    sessionId: string;
    channelId: string;
    roleIds: string[];
    name: string | null;
    startsAt: string;
    location: string | null;
  }[] = [];

  for (const session of rows) {
    if (!session.start_time) continue;
    const startsAt = clubTimeToUtc(session.date, session.start_time);
    const minutesAway = (startsAt.getTime() - now.getTime()) / 60_000;

    // Due, and not so overdue that the ping would be noise.
    if (minutesAway > leadMinutes) continue;
    if (minutesAway < -MAX_LATENESS_MINUTES) continue;

    // Insertion-ordered, so the channels come out in the order their first
    // matching role was configured rather than in hash order.
    const byChannel = new Map<string, string[]>();

    for (const role of pingRoles) {
      // An 'all' session pings every configured ping role — a club-wide night is
      // for everybody, so anyone who asked to hear about nights hears about it.
      // Otherwise the tracks must match exactly.
      if (session.track !== 'all' && role.track !== session.track) continue;
      if (sent.has(`${session.id}:${role.role_id}`)) continue;

      const channelId = role.channel_id ?? defaultChannel;
      // No channel configured anywhere means this role cannot be pinged. Skip
      // rather than erroring the whole run: one unconfigured role must not stop
      // the others going out.
      if (!channelId) continue;

      const roles = byChannel.get(channelId);
      if (roles) roles.push(role.role_id);
      else byChannel.set(channelId, [role.role_id]);
    }

    for (const [channelId, roleIds] of byChannel) {
      pings.push({
        sessionId: session.id,
        channelId,
        roleIds,
        name: session.name,
        startsAt: startsAt.toISOString(),
        location: session.location,
      });
    }
  }

  return NextResponse.json({ pings });
}

// Record that a ping went out. Called by the bot AFTER a successful post.
export async function POST(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  let body: { sessionId?: unknown; roleIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
  // A LIST, because one message can mention several roles. Recording them in
  // one statement rather than one call each means a post that mentioned three
  // roles cannot end up half-recorded and re-ping a subset next tick.
  const roleIds = Array.isArray(body.roleIds)
    ? body.roleIds.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [];

  if (!sessionId || roleIds.length === 0) {
    return NextResponse.json({ error: 'session_and_roles_required' }, { status: 400 });
  }

  const { error } = await createServiceRoleClient()
    .from('discord_session_pings')
    // Idempotent: two replicas racing the same tick both post at most once
    // each, and the second insert is a no-op rather than a 409 the bot would
    // have to interpret.
    .upsert(
      roleIds.map((roleId) => ({ session_id: sessionId, role_id: roleId })),
      { onConflict: 'session_id,role_id' }
    );

  if (error) {
    // Loud, because the consequence is a repeat ping on the next tick. That is
    // the failure mode this design deliberately chose over a silent drop, but
    // it should still be visible rather than assumed.
    console.error('[discord] session-ping record failed:', error.message);
    return NextResponse.json({ error: 'record_failed' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
