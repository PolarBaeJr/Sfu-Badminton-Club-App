import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import {
  sendAccountInactiveEmail,
  isSelfReactivatable,
  INACTIVITY_DAYS,
  INACTIVITY_PURGE_DAYS,
} from '@badminton/shared';

export const dynamic = 'force-dynamic';

// "Your membership is now inactive" — the notice the club owner asked for.
//
// WHY IT LIVES HERE AND NOT IN THE JOB THAT DEACTIVATES PEOPLE.
// mark-inactive-players is a Deno edge function. Deno cannot import the npm
// workspace (see supabase/functions/DEPLOY.md), so it cannot reach
// packages/shared/src/email/sender.ts and with it the suppression list, the
// preference check and the RFC 8058 unsubscribe headers. No edge function in
// this repo sends mail; the established pattern for scheduled mail is a route
// here driven by pg_cron, exactly like weekly-digest. Rebuilding the
// suppression gate inside Deno to avoid one extra job would be the worst
// possible trade: a second copy of the one check that must never be skipped.
//
// Decoupling it also means this covers BOTH ways a member goes inactive — the
// nightly job and an admin choosing "Inactive" in the console — without either
// of them knowing about email.
//
// IDEMPOTENCY. players.inactivity_notice_sent_at (00059). The nightly job
// re-evaluates the same rows every night, so "is inactive" cannot be the
// trigger; and "a member only ever transitions once" is false, because
// restore-then-lapse is real and deserves a second notice. Every path that
// puts someone back on the roster clears the stamp.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    const { data: setting } = await admin
      .from('platform_settings')
      .select('value')
      .eq('key', 'inactivity_rules')
      .maybeSingle();
    const thresholdDays: number =
      (setting?.value as Record<string, number> | null)?.inactive_threshold_days ?? INACTIVITY_DAYS;
    // The retention period the email now promises. Read from the SAME settings
    // row the purge job reads, so the copy cannot state a deadline the job does
    // not enforce — an exec changing one changes both.
    const purgeAfterDays: number =
      (setting?.value as Record<string, number> | null)?.purge_after_days ?? INACTIVITY_PURGE_DAYS;

    // Deactivated and not yet told. status / is_banned / deletion_requested_at
    // come back so isSelfReactivatable can do the discrimination below rather
    // than this query growing its own copy of it.
    const { data: candidates, error } = await admin
      .from('players')
      .select('id, full_name, email, active_flag, status, is_banned, deletion_requested_at')
      .eq('active_flag', false)
      .is('inactivity_notice_sent_at', null);
    if (error) throw new Error(error.message);

    // THE SAME PREDICATE THE REACTIVATION USES, and deliberately not a second
    // copy of it. Three different things clear active_flag and only one of them
    // is a lapse:
    //
    //   removePlayer      status='suspended'         — an admin removed them.
    //                     Telling them "sign in and you're back" would be a lie
    //                     and would read as the club undoing its own decision.
    //   deleteMyAccount   deletion_requested_at set  — they asked to be
    //                     deleted. They already got that flow; a notice about
    //                     inactivity here is duplicative at best.
    //   the nightly job   neither                    — this is the one.
    //
    // A banned member is excluded for the same reason as a removed one. The
    // upstream job no longer marks either of them inactive, but a row that
    // predates that fix, or one banned after being deactivated, still lands
    // here — so the filter is applied at the send, not assumed upstream.
    const lapsed = (candidates ?? []).filter((p) => isSelfReactivatable(p) && p.email);

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const player of lapsed) {
      // Sequential, same reasoning as weekly-digest: a burst of parallel sends
      // against a fresh sender reputation is the shape that gets throttled.
      const outcome = await sendAccountInactiveEmail(
        player.email as string,
        (player.full_name as string) || 'there',
        thresholdDays,
        purgeAfterDays,
      ).catch((err) => {
        Sentry.captureException(err, {
          extra: { job: 'inactivity-notices', playerId: player.id },
        });
        return null;
      });

      if (!outcome) {
        // A genuine delivery failure. The stamp is NOT written, so the next run
        // retries — which is the right way round for a transient provider
        // error, and harmless for a permanent one because a hard bounce lands
        // the address on email_suppressions and the retry then resolves to
        // 'suppressed' below.
        failed += 1;
        continue;
      }

      // Stamped on 'suppressed' and 'opted_out' as well as on a real send. The
      // column records "this lapse has been dealt with", not "Resend accepted
      // it" — leaving a suppressed address unstamped would re-attempt it every
      // single night forever.
      const { error: stampError } = await admin
        .from('players')
        .update({ inactivity_notice_sent_at: new Date().toISOString() })
        .eq('id', player.id)
        // Only if they are still inactive. If they signed in during this run,
        // reactivateLapsedMember has already put active_flag back and cleared
        // the stamp; re-stamping would suppress a future genuine notice.
        .eq('active_flag', false);
      if (stampError) {
        // Must be loud: an unstamped row is a row this job will mail again
        // tomorrow, and repeat mail to a lapsed member is how a sender earns
        // complaints.
        Sentry.captureException(new Error(`Inactivity notice stamp failed: ${stampError.message}`), {
          extra: { job: 'inactivity-notices', playerId: player.id },
        });
      }

      if (outcome.sent) sent += 1;
      else skipped += 1;
    }

    return NextResponse.json({
      ran_at: new Date().toISOString(),
      candidates: candidates?.length ?? 0,
      eligible: lapsed.length,
      sent,
      skipped,
      failed,
    });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'inactivity-notices' } });
    return NextResponse.json({ error: 'Inactivity notice job failed' }, { status: 500 });
  }
}
