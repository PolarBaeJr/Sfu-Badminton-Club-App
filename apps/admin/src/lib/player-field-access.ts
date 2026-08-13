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
import {
  accessLevelFor,
  permissionsOf,
  permits,
  type AccessLevel,
  type PermissionsInput,
} from './permissions';

// THE HARD FLOOR. Refused HERE to anyone who is not `role === 'admin'`, under
// all circumstances, and reachable through this guard by no capability — not
// even by granting one deliberately.
//
// "HERE" BECAME LOAD-BEARING IN 00105, so it is worth being exact. One capability
// now reaches three of these columns — `players.consoleaccess.write`, the club
// owner's "also make role change a permission" — and it does NOT do so through
// this function. It is read in one place, setConsoleAccess, which writes the
// three level markers itself under checks this guard does not have: grant
// closure on the target's whole resolved set both before and after the change, a
// refusal to touch anybody who is already an admin, a refusal to hand out the
// admin level at all, and a refusal to act on your own row.
//
// NOTHING BELOW MOVED, and that is the point of doing it that way rather than
// teaching this function about the capability. updatePlayer() is the other
// caller — the member Edit dialog — and it has none of those checks, so a
// capability-aware floor would have let anybody holding players.update.write
// alongside the console capability mint an executive from the roster screen with
// no closure test anywhere. The floor is what stops that, and it stops it by
// staying exactly as it is.
//
// Not belt-and-braces given the capability system, but the thing that system
// cannot express. Grant closure bounds what one person may hand another, and it
// bounds it in CAPABILITIES. None of these is a capability: three are the level
// markers themselves, three are where a person's permissions are stored, and one
// is an identity the club assigns rather than a field anybody edits.
// Without this list, players.privilegedfields.write could set is_exec and mint
// an exec, or write another person's grants directly, and grant closure could
// not see it — because the actor holds that capability legitimately. Keeping
// level-granting outside the capability system entirely is the point.
//
//  - role, is_exec  — the privilege elevation the club owner explicitly kept
//                     with admins. Anyone who could set either could promote
//                     themselves.
//  - is_trainer     — new in 00054, and here for exactly the reason is_exec is:
//                     it opens the admin console. Only admins hand out console
//                     access.
//  - permission_role,
//    permission_grants,
//    permission_revokes
//                   — where a person's capabilities are stored. Writing them
//                     through the Edit dialog would be handing out permissions
//                     with none of the closure checks setPlayerPermissions
//                     applies, and taking them away is just as reachable.
//                     Listed even though adminPlayerUpdateSchema does not carry
//                     them: the day somebody adds one, this is what stops the
//                     Edit dialog becoming a privilege editor.
//  - member_code    — not privilege, and the only entry here that is not. It is
//                     an identity the club assigns once and never reuses, so
//                     there is no such thing as editing one correctly: a
//                     reissue either collides with somebody or breaks a code
//                     that has already been written down. Floor rather than
//                     grantable because no capability should ever reach it —
//                     "may edit privileged profile fields" is about a person's
//                     details, and this is not one of their details.
export const PLAYER_FIELD_FLOOR = [
  'role',
  'is_exec',
  'is_trainer',
  'permission_role',
  'permission_grants',
  'permission_revokes',
  'member_code',
] as const;

// The GRANTABLE remainder — admin-only today, because
// players.privilegedfields.write is in no baseline, but reachable by an
// explicit grant in a way the floor above never is.
//
//  - fee_exempt     — money. is_exec itself exempts a player from fees, so
//                     setting fee_exempt routes around the fee gate.
//  - exec_title,
//    exec_photo_url — only meaningful on an exec and set beside is_exec; they
//                     publish to the club's public /exec page. Grouped with
//                     is_exec as the conservative read (see the report — an
//                     exec editing their OWN bio is a different flow). They are
//                     grantable rather than floor because they are a bio, not a
//                     level: writing one hands out no access.
//  - singles_elo,
//    doubles_elo    — the ladder itself. Not privilege escalation, which is why
//                     it was initially exec-allowed, but the club owner ruled
//                     otherwise: a rating rewritten by hand bypasses every K
//                     factor, bound and margin rule the rating engine applies,
//                     and it is the one number the whole ladder is FOR. Execs
//                     record results; the engine decides ratings.
export const PLAYER_FIELD_PRIVILEGED = [
  'exec_title',
  'exec_photo_url',
  'fee_exempt',
  'singles_elo',
  'doubles_elo',
] as const;

// Both halves, for the callers that guard the whole payload at once. The split
// is what matters — this is the union, not a third policy.
export const ADMIN_ONLY_PLAYER_FIELDS = [
  ...PLAYER_FIELD_FLOOR,
  ...PLAYER_FIELD_PRIVILEGED,
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
// Belt and braces: updatePlayer/approvePlayer/createPlayer/ban/unban all ask
// for a players.*.write a trainer does not hold, which rejects them before any
// payload is inspected. If one of them is ever moved to a capability a trainer
// DOES hold, this stops it silently becoming a trainer-writable action.
export const TRAINER_WRITABLE_PLAYER_FIELDS: readonly string[] = [];

export function isAdminActor(actor: { role?: string | null } | null | undefined): boolean {
  return actor?.role === 'admin';
}

// The actor's LEVEL markers and their stored permissions. The permission
// columns are optional because a caller may legitimately not have them — a row
// selected before 00087 was applied has none, and permissionsOf() reads that
// state as "not narrowed", which is what every row is on the day it lands.
//
// What a caller must NOT do is pass a row whose SELECT named permission_role
// and dropped the delta columns: permissionsOf() throws on that rather than
// treating a missing revoke as an empty one. Every caller here passes the row
// requireCapability() returned, which is a select('*').
type Actor = {
  role?: string | null;
  is_exec?: boolean | null;
  is_trainer?: boolean | null;
} & PermissionsInput;

// Fails closed: an actor row that doesn't resolve to a level is treated as the
// most restricted caller, not waved through.
function levelOf(actor: Actor | null | undefined): AccessLevel | null {
  return accessLevelFor(actor);
}

const FLOOR: ReadonlySet<string> = new Set<string>(PLAYER_FIELD_FLOOR);

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
 * TWO REFUSALS, not one, and the difference is the whole point of the split:
 *   PLAYER_FIELD_FLOOR       admin by LEVEL, unconditionally. No capability
 *                            reaches it, so no grant can ever open it.
 *   PLAYER_FIELD_PRIVILEGED  players.privilegedfields.write, which sits in no
 *                            baseline and is therefore admin-only today, but is
 *                            handed out per person once the editor exists.
 * Everything else is ordinary roster work.
 *
 * Someone who is both a trainer and an exec resolves to exec — the restriction
 * follows the level a person resolves to, never a flag in isolation.
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

  // The floor first, and it does not consult a capability at all. `fields` can
  // be narrowed by a caller, but never past this: a caller that forgot to pass
  // a level marker must not be able to widen the guard by passing a shorter
  // list, so the floor is intersected with the supplied payload directly.
  const floorSupplied = suppliedFrom(payloads, PLAYER_FIELD_FLOOR);
  const grantable = fields.filter((f) => !FLOOR.has(f));
  const grantableSupplied = permits(level, permissionsOf(level, actor), 'players.privilegedfields.write')
    ? []
    : suppliedFrom(payloads, grantable);

  const supplied = [...floorSupplied, ...grantableSupplied];
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
