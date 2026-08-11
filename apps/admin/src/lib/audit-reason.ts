// The console's rule: every audited action carries a typed reason — ban,
// remove, restore, edit, approve — and the dialog is a courtesy, not the rule.
// A client that never rendered the Textarea, or a stale tab, or a direct call to
// the server action reaches the same write, so the floor is enforced here.
//
// A TRIMMED floor is the whole point. "." satisfies `required` on the client and
// tells the next reader of the audit log nothing at all; five characters is not
// a guarantee of meaning but it is a guarantee that somebody typed something.
//
// A plain module rather than a helper inside the action file, because action
// files are 'use server' and may only export async functions — so a predicate
// living there can neither be shared nor unit-tested.

export const REASON_MIN = 5;

/**
 * The reason to record, or a thrown error naming what was refused.
 *
 * Returns the TRIMMED string: what reaches `audit_logs.reason` should not carry
 * the whitespace that made it pass the length check.
 *
 * `what` reads as the subject of the sentence — requireReason(r, 'Editing a
 * session') gives "Editing a session needs a reason of at least 5 characters."
 */
export function requireReason(reason: string, what: string): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < REASON_MIN) {
    throw new Error(`${what} needs a reason of at least ${REASON_MIN} characters.`);
  }
  return trimmed;
}
