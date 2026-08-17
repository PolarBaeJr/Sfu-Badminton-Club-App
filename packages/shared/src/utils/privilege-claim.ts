// Reading players.privilege_claim_review — the durable mark a roster claim
// leaves when it withheld or kept console privileges (00132).
//
// The column is jsonb written by SQL, so everything arriving here is `unknown`
// until proved otherwise. Parsing is TOTAL: any shape that is not recognisable
// comes back as null rather than throwing, because the one thing this must never
// do is take down the roster page. A row whose flag cannot be read is a row with
// nothing to review, which is the same thing the console shows for the 99% of
// rows that have never claimed anything.
//
// WHY A SHARED MODULE for something only the console reads. The shape is written
// in SQL and read in TSX, and the two have no compiler between them — the same
// gap the ELO engine and the name split both bridge by putting the rule in one
// place and pointing both sides at it. Keeping the parse here also means the
// restore action and the roster label cannot disagree about which privileges a
// review is holding.

/** The privileges a claim can decide about. Mirrors CLAIM_PRIVILEGE_COLUMNS in
 *  the player app and claim_privilege_attribution() in 00132. */
export interface ClaimPrivileges {
  role?: string;
  is_exec?: boolean;
  is_trainer?: boolean;
}

export interface PrivilegeClaimReview {
  /** held = something was withheld and nothing kept; kept = the reverse;
   *  mixed = both. Derived in SQL and stored so the console can label and sort
   *  without unpacking the two objects. */
  state: 'held' | 'kept' | 'mixed';
  /** ISO-8601, UTC, second precision. */
  at: string | null;
  /** Privileges the row carried that the claim did NOT confer. Restoring means
   *  writing exactly these back. */
  withheld: ClaimPrivileges;
  /** Privileges the claim let through because an exec was shown to have granted
   *  them deliberately. Nothing to restore — but an admin still has to know. */
  kept: ClaimPrivileges;
  /** True for the 00132 backfill, i.e. reconstructed from the old
   *  `roster_row_claimed_privileges_stripped` audit rows rather than written by
   *  a claim that ran under the new code. Worth showing, because the timestamp
   *  is then the strip's and not this row's. */
  backfilled: boolean;
}

const STATES = ['held', 'kept', 'mixed'] as const;

function readPrivileges(value: unknown): ClaimPrivileges {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: ClaimPrivileges = {};
  // Each key is read on its own terms rather than spread wholesale: this object
  // came out of the database as jsonb and a stray key must not travel into an
  // update statement that writes it to a column.
  if (typeof raw.role === 'string' && raw.role !== '') out.role = raw.role;
  if (raw.is_exec === true) out.is_exec = true;
  if (raw.is_trainer === true) out.is_trainer = true;
  return out;
}

/**
 * Parse the column. Returns null when there is nothing to review — which
 * includes NULL, a non-object, an unrecognised state, and a review that names no
 * privilege at all. That last one matters: a review with neither a withheld nor
 * a kept privilege has nothing an admin could act on, and showing it would be a
 * warning nobody can clear.
 */
export function parsePrivilegeClaimReview(value: unknown): PrivilegeClaimReview | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const withheld = readPrivileges(raw.withheld);
  const kept = readPrivileges(raw.kept);
  if (Object.keys(withheld).length === 0 && Object.keys(kept).length === 0) return null;

  // The stored state is trusted only when it is one of the three. Anything else
  // is re-derived from what is actually there, so a hand-edited or
  // future-versioned row still renders correctly rather than vanishing.
  const stored = typeof raw.state === 'string' ? raw.state : '';
  const state = (STATES as readonly string[]).includes(stored)
    ? (stored as PrivilegeClaimReview['state'])
    : Object.keys(withheld).length > 0 && Object.keys(kept).length > 0
      ? 'mixed'
      : Object.keys(withheld).length > 0
        ? 'held'
        : 'kept';

  return {
    state,
    at: typeof raw.at === 'string' && raw.at !== '' ? raw.at : null,
    withheld,
    kept,
    backfilled: raw.backfilled === true,
  };
}

/** Is there anything an admin still has to decide? A review that only KEPT
 *  privileges is an acknowledgement, not a decision — but it is still unresolved
 *  until somebody clears it, which is the point of the flag. */
export function hasPrivilegeClaimReview(value: unknown): boolean {
  return parsePrivilegeClaimReview(value) !== null;
}

/**
 * The column update that restores what a claim withheld. Empty when there is
 * nothing withheld, so a caller can tell "restore" from "there is nothing to
 * restore" without inspecting the review itself.
 *
 * Only ever names the three claim columns, and only the ones actually withheld —
 * a restore must not become a way to write arbitrary columns from a jsonb blob.
 */
export function restoreWithheldPrivileges(
  review: PrivilegeClaimReview | null,
): Record<string, unknown> {
  if (!review) return {};
  const update: Record<string, unknown> = {};
  if (review.withheld.role) update.role = review.withheld.role;
  if (review.withheld.is_exec) update.is_exec = true;
  if (review.withheld.is_trainer) update.is_trainer = true;
  return update;
}

/**
 * One line naming the privileges, for a badge or an audit reason. Ordered
 * role → exec → trainer, most consequential first, so the reader meets the
 * biggest word before the smallest.
 */
export function describePrivileges(privileges: ClaimPrivileges): string {
  const parts: string[] = [];
  if (privileges.role && privileges.role !== 'player') parts.push(privileges.role);
  if (privileges.is_exec) parts.push('exec');
  if (privileges.is_trainer) parts.push('trainer');
  return parts.join(' · ');
}

/** The sentence the roster shows for a review. Says what happened AND what it
 *  means for the member, because "held" on its own reads as a punishment. */
export function describePrivilegeClaimReview(review: PrivilegeClaimReview): string {
  const held = describePrivileges(review.withheld);
  const kept = describePrivileges(review.kept);
  if (review.state === 'kept') {
    return `Kept ${kept} when this roster row was claimed — an exec granted it deliberately.`;
  }
  if (review.state === 'mixed') {
    return `Kept ${kept}, holding ${held}. They are in as an ordinary member for the held part until you restore it.`;
  }
  return `Holding ${held} from the roster row they claimed. They are in as an ordinary member until you restore it.`;
}
