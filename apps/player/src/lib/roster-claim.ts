// THE CLAIM ITSELF MOVED TO SQL IN 00132. What is left here is the address
// normalisation both sides depend on, and the record of why the rule is what it
// is — because the rule changed, and the reasoning that produced the old one is
// worth keeping next to the reasoning that replaced it.
//
// WHAT A CLAIM IS. An exec can pre-add a member to the roster (players.user_id
// IS NULL) before that person signs up. When they do sign up, the row matching
// their address is attached to their login instead of a second row being made.
// Without it every pre-added member gets a duplicate somebody has to merge by
// hand. It is also an authorization boundary, because whatever is already on the
// row comes with it.
//
// -------------------------------------------------------------------------
// THE OLD RULE, AND WHY IT WAS WRONG FOR THIS CLUB
// -------------------------------------------------------------------------
// This file used to strip role, is_exec and is_trainer from EVERY claim, on the
// rule "a claim links an identity, it never confers privilege". The escalation
// it guards against is real: a roster row carrying role='admin' would make
// whoever can receive mail at that address an admin the moment they finished
// onboarding — no approval, no audit entry, nothing to notice afterwards.
//
// The example it cited as the danger was lsa139@sfu.ca. That address is Steven
// Sun, and Steven Sun is this club's admin. On 2026-08-15 he signed in, the
// claim fired, and it took role='admin' and is_exec away from him. The one time
// the guard ever fired in production it fired against the person it was written
// to protect, and nothing told anybody: the audit row it wrote is real but is
// excluded from /accounts' access-change card by ACCESS_CHANGE_ACTION_TYPES,
// invisible on every /players tab, and lands in /audit's OTHER tab attributed to
// the member themselves.
//
// The guard assumed a privileged roster row is more likely a trap than a
// genuine officer being pre-added. For this club the opposite is usually true.
//
// -------------------------------------------------------------------------
// THE RULE NOW (00132, ensure_player_for_user + claim_privilege_attribution)
// -------------------------------------------------------------------------
//   A privilege is KEPT when it is ATTRIBUTABLE — when the most recent audit
//   entry that mentions it was written by somebody else through the console and
//   agrees with what the row carries. That is an exec deliberately pre-adding an
//   officer, which is the case this club actually has.
//
//   A privilege that nobody can be shown to have conferred is HELD, not
//   discarded: the member gets in as an ordinary member, and the privilege waits
//   in players.privilege_claim_review where the console shows it and an admin
//   restores it in one action. The lsa139 shape — an unclaimed privileged row
//   whose address anyone could receive mail at — still confers nothing unasked.
//
//   Either way it is AUDITED and SURFACED. Both directions: a claim that keeps
//   privileges is as worth telling an admin about as one that withholds them.
//
// WHY STRIP-OR-HOLD RATHER THAN REFUSE THE CLAIM. Once players.email is unique
// (00066), nothing can insert a second row for an address a roster row already
// holds. A claim path that refused privileged rows outright would leave that
// person with no way to onboard at all and no self-service escape — a
// permanently locked-out member, which is worse than the one deliberate click it
// costs an admin to restore. Holding fails closed and stays unblocked.
//
// NOT TOUCHED BY A CLAIM, then or now: status, membership_type and fee_exempt.
// Those describe who the admin decided this person is — which division they play
// in, what they owe — and re-deriving them would just make the admin retype what
// they already entered. They grant no console access. Nor first_name/last_name:
// the admin-entered name stays authoritative, and completeOnboarding only fills
// a name in when the stored one is blank.

/** The columns a claim decides about. Nothing else on the row confers console
 *  access: admin_access_level tests role and is_exec, and is_trainer opens the
 *  varsity notes. Mirrored by claim_privilege_attribution (00132) — change both
 *  together or the console and the database disagree about what a privilege is.
 */
export const CLAIM_PRIVILEGE_COLUMNS = ['role', 'is_exec', 'is_trainer'] as const;

// Addresses are stored folded by normalize_player_email_trg (00066), and GoTrue
// hands back a lowercased address, so an exact match is enough. This exists to
// make that explicit at the call site: the lookup used to be
// .ilike('email', user.email) with the address dropped in raw, and `_` and `%`
// are both legal in a local part and wildcards to ilike — the owner of
// 'a_c@sfu.ca' matched the unclaimed row for 'abc@sfu.ca'. Escaping the pattern
// is not enough either, because PostgREST rewrites `*` to `%` after any
// escaping we could do. An equality filter has no pattern language at all.
//
// ensure_player_for_user does the same fold in SQL and does NOT take an address
// from its caller at all — it reads auth.users itself, so there is nothing for a
// caller to get wrong. This remains for the one lookup still made from TypeScript
// (completeOnboarding's ambiguity check).
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
