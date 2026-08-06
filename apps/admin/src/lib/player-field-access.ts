// Which parts of a player record an exec may change, and which stay admin-only.
//
// Execs manage the roster (approve, edit, ban/unban, varsity notes). They must
// NOT be able to hand out privilege — to themselves or anyone else — so the
// fields that grant it are carved out here and rejected at the server action.
//
// This has to live in the server action, NOT in the database. The
// guard_player_privileged_columns trigger looks like it covers exactly these
// columns, but it opens with `IF auth.uid() IS NULL ... RETURN NEW` and every
// admin action writes through the SERVICE-ROLE client, where auth.uid() is
// NULL. Verified against the live definition on 2026-08-05: the trigger waves
// all of these straight through. It protects a member editing their own profile
// with their own JWT; it does nothing for an admin-app server action.
//
// NOT a 'use server' module and deliberately free of any Supabase/Next import,
// so it can be reasoned about (and tested) as a plain function.
import { ExpectedError } from '@badminton/shared';

// Rejected when the caller is an exec who is not a full admin.
//
//  - role, is_exec  — the privilege elevation the club owner explicitly kept
//                     with admins. An exec who could set either could promote
//                     themselves.
//  - fee_exempt     — money. /fees is admin-only in the same access map, and
//                     is_exec itself exempts a player from fees, so an exec
//                     setting fee_exempt would route around that gate.
//  - exec_title,
//    exec_photo_url — only meaningful on an exec and set beside is_exec; they
//                     publish to the club's public /exec page. Grouped with
//                     is_exec as the conservative read (see the report — an
//                     exec editing their OWN bio is a different flow).
//  - singles_elo,
//    doubles_elo    — the ladder itself. Not privilege escalation, which is why
//                     it was initially exec-allowed, but the club owner ruled
//                     otherwise: a rating rewritten by hand bypasses every K
//                     factor, bound and margin rule the rating engine applies,
//                     and it is the one number the whole ladder is FOR. Execs
//                     record results; the engine decides ratings.
export const ADMIN_ONLY_PLAYER_FIELDS = [
  'role',
  'is_exec',
  'exec_title',
  'exec_photo_url',
  'fee_exempt',
  'singles_elo',
  'doubles_elo',
] as const;

export type AdminOnlyPlayerField = (typeof ADMIN_ONLY_PLAYER_FIELDS)[number];

export function isAdminActor(actor: { role?: string | null } | null | undefined): boolean {
  return actor?.role === 'admin';
}

/**
 * Reject the whole request when a non-admin caller supplies an admin-only
 * field. Deliberately NOT a silent drop: dropping the field would return a
 * cheerful "saved" for a change that never happened, and the person would only
 * find out later — if ever.
 *
 * Presence-based (`key !== undefined`), not "differs from the current value":
 * presence is the crisp boundary, and every caller in the UI is written to omit
 * fields it is not changing.
 *
 * Check the RAW input as well as the parsed one, and for the same reason the
 * write path uses raw: `exec_title` / `exec_photo_url` go through
 * blankAsUndefined, so `''` parses to undefined while the raw `''` is still
 * what gets written. Guarding only the parsed payload would let an exec post
 * `{ exec_title: '' }` straight at the server action, sail past the guard, and
 * blank a colleague's entry on the club's public exec page. Pass both.
 */
export function assertPlayerFieldAccess(
  actor: { role?: string | null } | null | undefined,
  payloads: Record<string, unknown>[],
  fields: readonly string[] = ADMIN_ONLY_PLAYER_FIELDS,
): void {
  if (isAdminActor(actor)) return;
  const supplied = fields.filter((f) => payloads.some((p) => p[f] !== undefined));
  if (supplied.length > 0) {
    throw new ExpectedError(
      `Admin access required to change: ${supplied.join(', ')}`,
    );
  }
}

/**
 * Creation is the same boundary from the other side: an exec may add a member,
 * but not add one who is already privileged (otherwise "I cannot promote
 * myself" is worked around by minting a second account).
 *
 * Value-based rather than presence-based, unlike the update guard.
 * adminPlayerCreateSchema already pins `role` to 'player', and the Add Player
 * dialog always sends `is_exec` — false for a plain member. Rejecting on
 * presence would block an exec from adding anyone at all.
 */
export function assertPlayerCreateFieldAccess(
  actor: { role?: string | null } | null | undefined,
  parsed: { role?: unknown; is_exec?: unknown },
): void {
  if (isAdminActor(actor)) return;
  if (parsed.is_exec === true || (parsed.role !== undefined && parsed.role !== 'player')) {
    throw new ExpectedError('Admin access required to create an executive or admin account');
  }
}
