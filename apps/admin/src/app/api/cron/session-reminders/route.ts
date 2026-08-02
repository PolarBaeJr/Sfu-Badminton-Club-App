import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { remindSessionGoers } from '@/lib/session-reminders';
import { getReminderLeadMinutes, REMINDER_LEAD_MAX_MINUTES } from '@badminton/shared';

export const dynamic = 'force-dynamic';

const CLUB_TZ = 'America/Vancouver';

// sessions.date is a DATE and start_time a TIME, both meaning club-local wall
// clock. Comparing them to "now" needs the real UTC instant, and the offset
// changes with daylight saving — so resolve it for that specific date rather
// than assuming a fixed -7/-8.
//
// The trick: read the naive stamp as if it were UTC, ask Intl what that instant
// looks like in the club's zone, and the difference is the offset to subtract.
function clubTimeToUtc(date: string, time: string): Date {
  const naive = new Date(`${date}T${time.slice(0, 8).padEnd(8, ':00')}Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(naive).reduce<Record<string, number>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const g = (k: string) => parts[k] ?? 0;
  const asZone = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return new Date(naive.getTime() - (asZone - naive.getTime()));
}

// Reminds each player who RSVP'd "going" the interval before start that THEY
// chose (default two hours). Called by pg_cron every 5 minutes.
//
// Why an HTTP endpoint: web push is signed with the VAPID private key, which
// only this Node process holds — Postgres cannot send a notification itself.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const now = new Date();

    // The scan window has to reach as far ahead as the longest notice anyone
    // can ask for, or that preference is quietly capped: a session outside the
    // window is invisible until it drifts in, by which point the lead has
    // already passed and the player is reminded late. Members may choose up to
    // a week, so look a week (plus a day, for the club-vs-UTC boundary) ahead.
    // Sessions not yet due cost one row each — the per-player check below is
    // what actually decides when to send.
    const clubDate = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: CLUB_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(d);
    const horizonDays = Math.ceil(REMINDER_LEAD_MAX_MINUTES / 1440) + 1;

    const { data: sessions, error } = await admin
      .from('sessions')
      .select('id, date, start_time, session_rsvp(player_id, reminded_at, intent)')
      .gte('date', clubDate(now))
      .lte('date', clubDate(new Date(now.getTime() + horizonDays * 86400000)))
      .eq('status', 'open');
    if (error) throw new Error(error.message);

    const results: { session_id: string; notified: number }[] = [];

    for (const s of sessions ?? []) {
      // No start time means no window to work back from; those still get the
      // manual button.
      if (!s.start_time) continue;
      const start = clubTimeToUtc(s.date as string, s.start_time as string);
      if (start.getTime() <= now.getTime()) continue; // already under way

      const rsvps = (s.session_rsvp ?? []) as { player_id: string; reminded_at: string | null; intent: string }[];
      const pending = rsvps.filter((r) => r.intent === 'going' && !r.reminded_at);
      if (pending.length === 0) continue;

      const { data: prefs } = await admin
        .from('players')
        .select('id, notification_preferences')
        .in('id', pending.map((r) => r.player_id));

      const due = pending.filter((r) => {
        const lead = getReminderLeadMinutes(
          prefs?.find((p) => p.id === r.player_id)?.notification_preferences);
        return now.getTime() >= start.getTime() - lead * 60_000;
      });
      if (due.length === 0) continue;

      // Claim before sending: if the send throws, a retry must skip these
      // players rather than notify them twice.
      const { data: claimed } = await admin
        .from('session_rsvp')
        .update({ reminded_at: now.toISOString() })
        .eq('session_id', s.id)
        .in('player_id', due.map((r) => r.player_id))
        .is('reminded_at', null)
        .select('player_id');

      const ids = (claimed ?? []).map((c) => c.player_id);
      if (ids.length === 0) continue;

      const { notified } = await remindSessionGoers(s.id as string, null, ids);
      results.push({ session_id: s.id as string, notified });
    }

    return NextResponse.json({ ran_at: now.toISOString(), sessions: results.length, results });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'session-reminders' } });
    return NextResponse.json({ error: 'Reminder job failed' }, { status: 500 });
  }
}
