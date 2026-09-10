'use server';

// One decision, applied to several records.
//
// EVERY FUNCTION HERE IS A LOOP OVER THE ORDINARY SINGLE-RECORD ACTION. Nothing
// in this file writes to the database, reads a row, or decides who may do what;
// it turns a list of ids into a list of calls and reports what came back. The
// reasoning — and what a batched UPDATE would have cost — is in lib/bulk.ts.
//
// THE OUTER GATE IS NOT A SECOND ENFORCEMENT POINT, and it is worth saying why
// it is here at all. It names the SAME capability the looped action names, one
// constant, so there is no second answer to "who may do this" and no way for the
// two to drift. What it buys is the refusal: without it, an officer who does not
// hold the capability gets twenty-five identical failures and twenty-five
// pointless authentications, instead of one sentence telling them what they
// needed. The per-record gate below is still the one that protects the write.

import {
  approvePlayer,
  updatePlayer,
} from './players';
import { archiveSession, deleteSession, patchSession } from './sessions';
import { markFeePaid, markFeeUnpaid, waiveFee } from './fees';
import { markTournamentFeePaid, markTournamentFeeUnpaid } from './tournament-fees';
import { requireCapability } from './_shared';
import { runAction, type ActionResult } from '../action-result';
import { normalizeBulkIds, runBulk, type BulkOutcome } from '../bulk';
import type { AdminPlayerUpdateInput, SessionPatchInput } from '@badminton/shared';

/**
 * Let in several pending signups at once.
 *
 * The ask this whole feature came from: "a temporary way to allow people to
 * create a account and doesnt require our approval since it will take ages to
 * approve a ton of people". Each one still goes through approvePlayer, so each
 * one is still refused unless it is genuinely pending, still gets a member code,
 * still gets the "you're in" email, and still files its own player_approved row
 * naming whoever clicked.
 */
export async function bulkApprovePlayers(
  ids: string[],
  status: 'competitive' | 'recreational',
  reason: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(ids);
    await requireCapability('players.approve.write');
    return runBulk(targets, (id) => approvePlayer(id, status, reason));
  });
}

/**
 * The same edit to several members.
 *
 * `data` is one payload for the whole selection, which is what "mass edit"
 * means — membership type, division, back onto the roster or off it. The fields
 * an exec may not touch are refused per record by assertPlayerFieldAccess, and
 * the three that ARE console access are refused for everybody, admins included;
 * neither rule is restated here, because restating it is how the two would come
 * to disagree.
 *
 * A reason is required by adminPlayerUpdateSchema and it is required here for
 * the same reason it is required there — with the difference that one sentence
 * now explains a row apiece across the whole selection, which is exactly what
 * somebody reading the audit log a term later wants.
 */
export async function bulkUpdatePlayers(
  ids: string[],
  data: AdminPlayerUpdateInput,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(ids);
    await requireCapability('players.update.write');
    return runBulk(targets, (id) => updatePlayer(id, data));
  });
}

/**
 * The same edit to several nights.
 *
 * THE CLUB OWNER'S ASK: "no way to mass edit sessions?", asked over six Friday
 * rows all reading TIME NOT SET. Fixing that meant opening a dialog, retyping
 * the whole night and a reason, six times.
 *
 * `patch` is one partial payload for the whole selection. A key it does not
 * carry is not written at all, and a key carrying `null` clears that column —
 * the three-state shape sessionPatchSchema exists for, and the reason this loops
 * patchSession rather than updateSession, which reads an absent time as "clear".
 *
 * The reason is a third argument rather than a key in the payload (the shape
 * bulkUpdatePlayers uses) because that is how updateSession, archiveSession and
 * deleteSession all take it — and because it keeps the schema a pure column
 * allowlist that .strict() can police.
 */
export async function bulkUpdateSessions(
  ids: string[],
  patch: SessionPatchInput,
  reason: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(ids);
    await requireCapability('sessions.update.write');
    return runBulk(targets, (id) => patchSession(id, patch, reason));
  });
}

/**
 * Close several sessions.
 *
 * The end-of-term sweep, and the reason /sessions wanted this at all: a term is
 * three months of Tuesday and Thursday nights, and closing them one dialog at a
 * time is forty clicks.
 */
export async function bulkArchiveSessions(
  ids: string[],
  reason: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(ids);
    await requireCapability('sessions.archive.write');
    return runBulk(targets, (id) => archiveSession(id, reason));
  });
}

/**
 * Delete several sessions, attendance and all.
 *
 * Kept beside archive rather than folded into it: closing a night is a statement
 * about the night, deleting one destroys the attendance rows recorded against
 * it. deleteSession is admin-only for that reason and stays so here.
 */
export async function bulkDeleteSessions(
  ids: string[],
  reason: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(ids);
    await requireCapability('sessions.delete.write');
    return runBulk(targets, (id) => deleteSession(id, reason));
  });
}

// ─── THE FEE DESK ─────────────────────────────────────────────────────────────
//
// TWO THINGS DIFFER FROM EVERYTHING ABOVE, and both are worth stating once here
// rather than five times below.
//
// FIRST, THE CONTRACT. patchSession, archiveSession and deleteSession are
// already runAction-wrapped and hand back an ActionResult; the five fee actions
// THROW, because the dialogs on /fees and /tournaments/[id]/fees try/catch them.
// runBulk needs `(id) => Promise<ActionResult<unknown>>`, so each call is wrapped
// in runAction AT THE LOOP. That keeps both contracts intact — converting the
// actions themselves to return ActionResult would rewrite every existing caller
// in two client components for the benefit of this file. It also matters that
// runAction reports to Sentry only when `!isExpectedFailure(err)`: a loop over a
// roster reaches "no fee row" and "already unpaid" constantly, and those are
// ExpectedError refusals rather than pages — which is why e6f71300 and the
// matching markTournamentFeeUnpaid fix had to land before this file could.
//
// SECOND, AND THIS IS THE DESIGN POINT: NO AMOUNT PASSES THROUGH ANY OF THESE.
// It is not an omission and it must not be "completed" later.
//
//   * markFeePaid with amount_cents omitted falls back to the SEASON'S
//     PER-STATUS fee for that member — competitive or recreational, read off
//     their own row (actions/fees.ts);
//   * markTournamentFeePaid with neither tier_id nor amount_cents keeps the
//     row's OWN snapshot price, which ensureEntryFees seeded from the member's
//     real membership tier (e6f71300) — WHERE THE ROW CARRIES A PRICE AT ALL.
//     The entrant who carries none is the exception below.
//
// So omitting the amount is precisely what makes a bulk run charge each member
// their own rate. A single shared Amount field on the bar would bill thirty
// people one number and quietly overwrite thirty real tier prices — a $15
// internal member recorded as having paid $25 — with the audit rows agreeing.
// A custom amount is a statement about ONE person and stays the single-row
// dialog's job. For the same reason there is no tier_id here either.
//
// ONE HONEST EXCEPTION TO THE ENTRY-FEE HALF, KNOWN AND DELIBERATELY LEFT
// UNFIXED. "Keeps the row's own snapshot price" holds only where there is a
// snapshot to keep. The last branch of markTournamentFeePaid's amount derivation
// falls through to the tournament's is_default tier when the entrant has NO
// club_fees row — and equally when the row's amount_cents is null — and
// is_default is not membership-aware. So an internal member who owes $15 and has
// no row is recorded as having paid the $25 external default. Their OWN row's
// dialog would not do that: it prefills from quoteEntryFee(membership, tiers,
// fee), which falls to selectFeeTier and the tier matching THEIR membership, and
// sends it explicitly. Bulk and single-row genuinely disagree for that entrant.
// Reachable because ensureEntryFees never throws (a seed that failed leaves no
// row) and because entries predate it.
//
// NOT FIXED HERE, ON PURPOSE. Sending a tier from the bar is the client choosing
// a price — the thing the paragraph above refuses — and having the action
// re-derive one instead is a change to the single-record contract every existing
// caller shares, which is the overwrite e6f71300 closed. Pinned by "prices an
// entrant who has no row at all from the DEFAULT tier" in
// __tests__/bulk-actions.test.ts so it cannot change unnoticed.
//
// method AND reference DO belong in bulk, because they are genuinely shared:
// "cash, collected at the door" is one sentence about the whole selection.

/**
 * Record the season fee as paid for several members.
 *
 * Each one is charged THEIR OWN rate — see the note above. `method` and
 * `reference` are the shared half of the door desk's answer and are the only
 * payment fields this takes.
 */
export async function bulkMarkFeesPaid(
  playerIds: string[],
  seasonId: string,
  method?: string,
  reference?: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(playerIds);
    await requireCapability('fees.clubfees.markpaid.write');
    return runBulk(targets, (id) =>
      runAction(() =>
        markFeePaid({ player_id: id, season_id: seasonId, method, reference }),
      ),
    );
  });
}

/**
 * Write off the season fee for several members.
 *
 * A waiver is stored as a paid row worth $0 with method 'waived', so there is no
 * amount to name here at all. An already-waived row is refused per record rather
 * than re-waived: that would replace the date the waiver was granted and the
 * officer who granted it, which is the whole point of recording them.
 */
export async function bulkWaiveFees(
  playerIds: string[],
  seasonId: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(playerIds);
    await requireCapability('fees.clubfees.waive.write');
    return runBulk(targets, (id) => runAction(() => waiveFee({ player_id: id, season_id: seasonId })));
  });
}

/**
 * Reverse the season fee for several members.
 *
 * Reverses both a payment and a waiver — the same one control /fees renders as
 * "Mark Unpaid" over a paid row and "Unwaive" over a waived one. The amount
 * stays on the row; only the payment fields are cleared.
 */
export async function bulkMarkFeesUnpaid(
  playerIds: string[],
  seasonId: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(playerIds);
    await requireCapability('fees.clubfees.markunpaid.write');
    return runBulk(targets, (id) => runAction(() => markFeeUnpaid(id, seasonId)));
  });
}

/**
 * Record the entry fee as paid for several entrants.
 *
 * NO tier_id AND NO amount_cents, which is what makes each row keep the price it
 * already carries — see the note above. One tier across a thirty-person
 * selection is the exact overwrite e6f71300 closed on the single-record path.
 *
 * WITH ONE KNOWN EXCEPTION, argued at length in that note: an entrant with no
 * ledger row has no price to keep, so this prices them from the tournament's
 * is_default tier rather than from their membership, which their own row's dialog
 * would have used.
 */
export async function bulkMarkTournamentFeesPaid(
  playerIds: string[],
  tournamentId: string,
  method?: string,
  reference?: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(playerIds);
    await requireCapability('tournaments.fees.markpaid.write');
    return runBulk(targets, (id) =>
      runAction(() =>
        markTournamentFeePaid({ tournament_id: tournamentId, player_id: id, method, reference }),
      ),
    );
  });
}

/**
 * Reverse the entry fee for several entrants.
 *
 * The row stays — an entry that was made is a fact and the member still owes for
 * it. Over a waived row this is the "Unwaive" the page offers.
 */
export async function bulkMarkTournamentFeesUnpaid(
  playerIds: string[],
  tournamentId: string,
): Promise<ActionResult<BulkOutcome>> {
  return runAction(async () => {
    const targets = normalizeBulkIds(playerIds);
    await requireCapability('tournaments.fees.markunpaid.write');
    return runBulk(targets, (id) => runAction(() => markTournamentFeeUnpaid(tournamentId, id)));
  });
}
