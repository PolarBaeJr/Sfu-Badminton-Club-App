import { NextResponse } from 'next/server';
import { CLUB_TIMEZONE, getClientIp, rateLimit } from '@badminton/shared';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { onVisibleTracks } from '@/lib/session-track-filter';
import {
  discordServiceUnauthorized,
  isAuthorizedDiscordService,
} from '@/lib/discord-service-auth';

export const dynamic = 'force-dynamic';

// YYYY-MM-DD in club time. en-CA formats as ISO, which is what `date` stores.
function clubLocalToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
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
// Phase 1 has no link, so there is no player status to filter by and every track
// is visible. That is not a hole: visibleTracksFor(null) deliberately returns the
// whole schedule, and the app already treats the schedule as public to members
// (`sessions_select USING TRUE`) — what a suspended member loses is the CONTROLS,
// not the information. When the link lands in phase 2, pass the linked player's
// status here and the filter narrows on its own.
export async function GET(request: Request) {
  if (!isAuthorizedDiscordService(request)) return discordServiceUnauthorized();

  const ip = getClientIp(request);
  const limited = rateLimit(`discord:sessions:${ip}`, 60, 60_000);
  if (!limited.success) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

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

  const { data: sessions, error } = await onVisibleTracks(query, null);

  if (error) {
    Sentry.captureException(error, { extra: { route: 'discord/sessions' } });
    return NextResponse.json({ error: 'sessions_unavailable' }, { status: 502 });
  }

  const rows = sessions ?? [];
  if (rows.length === 0) return NextResponse.json({ sessions: [] });

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
