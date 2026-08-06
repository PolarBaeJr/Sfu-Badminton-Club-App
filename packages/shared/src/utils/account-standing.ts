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
//   * players.active_flag  — cleared by deleteMyAccount and by the nightly
//                            mark-inactive-players job. requirePlayer() does
//                            NOT check it, so neither does this. (The admin
//                            console's admin_access_level() DOES check it —
//                            migration 00057 — which is a real inconsistency,
//                            but closing it means changing what the server
//                            allows and that is not this module's call.)
//
// Note the deliberate asymmetry with the labels shown elsewhere: 'suspended'
// and is_banned both read as "suspended" to a member, because that is what the
// club calls both. They differ in what undoes them, so the copy differs there.

export type AccountBlock = 'pending_approval' | 'suspended' | 'banned';

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
    | { status?: string | null; is_banned?: boolean | null; ban_reason?: string | null }
    | null
    | undefined,
): AccountStanding {
  if (!player) return GOOD_STANDING;

  // Order matches requirePlayer(): status first, then the ban. A member who is
  // both suspended and banned sees the suspension message, exactly as the
  // server action would have told them.
  let block: AccountBlock | null = null;
  if (player.status === 'pending_approval') block = 'pending_approval';
  else if (player.status === 'suspended') block = 'suspended';
  else if (player.is_banned) block = 'banned';

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
