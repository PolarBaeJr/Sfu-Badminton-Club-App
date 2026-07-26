import { NextResponse } from 'next/server';
import {
  CLUB_TIMEZONE,
  buildICSCalendar,
  getClientIp,
  rateLimit,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';
import { getCheckinSettings } from '@/lib/checkin-settings';

// Next 14 caches GET route handlers by default; the feed must always reflect
// the current schedule (and the token check must always run).
export const dynamic = 'force-dynamic';

// Per-player ICS subscription feed. Calendar clients can't log in, so the
// unguessable token in the URL is the credential — every miss (bad shape,
// unknown token, banned/deactivated player) is a uniform 404. Suspended
// players keep their feed: the track filter naturally limits what they see.
export async function GET(
  request: Request,
  { params }: { params: { token: string } }
) {
  // Rate limit: 30 feed fetches per IP per minute (calendar apps poll hourly;
  // this only throttles token enumeration).
  const rl = rateLimit(`cal-feed:${getClientIp(request)}`, 30, 60_000);
  if (!rl.success) {
    return new NextResponse('Too many requests', { status: 429 });
  }

  // 48 hex chars = randomBytes(24).toString('hex') from the token actions.
  if (!/^[0-9a-f]{48}$/.test(params.token)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const supabase = createServiceRoleClient();

  const { data: tokenRow } = await supabase
    .from('calendar_feed_tokens')
    .select('player_id')
    .eq('token', params.token)
    .maybeSingle();
  if (!tokenRow) {
    return new NextResponse('Not found', { status: 404 });
  }

  const { data: player } = await supabase
    .from('players')
    .select('status, active_flag, is_banned')
    .eq('id', tokenRow.player_id)
    .maybeSingle();
  if (!player || player.is_banned || !player.active_flag) {
    return new NextResponse('Not found', { status: 404 });
  }

  // All future sessions plus the past 60 days (club-local today), capped at
  // 200 events. Same track filter as the sessions page.
  const todayClub = new Date().toLocaleDateString('en-CA', { timeZone: CLUB_TIMEZONE });
  const [y, m, d] = todayClub.split('-').map(Number) as [number, number, number];
  const cutoff = new Date(Date.UTC(y, m - 1, d - 60)).toISOString().slice(0, 10);

  const { data: sessions } = await supabase
    .from('sessions')
    .select('id, name, date, start_time, end_time, location, notes, updated_at')
    .in('status', ['open', 'closed'])
    .in('track', [player.status, 'all'])
    .gte('date', cutoff)
    .order('date')
    .limit(200);

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
