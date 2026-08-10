// Approving a signup is not an ordinary status write, so the Edit dialog has to
// be able to tell the two apart.
//
// approvePlayer emails the member "you're in" and files a player_approved audit
// row; updatePlayer does neither. The Needs Attention tab used to carry the
// dedicated Recreational / Competitive buttons that called approvePlayer, and
// they are gone — a signup can be an alumnus or an external, so the club owner
// wanted the whole decision made in Edit. That leaves Edit as the only console
// path out of pending_approval, which is why it has to know about approval at
// all: routing it through updatePlayer would silently stop welcoming people and
// stop recording that anyone was ever let in.
//
// Pure on purpose — this is the part of that rule that can be checked without a
// database, a browser or a session.

/** Real divisions. Everything else out of pending_approval is not an approval. */
const DIVISIONS = ['competitive', 'recreational'] as const;

export type Division = (typeof DIVISIONS)[number];

/**
 * Does saving `nextStatus` over `currentStatus` approve a pending signup?
 *
 * Only out of pending_approval, and only INTO a division: 'inactive' and
 * 'suspended' are decisions about a pending signup, not acceptances of one, and
 * nobody should be emailed "you're in" for either.
 */
export function isApprovalEdit(
  currentStatus: string | null | undefined,
  nextStatus: string,
): nextStatus is Division {
  return currentStatus === 'pending_approval' && (DIVISIONS as readonly string[]).includes(nextStatus);
}
