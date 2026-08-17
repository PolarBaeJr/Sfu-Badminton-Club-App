// Runs daily via cron
// Notifies players of challenges awaiting their response (accepted but unplayed, past agreed date)

import { requireCronSecret } from '../_shared/auth.ts';
import { createServiceClient, jsonResponse } from '../_shared/client.ts';
import { sendPushToPlayers } from '../_shared/push.ts';
import { alreadyAlertedIds, RE_ALERT_DAYS } from '../_shared/dedup.ts';

const OVERDUE_TITLE = 'Unplayed Challenge';
const EXPIRING_TITLE = 'Challenge Expiring Soon';

/**
 * How far ahead the expiring-soon branch looks — and it MUST match the interval
 * this job actually runs at.
 *
 * It was 12 hours on a once-a-day schedule, which silently dropped about half
 * of all expiring challenges: one expiring 20 hours after the 09:00 run was
 * outside the window, and by the next morning it had already expired and fallen
 * out of the proposed/partially_confirmed filter. Nobody was warned and nothing
 * recorded that nobody was warned.
 *
 * 24 hours is the fix rather than a six-hourly schedule, for two reasons. The
 * schedule lives on the Pi's host crontab and not in this repo, so a change
 * here cannot enforce it. And running four times a day with no dedup key would
 * turn one warning into four — trading a missed reminder for exactly the repeat
 * bug the overdue branch below has just had fixed. A 24-hour window on a daily
 * run covers disjoint spans of time, so it dedups itself.
 *
 * If the crontab entry is ever changed, this constant has to change with it.
 */
const EXPIRY_WINDOW_HOURS = 24;

Deno.serve(async (req) => {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const supabase = createServiceClient();

  // Find accepted challenges with a scheduled_date that has passed
  const { data: overdue, error } = await supabase
    .from('challenges')
    .select('id, created_by, scheduled_date, challenge_participants(player_id, role)')
    .eq('status', 'accepted')
    .lt('scheduled_date', new Date().toISOString().split('T')[0])
    .not('scheduled_date', 'is', null);

  if (error) {
    console.error('send-challenge-reminders error:', error);
    return jsonResponse({ error: error.message }, 500);
  }

  // Find pending challenges (proposed/partially_confirmed) expiring inside the
  // window this job's schedule can actually cover — see EXPIRY_WINDOW_HOURS.
  const soon = new Date(Date.now() + EXPIRY_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const { data: expiringSoon, error: expiringError } = await supabase
    .from('challenges')
    .select('id, created_by, expires_at, challenge_participants(player_id, confirmation_status)')
    .in('status', ['proposed', 'partially_confirmed'])
    .lt('expires_at', soon)
    .gt('expires_at', new Date().toISOString());

  // The error used to be destructured away. A failed PostgREST read comes back
  // as an empty list rather than an exception, so a broken read here was
  // indistinguishable from "nothing is expiring" — forever, with nothing
  // logged anywhere.
  if (expiringError) {
    console.error('send-challenge-reminders expiring query error:', expiringError);
    return jsonResponse({ error: expiringError.message }, 500);
  }

  let notifCount = 0;

  // Remind participants of overdue accepted challenges — but only about ones
  // not already reminded this week. An accepted challenge stays `accepted`
  // until somebody plays or cancels it, so without a dedup key this sent both
  // participants a row and a push about the same challenge every morning until
  // one of them acted. See _shared/dedup.ts.
  //
  // The ledger is only read when there IS overdue work, and a failure to read
  // it skips this branch rather than aborting the function: the expiring-soon
  // branch below has its own dedup (a disjoint window) and no reason to be
  // silenced by a fault in this one.
  let ledgerUnavailable = false;
  const remindedRecently = (overdue ?? []).length > 0
    ? await alreadyAlertedIds(supabase, {
        type: 'general',
        title: OVERDUE_TITLE,
        metadataKey: 'challenge_id',
      })
    : new Set<string>();
  if (!remindedRecently) {
    // Fail closed, same reasoning as the stale-confirmation job: not knowing
    // what has already gone out is not a reason to send it all again. Every one
    // of these has been reminded about at least once already.
    ledgerUnavailable = true;
  }

  const typedOverdue = ledgerUnavailable
    ? []
    : ((overdue ?? []) as Array<{
        id: string;
        challenge_participants: Array<{ player_id: string; role: string }>;
      }>).filter((c) => !remindedRecently!.has(c.id));

  if (typedOverdue.length > 0) {
    const reminders = typedOverdue.flatMap((c) =>
      c.challenge_participants.map((cp) => ({
        player_id: cp.player_id,
        type: 'general',
        title: OVERDUE_TITLE,
        body: 'You have an accepted challenge that is past its scheduled date. Please play it or cancel.',
        metadata: { challenge_id: c.id },
      }))
    );
    if (reminders.length > 0) {
      // Before the pushes: the insert is the dedup key the next run reads.
      const { error: insertError } = await supabase.from('notifications').insert(reminders);
      if (insertError) {
        console.error('send-challenge-reminders insert failed:', insertError.message);
        return jsonResponse({ error: insertError.message }, 500);
      }
      notifCount += reminders.length;

      for (const c of typedOverdue) {
        await sendPushToPlayers(
          supabase,
          c.challenge_participants.map((cp) => cp.player_id),
          {
            title: OVERDUE_TITLE,
            body: 'You have an accepted challenge that is past its scheduled date. Please play it or cancel.',
            url: `/challenges/${c.id}`,
          },
          'challenges'
        );
      }
    }
  }

  // Remind pending participants of challenges expiring soon
  if (expiringSoon && expiringSoon.length > 0) {
    const typedExpiring = expiringSoon as Array<{
      id: string;
      challenge_participants: Array<{ player_id: string; confirmation_status: string }>;
    }>;
    // The copy states the window, so it moves with EXPIRY_WINDOW_HOURS. It said
    // "12 hours" while the query looked 12 hours ahead; widening one without
    // the other would make the mail lie to the member about their deadline.
    const expiringBody =
      `A challenge awaiting your response expires in less than ${EXPIRY_WINDOW_HOURS} hours.`;
    const urgentReminders = typedExpiring.flatMap((c) =>
      c.challenge_participants
        .filter((cp) => cp.confirmation_status === 'pending')
        .map((cp) => ({
          player_id: cp.player_id,
          type: 'challenge_received',
          title: EXPIRING_TITLE,
          body: expiringBody,
          metadata: { challenge_id: c.id },
        }))
    );
    // No dedup key on this branch ON PURPOSE. The window is exactly the run
    // interval, so consecutive runs cover disjoint spans of time and a
    // challenge can only fall inside one of them — and the record leaves the
    // proposed/partially_confirmed filter the moment it expires. Adding a
    // ledger read here would suppress nothing and cost a query.
    if (urgentReminders.length > 0) {
      const { error: insertError } = await supabase.from('notifications').insert(urgentReminders);
      if (insertError) {
        console.error('send-challenge-reminders insert failed:', insertError.message);
        return jsonResponse({ error: insertError.message }, 500);
      }
      notifCount += urgentReminders.length;

      for (const c of typedExpiring) {
        const pendingIds = c.challenge_participants
          .filter((cp) => cp.confirmation_status === 'pending')
          .map((cp) => cp.player_id);
        await sendPushToPlayers(supabase, pendingIds, {
          title: EXPIRING_TITLE,
          body: expiringBody,
          url: `/challenges/${c.id}`,
        }, 'challenges');
      }
    }
  }

  console.log(
    `Sent ${notifCount} challenge reminders ` +
      `(overdue ones already reminded within ${RE_ALERT_DAYS} days were skipped)`
  );
  // Reported as a failure so the status is at least true, even though the Pi's
  // crontab currently discards it — the expiring-soon reminders above did go
  // out, and the overdue ones did not.
  if (ledgerUnavailable) {
    return jsonResponse(
      { notifications_sent: notifCount, error: 'Could not read the notification ledger; overdue reminders skipped' },
      500,
    );
  }
  return jsonResponse({ notifications_sent: notifCount });
});
