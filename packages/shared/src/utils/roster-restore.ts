// PUTTING SOMEBODY BACK ON THE ACTIVE ROSTER IS FIVE COLUMNS, NOT ONE.
//
// `active_flag: true` is the visible half. The other four are what stop the
// overnight jobs from immediately undoing it, and they were written out by hand
// at four call sites — of which exactly one, reactivateLapsedMember, had all of
// them. The other three restored a member who was then quietly re-deactivated
// on the next nightly run and emailed "your membership is now inactive".
//
// WHY last_active_at IS LOAD-BEARING. mark-inactive-players selects on
// `active_flag = true AND last_active_at < cutoff` (plus status/ban/deletion
// filters). A restore that leaves last_active_at 120+ days stale therefore puts
// the member straight back into that job's result set: active_flag flips back
// to false the same night, and because the restore also cleared the notice
// stamp, the retention email is re-armed and sent again. Every night, for one
// restore. reactivateLapsedMember documents this at length and has bumped the
// column since it was written; the console and self-service paths never did.
//
// The other two are documented at their own migrations: clearing
// inactivity_notice_sent_at re-arms the notice for a FUTURE lapse (00059 — a
// member who lapses twice should be told twice), and clearing inactive_since
// stops the retention clock (00062), without which a member visibly back on the
// roster is still anonymised on the original schedule.
//
// It is one object rather than four copies for the same reason quoteEntryFee is
// one function: a set of columns that must move together is a rule, and a rule
// spelled out at each call site is a rule that only holds until the next call
// site is added.

/** Every column a restore has to write, so no caller can write only some. */
export interface RosterRestoreColumns {
  active_flag: true;
  last_active_at: string;
  inactivity_notice_sent_at: null;
  inactive_since: null;
  updated_at: string;
}

/**
 * @param nowISO the single clock reading for the whole write, so `last_active_at`
 *   and `updated_at` cannot disagree by a round trip.
 */
export function rosterRestoreColumns(nowISO: string): RosterRestoreColumns {
  return {
    active_flag: true,
    last_active_at: nowISO,
    inactivity_notice_sent_at: null,
    inactive_since: null,
    updated_at: nowISO,
  };
}
