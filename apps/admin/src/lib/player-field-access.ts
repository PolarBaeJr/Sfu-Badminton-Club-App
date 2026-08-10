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
// so it can be reasoned about (and tested) as a plain function. (./permissions
// is a plain module too — no framework, no I/O.)
import { ExpectedError } from '@badminton/shared';
import { accessLevelFor, type AccessLevel } from './permissions';

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
//  - is_trainer     — new in 00054, and here for exactly the reason is_exec is:
//                     it opens the admin console. An exec who could set it
//                     could mint a trainer; a trainer who could set it could
//                     promote themselves. Only admins hand out console access.
//  - portfolio      — new in 00086. It is what NARROWS an exec, so an exec who
//                     could write it could widen themselves back to everything
//                     (or narrow a colleague out of their own job). Assigning
//                     one is admin work — see setPlayerPortfolio(). Listed here
//                     even though adminPlayerUpdateSchema does not carry it
//                     today: the day somebody adds it there, this line is what
//                     stops the Edit dialog becoming a privilege editor.
export const ADMIN_ONLY_PLAYER_FIELDS = [
  'role',
  'is_exec',
  'is_trainer',
  'portfolio',
  'exec_title',
  'exec_photo_url',
  'fee_exempt',
  'singles_elo',
  'doubles_elo',
] as const;

export type AdminOnlyPlayerField = (typeof ADMIN_ONLY_PLAYER_FIELDS)[number];

// What a VARSITY TRAINER may change on a player record: nothing. Not status,
// not membership type, not ratings, not their name.
//
// Written as its own explicit set rather than "the exec set minus a few" on
// purpose. A trainer's permissions are defined by what they CAN do (varsity
// notes, and that is the whole list), so the set is empty and stays empty —
// whereas a subtraction would silently grant every field somebody adds to
// adminPlayerUpdateSchema next year.
//
// Belt and braces: updatePlayer/approvePlayer/createPlayer/ban/unban all gate on
// getExecOrAdmin(), which rejects a trainer before any payload is inspected. If
// one of them is ever moved to a lower gate by mistake, this stops it silently
// becoming a trainer-writable action.
export const TRAINER_WRITABLE_PLAYER_FIELDS: readonly string[] = [];

export function isAdminActor(actor: { role?: string | null } | null | undefined): boolean {
  return actor?.role === 'admin';
}

type Actor = { role?: string | null; is_exec?: boolean | null; is_trainer?: boolean | null };

// Fails closed: an actor row that doesn't resolve to a level is treated as the
// most restricted caller, not waved through.
function levelOf(actor: Actor | null | undefined): AccessLevel | null {
  return accessLevelFor(actor);
}

function suppliedFrom(payloads: Record<string, unknown>[], fields: readonly string[]): string[] {
  return fields.filter((f) => payloads.some((p) => p[f] !== undefined));
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
 *
 * The permitted set depends on the caller's LEVEL, not on any single flag:
 *   admin    everything
 *   exec     everything except ADMIN_ONLY_PLAYER_FIELDS
 *   trainer  nothing at all (TRAINER_WRITABLE_PLAYER_FIELDS is empty)
 * Someone who is both a trainer and an exec resolves to exec and gets exec's
 * set — the restriction follows the level, never the flag in isolation.
 */
export function assertPlayerFieldAccess(
  actor: Actor | null | undefined,
  payloads: Record<string, unknown>[],
  fields: readonly string[] = ADMIN_ONLY_PLAYER_FIELDS,
): void {
  const level = levelOf(actor);
  if (level === 'admin') return;

  if (level !== 'exec') {
    // Trainer, or an actor with no resolvable level. Allow-list, not deny-list:
    // every field they did not send is irrelevant, and every field they DID send
    // is one they may not write.
    const allowed = new Set(TRAINER_WRITABLE_PLAYER_FIELDS);
    const supplied = Object.keys(Object.assign({}, ...payloads) as Record<string, unknown>)
      .filter((k) => payloads.some((p) => p[k] !== undefined))
      .filter((k) => !allowed.has(k));
    if (supplied.length > 0) {
      throw new ExpectedError(
        `Varsity trainers cannot change player records. Rejected: ${supplied.join(', ')}`,
      );
    }
    return;
  }

  const supplied = suppliedFrom(payloads, fields);
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
  actor: Actor | null | undefined,
  parsed: { role?: unknown; is_exec?: unknown; is_trainer?: unknown },
): void {
  if (isAdminActor(actor)) return;
  // is_trainer alongside is_exec: a trainer account is console access, and
  // minting one is the same workaround for "you cannot promote yourself".
  if (
    parsed.is_exec === true ||
    parsed.is_trainer === true ||
    (parsed.role !== undefined && parsed.role !== 'player')
  ) {
    throw new ExpectedError(
      'Admin access required to create an executive, trainer or admin account',
    );
  }
}
