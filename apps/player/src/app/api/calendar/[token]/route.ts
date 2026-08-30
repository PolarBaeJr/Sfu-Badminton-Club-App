import { NextResponse } from 'next/server';
import {
  buildICSCalendar,
  clubToday,
} from '@badminton/shared';
import * as Sentry from '@sentry/nextjs';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { getCheckinSettings } from '@/lib/checkin-settings';
import { onVisibleTracks } from '@/lib/session-track-filter';

// Next 14 caches GET route handlers by default; the feed must always reflect
// the current schedule (and the token check must always run).
export const dynamic = 'force-dynamic';

// Per-player ICS subscription feed. Calendar clients can't log in, so the
// unguessable token in the URL is the credential — every miss (bad shape,
// unknown token, banned/deactivated player) is a uniform 404.
//
// SUSPENDED PLAYERS KEEP THEIR FEED, and this used to add "the track filter
// naturally limits what they see". IT NEVER DID. `suspended` is a
// `player_status` and `track` is a `session_group`, so that filter did not
// narrow the feed — it made Postgres refuse the query, and the `?? []` here
// turned the refusal into a valid, empty calendar. What actually limits a
// suspended member is nothing on this route: the schedule is public to every
// signed-in member (sessions_select USING TRUE), and standing withholds the
// CONTROLS rather than the information. visibleTracksFor now says that
// deliberately instead of by accident.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  // 48 hex chars = randomBytes(24).toString('hex') from the token actions.
  if (!/^[0-9a-f]{48}$/.test(token)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const supabase = createServiceRoleClient();

  const { data: tokenRow } = await supabase
    .from('calendar_feed_tokens')
    .select('player_id')
    .eq('token', token)
    .maybeSingle();
  if (!tokenRow) {
    return new NextResponse('Not found', { status: 404 });
  }

  // is_banned is not readable by `authenticated` after 00032, and this route is
  // token-authenticated with no user session anyway.
  const { data: player } = await createServiceRoleClient()
    .from('players')
    .select('status, active_flag, is_banned')
    .eq('id', tokenRow.player_id)
    .maybeSingle();
  if (!player || player.is_banned || !player.active_flag) {
    return new NextResponse('Not found', { status: 404 });
  }

  // All future sessions plus the past 60 days (club-local today), capped at
  // 200 events. Same track filter as the sessions page.
  // clubToday rather than asking Intl here: from 2026-11-01 BC is UTC-7
  // year-round (tzdata 2026b) and production Node predates that release, so
  // the answer would be an hour off — enough to cross midnight — for every
  // date past the cutover. One implementation, pinned.
  const todayClub = clubToday();
  const [y, m, d] = todayClub.split('-').map(Number) as [number, number, number];
  const cutoff = new Date(Date.UTC(y, m - 1, d - 60)).toISOString().slice(0, 10);

  const { data: sessions, error: sessionsError } = await onVisibleTracks(
    supabase
      .from('sessions')
      .select('id, name, date, start_time, end_time, location, notes, updated_at')
      .in('status', ['open', 'closed'])
      .gte('date', cutoff),
    player.status,
  )
    .order('date')
    .limit(200);

  // A REFUSED READ MUST NOT BECOME A VALID EMPTY CALENDAR, and this route is the
  // one place where that distinction outlives the request. The old `?? []` here
  // returned HTTP 200 with a well-formed, eventless ICS — so a subscriber's
  // calendar client accepted it, cached it for the 300 seconds below, and
  // REPLACED the events it already had. The member's phone then showed no club
  // nights at all, with nothing on any screen to say why.
  //
  // 503 instead: every calendar client treats a non-2xx as "could not refresh"
  // and keeps the last good copy, which is the honest answer to "I do not know
  // what your schedule is". This is the same class of bug as the empty /sessions
  // page — the track filter sending a `player_status` value into a
  // `session_group` column — but the failure PERSISTS after the request, which
  // is why this one is a status code and not a log line.
  if (sessionsError) {
    Sentry.captureException(new Error(sessionsError.message), {
      extra: { action: 'calendar:sessions', details: sessionsError.details },
    });
    return new NextResponse('Calendar temporarily unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // Same service-role client the feed already uses: this route has no user
  // session, so the settings read has to go through it.
  const checkinSettings = await getCheckinSettings(supabase);

  return new NextResponse(
    buildICSCalendar(sessions ?? [], {
      baseUrl: process.env.NEXT_PUBLIC_PLAYER_URL,
      settings: checkinSettings,
    }),
    {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="sfu-badminton.ics"',
        'Cache-Control': 'private, max-age=300',
      },
    }
  );
}
