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
