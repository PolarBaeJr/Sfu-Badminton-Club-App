// Applying one decision to several records.
//
// NOT a 'use server' module: this is the plain part — the cap, the de-duplication
// and the loop — so it can be reasoned about and tested without a framework.
// The actions themselves live in actions/bulk.ts.
//
// THE LOOP CALLS THE ORDINARY SINGLE-RECORD ACTION, ONCE PER ID, AND THAT IS THE
// WHOLE DESIGN. The tempting shape is one statement — `.update({...}).in('id',
// ids)` — and it is the wrong one twice over:
//
//   * every guard those actions carry runs per call and none of them survive a
//     batched UPDATE: assertPlayerFieldAccess, assertNoConsoleAccessFields,
//     approvePlayer's "only a pending signup" precondition, the refusal to mark
//     a suspended member inactive, and the per-record audit row whose old_value
//     is read from THAT row;
//   * an unqualified UPDATE over a client-supplied id list is the least-guarded
//     write this codebase can build. A missing SELECT grant protects nothing
//     against one — that is exactly how the elo_review write got out — and every
//     exported argument of a server action is a client-controlled POST field.
//
// So a bulk action here is a loop, the single-record path is the only path, and
// nothing about who may do what is decided twice.
//
// WHAT THE LOOP COSTS, WRITTEN DOWN SO NOBODY REDISCOVERS IT: each iteration
// re-runs requireCapability, which is one GoTrue getUser() at roughly 63ms of
// service time, plus the action's own writes and — for approvals — an email.
// That is the price of not duplicating the guards, and it is paid deliberately.
// It is also why MAX_BULK_TARGETS is small and why the client sends the
// selection in chunks: a request that walked 300 members would sit for a minute
// behind a spinner with nothing to show for the wait.

import type { ActionResult } from './action-result';

/**
 * The most records one call may touch.
 *
 * A bound on a client-controlled array first and a latency budget second. The
 * console chunks a larger selection into several calls (see BULK_CHUNK), so this
 * is not a ceiling on how many members an officer can act on — it is a ceiling
 * on how much one POST can ask for.
 */
export const MAX_BULK_TARGETS = 25;

/**
 * How many the browser sends per call.
 *
 * Smaller than the cap on purpose: it is what makes the progress counter move.
 * An approval costs a gate, two writes, a member-code RPC and a "you're in"
 * email — call it a quarter of a second each — so ten is a couple of seconds of
 * work per request, which is short enough that a proxy timeout is not in the
 * conversation and long enough that the round trips are not the cost.
 */
export const BULK_CHUNK = 10;

export interface BulkFailure {
  id: string;
  /** The action's own message, never a rewrite of it. */
  error: string;
}

export interface BulkOutcome {
  /** Ids actually walked, after de-duplication. */
  attempted: number;
  succeeded: number;
  /** ONE ENTRY PER FAILED RECORD, and the loop does not stop at the first.
   *  Half a roster approved and four rows named is a usable outcome; an abort
   *  on record three leaves the officer guessing which of the rest went in. */
  failures: BulkFailure[];
}

/** Deduplicated, order preserved, and refused outright past the cap. */
export function normalizeBulkIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    throw new Error('Nothing was selected.');
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('That selection could not be read. Reload the page and try again.');
    }
    seen.add(id);
  }
  if (seen.size === 0) {
    throw new Error('Nothing was selected.');
  }
  if (seen.size > MAX_BULK_TARGETS) {
    // Reached only by a hand-rolled POST: the console never sends more than
    // BULK_CHUNK at a time.
    throw new Error(`A single request may act on at most ${MAX_BULK_TARGETS} records.`);
  }
  return [...seen];
}

/**
 * Walk the ids, running the single-record action on each, and report what
 * happened to every one of them.
 *
 * SEQUENTIAL, never Promise.all. These all hit the same GoTrue instance and the
 * same handful of Postgres rows, and firing twenty-five authentications at once
 * is a reliable way to make the gate the slow part. It also keeps the audit rows
 * in the order the officer's list was in, which is what a reader of the audit
 * log expects to find.
 *
 * NOTHING THROWS PAST THIS FUNCTION for a record-level failure — the action
 * already returns its refusal as a value, and a refusal on one member is a
 * result about that member rather than a failure of the request.
 */
export async function runBulk(
  ids: string[],
  one: (id: string) => Promise<ActionResult<unknown>>,
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { attempted: ids.length, succeeded: 0, failures: [] };
  for (const id of ids) {
    const result = await one(id);
    if (result.ok) outcome.succeeded += 1;
    else outcome.failures.push({ id, error: result.error });
  }
  return outcome;
}

/** Fold the per-chunk outcomes the browser collects back into one. */
export function mergeBulkOutcomes(parts: BulkOutcome[]): BulkOutcome {
  return parts.reduce<BulkOutcome>(
    (acc, p) => ({
      attempted: acc.attempted + p.attempted,
      succeeded: acc.succeeded + p.succeeded,
      failures: [...acc.failures, ...p.failures],
    }),
    { attempted: 0, succeeded: 0, failures: [] },
  );
}
