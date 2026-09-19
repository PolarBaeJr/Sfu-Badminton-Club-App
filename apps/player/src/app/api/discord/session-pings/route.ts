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
//
// THAT PER-ROLE CHANNEL MECHANISM SURVIVES ON THE discord_self_roles FALLBACK
// PATH ONLY. The settings path below has no per-role channel to point anywhere:
// a settings-sourced role carries channel_id: null and therefore posts to
// session_ping_channel_id like everything else. A club that needs competitive
// nights kept out of the server-wide channel has to bind its roles through
// discord_self_roles, because there is nowhere in discord_settings to say it.
//
// AND THE SETTINGS KEYS ARE GLOBAL, NOT PER-GUILD, for the reason the settings
// route documents at its own head: discord_settings is keyed on `key` alone
// (00167) with no guild_id column, so session_ping_competitive_role_id means
// the same role id in every guild this app answers for. That is inherited, not
// new: session_ping_channel_id has always been global, and the guildId in the
// query string only ever narrowed the discord_self_roles read. One club, one
// server per environment, so no guard is added here for a second guild that
// does not exist; widening the table comes first if one ever does.

const DEFAULT_LEAD_MINUTES = 120;

// A ping that is hours late is worse than none: it arrives after the session
// has started and tells people to come to something they have missed. If the
// cron has not run for longer than this, the window has passed and the ping is
// dropped rather than fired stale.
const MAX_LATENESS_MINUTES = 30;

// PING ROLES READ STRAIGHT OUT OF discord_settings, one key per session track.
//
// Why these exist at all: this route originally learned its ping roles only
// from discord_self_roles rows carrying a `track`, and on production that read
// returns ZERO rows. The club hands its `@session ping` role out through
// Discord's built-in Onboarding screen, which writes nothing to this database,
// so no row ever existed to put a `track` on and the pings had never once
// fired. The obvious fix, binding the role with /rolepicker add, was rejected
// by the owner and rightly: that would also list the role in the picker UI and
// give members a SECOND way to get a role Onboarding already grants them, so
// the two grant paths would drift and a member could hold one view of it.
//
// session_ping_all_role_id IS NOT A WILDCARD. It mirrors the session_group
// enum: it is the role pinged on club-wide nights ONLY, the same way
// session_ping_competitive_role_id is the role pinged on competitive nights.
// A club that runs a single ping role for everything therefore sets all THREE
// keys to that one id, which is exactly the case the per-session dedup in the
// loop below exists to survive.
//
// Deliberately NOT in the WRITABLE map in the settings route, so nothing can
// write them over HTTP: an exec sets them with SQL. That also means nothing
// validated them on the way in, which is why the id is regex-checked here on
// the way out rather than trusted.
const SETTINGS_PING_ROLES: Record<string, string> = {
  competitive: 'session_ping_competitive_role_id',
  recreational: 'session_ping_recreational_role_id',
  all: 'session_ping_all_role_id',
};

// Same shape the settings route checks channel ids against.
const SNOWFLAKE = /^\d{17,20}$/;

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
      // No `label`: the only consumer of it is the /rolepicker route, which
      // renders the picker menu. The bot builds its mentions from ids alone.
      .select('role_id, track, channel_id')
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

  // READ BEFORE THE EMPTINESS DECISION, which is why this sits above the role
  // rows rather than below them: the settings now carry a whole source of ping
  // roles, so "is there anything to ping?" cannot be answered until they have
  // been parsed.
  const settings = new Map(
    ((settingsResult.data ?? []) as { key: string; value: string }[]).map((s) => [s.key, s.value])
  );
  const defaultChannel = settings.get('session_ping_channel_id') ?? null;
  const leadRaw = Number(settings.get('session_ping_lead_minutes'));
  const leadMinutes = Number.isFinite(leadRaw) && leadRaw > 0 ? leadRaw : DEFAULT_LEAD_MINUTES;

  const selfRoleRows = (rolesResult.data ?? []) as {
    role_id: string;
    track: string;
    channel_id: string | null;
  }[];

  const settingsRoles: { role_id: string; track: string; channel_id: string | null }[] = [];
  for (const [track, key] of Object.entries(SETTINGS_PING_ROLES)) {
    const raw = settings.get(key);
    // An absent key is the normal case for a club that only runs one track, so
    // it passes quietly. A key that is PRESENT and unusable is a typo somebody
    // made in SQL and would otherwise show up as silence, so it is named.
    if (raw === undefined) continue;
    const roleId = raw.trim();
    if (!SNOWFLAKE.test(roleId)) {
      console.warn(
        `[discord] session-pings: discord_settings.${key} is not a role id (${raw}), skipping it`
      );
      continue;
    }
    // channel_id: null on purpose. There is no per-key channel, so every
    // settings-sourced role falls through to defaultChannel below.
    settingsRoles.push({ role_id: roleId, track, channel_id: null });
  }

  // SETTINGS WIN OUTRIGHT, and the two lists are deliberately NOT merged. A
  // club that has written the keys has said where its ping roles come from;
  // folding in whatever discord_self_roles happens to hold as well would ping a
  // role nobody asked to be pinged and there would be no way to turn it off
  // short of editing rows that exist for the picker, not for this.
  const pingRoles = settingsRoles.length > 0 ? settingsRoles : selfRoleRows;

  // Says so out loud, because this is the shape the feature fails in, and it is
  // how the feature actually shipped: BOTH sources can be empty at once. A ping
  // role exists in Discord long before it exists HERE, since Discord's
  // Onboarding screen hands a role out without writing anything to this
  // database, and /rolepicker writes a row without giving it a `track`. So
  // nothing can be pinged unless either an exec has set one of the
  // session_ping_*_role_id keys in SQL or a discord_self_roles row has been
  // given a track by the UPDATE in 00168. With neither, this returns an empty
  // list and the cron records a clean success having pinged nobody, which is
  // indistinguishable from a quiet week.
  if (pingRoles.length === 0) {
    console.warn(
      `[discord] session-pings: nothing can be pinged for guild ${guildId}. None of the three session_ping_*_role_id keys in discord_settings holds a valid role id, and no discord_self_roles row for the guild has a track. The cron will record a clean success having pinged nobody, which is indistinguishable from a quiet week.`
    );
    return NextResponse.json({ pings: [] });
  }

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

    // ONE ROLE ID AT MOST ONCE PER SESSION, and per SESSION rather than per
    // channel, because (session_id, role_id) is the idempotency key.
    //
    // The settings path makes a repeated role id representable for the first
    // time: a club with a single ping role sets all three
    // session_ping_*_role_id keys to the same id, so a club-wide night matches
    // that id three times over. Without this, the id lands in `roleIds` three
    // times, the bot renders the same mention three times in one message, and
    // the POST that records the ping sends three identical
    // (session_id, role_id) rows in ONE upsert statement, which Postgres
    // rejects with 21000 "ON CONFLICT DO UPDATE command cannot affect row a
    // second time". The ping posts, fails to record, and posts again every five
    // minutes until the lateness window closes.
    //
    // discord_self_roles could not express this: its primary key is
    // (guild_id, role_id), so the same role appearing twice in one guild was
    // unrepresentable, which is why no test predating the settings path covers
    // it.
    const emitted = new Set<string>();

    for (const role of pingRoles) {
      // An 'all' session pings every configured ping role — a club-wide night is
      // for everybody, so anyone who asked to hear about nights hears about it.
      // Otherwise the tracks must match exactly.
      if (session.track !== 'all' && role.track !== session.track) continue;
      if (sent.has(`${session.id}:${role.role_id}`)) continue;
      if (emitted.has(role.role_id)) continue;

      const channelId = role.channel_id ?? defaultChannel;
      // No channel configured anywhere means this role cannot be pinged. Skip
      // rather than erroring the whole run: one unconfigured role must not stop
      // the others going out.
      if (!channelId) continue;

      emitted.add(role.role_id);
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
