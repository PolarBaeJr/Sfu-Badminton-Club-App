import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { remindSessionGoers } from '@/lib/session-reminders';

export const dynamic = 'force-dynamic';

// Reminds everyone who RSVP'd "going" to a session happening today. Called by
// pg_cron (migration 00033) rather than by a person, so it authenticates with a
// shared secret instead of a session.
//
// Why an HTTP endpoint at all: web push is signed with the VAPID private key,
// which only this Node process holds — Postgres cannot send a notification
// itself. pg_cron/pg_net just poke this route on a schedule.
//
// The job runs hourly rather than once at a fixed time, which sidesteps
// daylight-saving entirely: whichever run first sees a session dated today
// sends the reminder, and reminder_sent_at makes every later run that day a
// no-op. That column is also what stops a retry double-notifying everyone.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed: without a configured secret the route is unauthenticated.
    return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    // "Today" in club time, not UTC — a session on the 5th should be reminded
    // on the 5th in Vancouver, regardless of where the server thinks it is.
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Vancouver',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const { data: sessions, error } = await admin
      .from('sessions')
      .select('id')
      .eq('date', today)
      .eq('status', 'open')
      .is('reminder_sent_at', null);
    if (error) throw new Error(error.message);

    const results: { session_id: string; notified: number }[] = [];
    for (const s of sessions ?? []) {
      // Stamp first: if the send throws halfway, a retry must not notify the
      // players who already received it. Under-notifying beats double-notifying.
      const { error: stampErr } = await admin
        .from('sessions')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', s.id)
        .is('reminder_sent_at', null);
      if (stampErr) continue; // another run claimed it

      const { notified } = await remindSessionGoers(s.id, null);
      results.push({ session_id: s.id, notified });
    }

    return NextResponse.json({ date: today, sessions: results.length, results });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'session-reminders' } });
    return NextResponse.json({ error: 'Reminder job failed' }, { status: 500 });
  }
}
