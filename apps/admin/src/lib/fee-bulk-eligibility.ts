// Which of a selection a fee button can actually act on.
//
// A PLAIN MODULE, for the reason lib/session-patch.ts is one: the bars that use
// this are client components and the console's tests run in `environment: 'node'`
// with no DOM, so a rule left inside the .tsx would be a rule nothing checks.
//
// THE PROBLEM THIS ANSWERS. One fee page has one selection and three buttons
// with three different eligible states — Mark Paid and Waive want an unpaid row,
// Mark Unpaid wants a paid or waived one. So a selection of nine rows is not
// nine rows for every button, and a dialog that says "9" over an action that
// will touch 4 of them is a number the officer cannot check.
//
// WHAT THIS IS FOR, AND THE TWO THINGS ONLY. (a) the confirm dialog says how
// many of the N selected rows the action will apply to, and (b) a button is
// disabled when none of the selection is eligible.
//
// IT IS NEVER USED TO FILTER THE IDS THAT ARE SENT. The map is a snapshot of one
// server render; by the time the loop reaches the tenth row another desk may have
// taken a payment. Filtering on it would silently drop exactly the rows it is
// wrong about, whereas the server's refusals are per record, named and current —
// and every ineligible state now refuses loudly rather than quietly no-op'ing
// (e6f71300 for the dues side, the matching markTournamentFeeUnpaid fix for the
// entry-fee side). Before those, a bulk Waive over a stale selection would have
// restamped waivers and a bulk Mark Unpaid would have written vacuous audit rows.

/** What a row reads as, from the same paid/waived flags the row renders from. */
export type FeeRowState = 'paid' | 'waived' | 'unpaid';

export type FeeBulkAction = 'markPaid' | 'waive' | 'markUnpaid';

// The states each action's single-record twin will accept. Mark Paid and Waive
// are both refused over a row that already carries a paid_at, waiver included;
// Mark Unpaid is the reversal of either.
const ELIGIBLE_STATES: Record<FeeBulkAction, readonly FeeRowState[]> = {
  markPaid: ['unpaid'],
  waive: ['unpaid'],
  markUnpaid: ['paid', 'waived'],
};

/**
 * How many of `ids` this action will actually apply to.
 *
 * AN ID THE MAP DOES NOT KNOW COUNTS AS ELIGIBLE. Absent is not the same as
 * ineligible: a row the page no longer holds, or one added since, is a row this
 * snapshot has no opinion about, and reading silence as "no" would grey out a
 * button over rows that are perfectly actionable — the same class of mistake as
 * filtering the ids.
 */
export function countEligible(
  ids: readonly string[],
  states: Readonly<Record<string, FeeRowState>>,
  action: FeeBulkAction,
): number {
  const eligible = ELIGIBLE_STATES[action];
  return ids.reduce((n, id) => {
    const state = states[id];
    if (state === undefined) return n + 1;
    return eligible.includes(state) ? n + 1 : n;
  }, 0);
}
