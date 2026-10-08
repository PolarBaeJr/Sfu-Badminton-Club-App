// Stops a daily job re-notifying about the same record forever.
//
// THE PROBLEM. `send-stale-confirmation-alerts` and the overdue branch of
// `send-challenge-reminders` both select "records in a bad state", insert a
// notification row per (recipient × record) and issue a push, unconditionally,
// every day. Neither has a dedup key, and neither of the underlying states
// clears on a timer — a match sits in `pending_confirmation` until a member
// confirms or disputes it, and an accepted challenge sits unplayed until
// somebody plays or cancels it. So one member dropping out of the club means
// every admin gets the same alert, with a push, every morning, indefinitely.
// The predictable response is to turn the whole category off, which also kills
// the dispute and result alerts the club actually runs on.
//
// THE LEDGER. `notifications` already records every alert this app has ever
// sent, with `type`, `title`, `created_at` and a `metadata` blob that carries
// the record's id. That is a dedup key that already exists and is already
// deployed — so this reads it rather than adding a column.
//
// The alternative, and the better long-term shape, is a stamp on the record
// itself: `matches.stale_alert_sent_at`, `challenges.overdue_reminder_sent_at`,
// or one `notification_dedup(key text primary key, sent_at timestamptz)` table
// covering all of them. That matches the two jobs in this tree that DO get
// idempotency right (`session_rsvp.reminded_at`,
// `players.inactivity_notice_sent_at`) and it is a single indexed lookup rather
// than a scan of recent rows. It needs a migration, which is not written here.
// Until then this closes the bug with what is already on production, and the
// volume it scans is one alert-typed row per record per week.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * How long an alert about one record suppresses the next one.
 *
 * Not "never again": a stale confirmation and an unplayed challenge are both
 * work somebody has to do, and an alert that fires once and then goes quiet
 * forever is a to-do list that empties itself. Seven days turns "every admin,
 * every morning, forever" into a weekly nudge — about four a month instead of
 * thirty — which is a volume people keep switched on.
 */
export const RE_ALERT_DAYS = 7;

/** Cap on the ledger read. Well past a week of alerts at any club size, and it
 *  keeps a runaway from turning into an unbounded scan. PostgREST would cap it
 *  at 1000 anyway; saying so here makes the bound intentional rather than
 *  inherited. */
const LEDGER_LIMIT = 1000;

/**
 * The ids this job has already alerted about inside the window.
 *
 * Returns `null` when the ledger read FAILS, which callers must treat as
 * "do not send". A failed PostgREST read arrives as an empty list rather than
 * an exception, so a helper that returned an empty Set here would look exactly
 * like "nothing has been alerted yet" and re-notify the entire backlog — the
 * bug, triggered by the fix for the bug.
 */
export async function alreadyAlertedIds(
  supabase: SupabaseClient,
  opts: { type: string; title: string; metadataKey: string; withinDays?: number },
): Promise<Set<string> | null> {
  const since = new Date(
    Date.now() - (opts.withinDays ?? RE_ALERT_DAYS) * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Filtered on type AND title: `type` is a coarse enum ('admin_alert',
  // 'general') that several unrelated notifiers share, so matching on it alone
  // would let a no-show alert suppress a stale-confirmation one.
  //
  // The ORDER is load-bearing, not cosmetic. PostgREST emits an unordered
  // SELECT without it, so a `.limit()` past the cap would return an arbitrary
  // thousand rows and everything outside that arbitrary slice would be
  // re-alerted. Newest-first makes the truncation "the most recent thousand",
  // which is the only direction a recency window can safely lose rows in.
  const { data, error } = await supabase
    .from('notifications')
    .select('metadata')
    .eq('type', opts.type)
    .eq('title', opts.title)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(LEDGER_LIMIT);

  if (error) {
    console.error('dedup: could not read the notification ledger:', error.message);
    return null;
  }

  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
    const id = row.metadata?.[opts.metadataKey];
    if (typeof id === 'string') seen.add(id);
  }
  return seen;
}
