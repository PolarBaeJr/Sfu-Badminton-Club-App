// Account standing, as the members' app must present it.
//
// This is the read-only twin of requirePlayer() in
// apps/player/src/lib/actions/_shared.ts. requirePlayer() is the boundary and
// stays the boundary: it decides what is ALLOWED. This decides what is
// OFFERED, so that a control which the server is certain to refuse is never
// drawn as if it would work. The two must answer the same question the same
// way, and this one must never be the more permissive of the pair — if they
// ever drift, the failure mode we want is a hidden button that would have
// worked, not a live button that cannot.
//
// The three columns are independent and are not folded into one another:
//   * players.status       — 'pending_approval' and 'suspended' are refusals;
//                            'competitive'/'recreational'/'inactive' are not.
//   * players.is_banned    — its own boolean, set by banPlayer, never mirrored
//                            into status.
//   * players.active_flag  — cleared by THREE different writers that must not
//                            be treated alike. See isSelfReactivatable below;
//                            requirePlayer() now checks it, so this does too.
//
// Note the deliberate asymmetry with the labels shown elsewhere: 'suspended'
// and is_banned both read as "suspended" to a member, because that is what the
// club calls both. They differ in what undoes them, so the copy differs there.

export type AccountBlock =
  | 'pending_approval'
  | 'suspended'
  | 'banned'
  | 'deletion_pending';

// WHO CLEARS active_flag, and which of them a member may undo by signing in.
//
// Three writers, three different meanings — the whole point of this predicate
// is that they are NOT interchangeable:
//
//   1. mark-inactive-players (nightly edge function). Roster hygiene: no
//      session check-in for inactivity_rules.inactive_threshold_days. Nobody
//      decided anything about this person; a clock ran out. THIS is the one a
//      member undoes by coming back.
//   2. removePlayer (admin console) — writes status='suspended' AND
//      active_flag=false together. An admin removed them. Undoing that on
//      sign-in would let anyone reverse a moderation decision by logging in.
//   3. deleteMyAccount (members' app) — writes deletion_requested_at AND
//      active_flag=false. They asked to be deleted, with a 30-day grace window
//      and an explicit restoreMyAccount to change their mind. Silently
//      un-deleting on sign-in would be worse than refusing.
//
// So (2) is recognised by status='suspended' and (3) by deletion_requested_at.
// pending_approval and is_banned are folded in for the same reason: neither is
// a lapse, and a nightly clock must never launder either into "welcome back".
//
// COALESCE semantics, matching isInGoodStanding: a narrowed select that omits
// is_banned/deletion_requested_at must read as "not banned, not deleting"
// rather than silently refusing a member.
export function isSelfReactivatable(
  player:
    | {
        active_flag?: boolean | null;
        status?: string | null;
        is_banned?: boolean | null;
        deletion_requested_at?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!player) return false;
  // Only a deactivated account can be reactivated; an active one is not "in"
  // this state at all, and answering true would invite a pointless write.
  if (player.active_flag !== false) return false;
  if (player.deletion_requested_at) return false;
  if (player.status === 'suspended' || player.status === 'pending_approval') return false;
  if (player.is_banned === true) return false;
  return true;
}

export interface AccountStanding {
  /** True when nothing about this account's standing will refuse an action. */
  ok: boolean;
  /** Which rule refuses, or null when nothing does. */
  block: AccountBlock | null;
  /**
   * One clause, lower-case, for splicing into an inline note beside a control
   * that has been withheld: "Challenges are paused — {reason}".
   */
  reason: string;
  /** A full sentence for the app-wide banner, including what to do about it. */
  detail: string;
}

const GOOD_STANDING: AccountStanding = { ok: true, block: null, reason: '', detail: '' };

const BLOCKS: Record<AccountBlock, Omit<AccountStanding, 'ok' | 'block'>> = {
  pending_approval: {
    reason: 'your membership is still waiting to be approved',
    detail:
      'Your membership is waiting for an exec to approve it. Until then you can look around, but challenges, RSVPs, check-ins and tournament entries are on hold.',
  },
  suspended: {
    reason: 'your account is suspended',
    detail:
      'Your account is suspended, so club activity is paused. Contact an exec if you think this is a mistake.',
  },
  banned: {
    reason: 'your account is suspended',
    // ban_reason is folded in by getAccountStanding when there is one — a
    // member told only "you are suspended" has to go and ask what for.
    detail: 'Your account is suspended. Contact an executive to be reinstated.',
  },
  deletion_pending: {
    reason: 'your account is scheduled for deletion',
    detail:
      'You asked us to delete this account, so club activity is paused while the request stands. Cancel the deletion in Settings and everything comes straight back.',
  },
};

/**
 * @param player The signed-in member's own row, or null when nobody is signed
 *   in. A signed-out visitor gets good standing back: they are not a member in
 *   bad standing, they are a stranger, and the login redirect (middleware) is
 *   what handles them. Callers that need to distinguish the two already know
 *   whether they have a session.
 */
export function getAccountStanding(
  player:
    | {
        status?: string | null;
        is_banned?: boolean | null;
        // Folded into the banned message so a member is told WHY.
        ban_reason?: string | null;
        active_flag?: boolean | null;
        deletion_requested_at?: string | null;
      }
    | null
    | undefined,
): AccountStanding {
  if (!player) return GOOD_STANDING;

  // Order matches requirePlayer(): status first, then the ban, then the flag.
  // A member who is both suspended and banned sees the suspension message,
  // exactly as the server action would have told them.
  let block: AccountBlock | null = null;
  if (player.status === 'pending_approval') block = 'pending_approval';
  else if (player.status === 'suspended') block = 'suspended';
  else if (player.is_banned) block = 'banned';
  // A LAPSED member is deliberately NOT blocked here. requirePlayer() does not
  // refuse them either — it reactivates them and carries on — so blocking them
  // would hide controls the server would have allowed, which is the one
  // direction this module must never drift in. What is left once the three
  // checks above have passed is the deletion request, and only that.
  else if (player.active_flag === false && !isSelfReactivatable(player)) {
    block = 'deletion_pending';
  }

  if (!block) return GOOD_STANDING;

  // Say WHY. An exec writes a reason on every ban (it is required), and a
  // member who is only told "suspended" has to go and ask what for. Quoted so
  // it reads as the exec's words rather than the app's.
  if (block === 'banned') {
    const why = (player.ban_reason ?? '').trim();
    return {
      ok: false,
      block,
      ...BLOCKS[block],
      detail: why
        ? `Your account is suspended for "${why}". Contact an executive to be reinstated.`
        : BLOCKS[block].detail,
    };
  }
  return { ok: false, block, ...BLOCKS[block] };
}
