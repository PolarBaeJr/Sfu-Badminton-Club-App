import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { remindSessionGoers } from '@/lib/session-reminders';
import {
  getReminderLeadMinutes,
  REMINDER_LEAD_MAX_MINUTES,
  CLUB_TIMEZONE,
  wallClockToUtc,
  selectInChunks,
  chunkIds,
} from '@badminton/shared';

export const dynamic = 'force-dynamic';

const CLUB_TZ = CLUB_TIMEZONE;

// sessions.date is a DATE and start_time a TIME, both meaning club-local wall
// clock. Deciding whether a player's chosen lead time has come due needs the
// real UTC instant of that wall clock.
//
// This used to carry its own single-pass Intl converter. It does not any more,
// for a reason this job is uniquely exposed to: from 2026-11-01 British
// Columbia stops changing its clocks (tzdata 2026b), and asking Intl on a Node
// that predates that release — production is Node 20, tzdata 2025c — returns an
// offset an hour off for every session past that date. Five are already
// booked. Every reminder for them would have gone out an hour late.
// wallClockToUtc pins that era to a literal offset instead of asking, so this
// is correct without waiting for a Node upgrade, and there is one
// implementation of the rule rather than two.
function clubTimeToUtc(date: string, time: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  return wallClockToUtc(y, mo, d, h, mi);
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

      // Chunked — one id per RSVP, and a popular session can hold the roster.
      const { data: prefs } = await selectInChunks<{
        id: string;
        notification_preferences: unknown;
      }>(pending.map((r) => r.player_id), (ids) =>
        admin.from('players').select('id, notification_preferences').in('id', ids) as never,
      );

      const due = pending.filter((r) => {
        const lead = getReminderLeadMinutes(
          prefs?.find((p) => p.id === r.player_id)?.notification_preferences);
        return now.getTime() >= start.getTime() - lead * 60_000;
      });
      if (due.length === 0) continue;

      // Claim before sending: if the send throws, a retry must skip these
      // players rather than notify them twice.
      //
      // Chunked, because an UPDATE's `.in()` filter is in the query string too.
      // Every property that makes this a real compare-and-swap survives the
      // split: `.is('reminded_at', null)` stays in each chunk's WHERE clause,
      // and each `.select('player_id')` returns only the rows THAT statement
      // won. Two concurrent ticks still cannot both claim a player; the claims
      // are simply committed a chunk at a time.
      const ids: string[] = [];
      for (const batch of chunkIds(due.map((r) => r.player_id))) {
        const { data: claimed } = await admin
          .from('session_rsvp')
          .update({ reminded_at: now.toISOString() })
          .eq('session_id', s.id)
          .in('player_id', batch)
          .is('reminded_at', null)
          .select('player_id');
        for (const c of claimed ?? []) ids.push(c.player_id as string);
      }
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
