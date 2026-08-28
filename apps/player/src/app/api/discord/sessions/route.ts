import { NextResponse } from 'next/server';
import { getClientIp, rateLimit, clubToday } from '@badminton/shared';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { onPublicTracks, onVisibleTracks } from '@/lib/session-track-filter';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// YYYY-MM-DD in club time. en-CA formats as ISO, which is what `date` stores.
function clubLocalToday(): string {
  // clubToday rather than asking Intl here: from 2026-11-01 BC is UTC-7
  // year-round (tzdata 2026b) and production Node predates that release, so
  // the answer would be an hour off — enough to cross midnight — for every
  // date past the cutover. One implementation, pinned.
  return clubToday();
}

const MAX_SESSIONS = 10;

// Upcoming sessions for the Discord bot.
//
// TRACK FILTERING GOES THROUGH onVisibleTracks AND MUST STAY THAT WAY.
// session-track-filter.ts is the only place in this app allowed to name `track`
// in a filter, and session-track-filter.test.ts greps apps/player/src to enforce
// exactly one occurrence. Naming that column in a PostgREST filter here would
// fail that test — which is the point: six call sites had already drifted
// independently before the rule existed. (The grep is deliberately crude enough
// to match a comment, so this one describes the forbidden call rather than
// spelling it out.)
//
// FILTERED PER CALLER, which is what the phase-1 version of this comment said
// would happen once linking landed. It has, so it does.
//
// The caller arrives as `x-discord-user-id` on a request already gated by the
// service secret. A HEADER RATHER THAN A QUERY PARAM on purpose: the kong access
// log records paths and query strings, and a Discord user id in there is a
// per-person identifier sitting in a log nobody thinks of as personal data.
//
// Three audiences, not two, which is the part worth reading twice:
//
//   linked + competitive/recreational -> that track plus club-wide. Identical
//       to what the website shows them. This is the reported bug: a rec member
//       was being shown competitive nights the site would never show them.
//   linked + pending_approval/suspended/unknown -> the whole schedule, via
//       visibleTracksFor's untracked default. NOT narrowed. session-track.ts
//       argues that case at length (the frosh-week signup who would otherwise
//       see an empty schedule) and it is still right; they are members.
//   unlinked -> club-wide nights only. See PUBLIC_TRACKS: the reasoning behind
//       the untracked-member default is scoped to `authenticated` viewers who
//       can read every session row anyway, and somebody who joined the Discord
//       without ever making an account is not one.
//
// The bot makes the reply ephemeral as well. Neither half is sufficient alone —
// filtering a message the whole channel can read changes nothing, and hiding an
// unfiltered message just moves the leak.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:sessions:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  // Who is asking. Absent for an unlinked caller, and absent is a real answer
  // here rather than a missing one, so it is not an error.
  const discordUserId = request.headers.get('x-discord-user-id');
  let status: string | null = null;
  let linked = false;

  if (discordUserId) {
    const { data, error: linkError } = await supabase
      .from('player_discord_links')
      .select('players!inner(status)')
      .eq('discord_user_id', discordUserId)
      .maybeSingle();

    if (linkError) {
      // FAIL CLOSED. A failed PostgREST read arrives as data:null with an error
      // rather than a throw, so without this branch a broken read would look
      // exactly like "not linked" — except the consequence of guessing wrong is
      // inverted from the usual one: guessing "not linked" narrows the schedule,
      // which is safe, while a bug in the other direction would widen it. Take
      // the safe reading, and report it so it does not stay invisible.
      Sentry.captureException(linkError, {
        extra: { route: 'discord/sessions', step: 'link-lookup' },
      });
    } else if (data) {
      linked = true;
      // Not generic over Database, so the embedded row is any. Annotated here.
      status = (data as unknown as { players: { status: string } }).players.status;
    }
  }

  const query = supabase
    .from('sessions')
    .select('id, name, date, start_time, end_time, starts_at, ends_at, location, status, track')
    .eq('status', 'open')
    // ends_at is GENERATED and is NULL for exactly one real case (00110): a
    // session with a start time and no end time, which closes at starts_at plus
    // the runtime default_duration_minutes. A bare .gte('ends_at', now) drops
    // every one of those from the schedule silently, which is the sort of
    // absence nobody reports as a bug. Rows that HAVE an end instant are still
    // filtered on it precisely; the rest fall back to the club-local date, the
    // same column the app's own check-in path filters on for the same reason.
    .or(`ends_at.gte.${new Date().toISOString()},and(ends_at.is.null,date.gte.${clubLocalToday()})`)
    .order('starts_at', { ascending: true })
    .limit(MAX_SESSIONS);

  const { data: sessions, error } = await (linked
    ? onVisibleTracks(query, status)
    : onPublicTracks(query));

  if (error) {
    Sentry.captureException(error, { extra: { route: 'discord/sessions' } });
    return NextResponse.json({ error: 'sessions_unavailable' }, { status: 502 });
  }

  const rows = sessions ?? [];
  // `linked` travels with the payload so the bot can tell an unlinked caller WHY
  // their list is short, instead of them seeing a thin schedule and concluding
  // the club has nothing on.
  if (rows.length === 0) return NextResponse.json({ sessions: [], linked });

  // Attendee counts come from the RPC rather than a join so the bot and the
  // website agree on what "going" counts as.
  const { data: counts, error: countError } = await supabase.rpc(
    'get_session_attendee_counts',
    { p_session_ids: rows.map((s) => s.id) }
  );

  if (countError) {
    // A missing count is cosmetic; the schedule is still worth returning. Report
    // it, degrade to null, and let the bot omit the number rather than 502 the
    // whole command over a subtotal.
    Sentry.captureException(countError, { extra: { route: 'discord/sessions' } });
  }

  // createServiceRoleClient() is not generic over Database, so .rpc() is `any`.
  // Annotate at the boundary rather than trusting the shape silently.
  const goingBySession = new Map<string, number>(
    ((counts ?? []) as { session_id: string; attendees: number }[]).map((c) => [
      c.session_id,
      c.attendees,
    ])
  );

  return NextResponse.json({
    linked,
    sessions: rows.map((s) => ({
      id: s.id,
      name: s.name,
      date: s.date,
      startTime: s.start_time,
      endTime: s.end_time,
      startsAt: s.starts_at,
      location: s.location,
      track: s.track,
      going: goingBySession.get(s.id) ?? null,
    })),
  });
}
