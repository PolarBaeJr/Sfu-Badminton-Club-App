// What a tournament entry costs, decided from who is entering.
//
// "tier doesn't allow me to charge user based on status set? Manual assignment
// is crazy annoying — we're already marking people as alumni and current
// member" — the club owner. Tiers used to be name + amount + is_default, with
// nothing tying one to a person, so an exec chose one by hand for every
// entrant. 00094 adds `applies_to` and this is the rule that reads it.
//
// A PURE FUNCTION over rows, not a query. The same answer has to be reachable
// from the player app (registering yourself), the admin app (adding somebody to
// an event) and a test, and the only way those three agree is if there is one
// implementation none of them owns. It is also the only way to test the tie
// cases without a database.

import type { MembershipType } from './membership';

/** The subset of a tournament_fee_tiers row this decision needs. */
export interface PricingTier {
  id: string;
  name: string;
  amount_cents: number;
  is_default: boolean;
  sort_order: number;
  /**
   * Which membership groups this tier prices. NULL/undefined means ANYONE —
   * the general price, and the state every tier created before 00094 is in.
   */
  applies_to?: readonly string[] | null;
}

export interface TierMatch {
  tier: PricingTier;
  /**
   * WHY this tier won, for the audit entry and for explaining a price to
   * somebody who disagrees with it.
   *
   *   'membership' the tier names this member's group
   *   'anyone'     the tier names no group, so it prices everybody
   *   'default'    nothing matched; the tournament's is_default tier stood in
   */
  reason: 'membership' | 'anyone' | 'default';
}

/**
 * Deterministic ordering within one bucket.
 *
 * A price that depends on the order Postgres happened to return rows in is
 * worse than an arbitrary price, because it is arbitrary AND irreproducible —
 * two entrants in the same group could be charged differently and nobody could
 * say why. sort_order is the column the fees page already orders by; name
 * breaks the remaining tie because it is the only other stable value.
 */
function bySortOrderThenName(a: PricingTier, b: PricingTier): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.name.localeCompare(b.name);
}

/**
 * The tier this member pays, or null if the tournament prices nothing for them.
 *
 * RESOLUTION ORDER, decided by the club owner and implemented literally:
 *
 *   1. tiers whose `applies_to` contains this membership, MOST SPECIFIC FIRST
 *      — fewest groups wins, so an "Alumni" tier beats an
 *      "Alumni + External" one for an alum. A tier written for a narrower
 *      audience is the more deliberate statement about that audience.
 *   2. a tier with no `applies_to` at all — the general price.
 *   3. the tournament's `is_default` tier, whatever it says about membership.
 *   4. nothing.
 *
 * NULL IS A REAL, SUPPORTED ANSWER AND NEVER AN ERROR. "Never refuse an entry
 * because no tier matched" — a tournament with no tiers at all is an ordinary
 * free event, and a club that stops taking registrations because somebody has
 * not filled in a price list has broken the thing that matters to protect the
 * thing that does not. The caller writes a fee row with a null amount, which
 * every screen in the app already renders as 'TBD'.
 *
 * The caller SNAPSHOTS the result onto the fee row. Re-deriving a price on read
 * would mean changing somebody's membership_type silently re-prices entries
 * they have already made — and silently re-priced money is how a ledger stops
 * reconciling.
 */
export function selectFeeTier(
  membership: MembershipType | string | null | undefined,
  tiers: readonly PricingTier[],
): TierMatch | null {
  // Matches the column default and isMembershipAllowed(): a player row read
  // before 00040, or fetched without the column, is an internal member — never
  // the most expensive group by accident.
  const group = membership ?? 'internal';

  const targeted = tiers.filter((t) => t.applies_to != null && t.applies_to.includes(group));
  if (targeted.length > 0) {
    // `targeted` is non-empty, so the sort has a first element; the check keeps
    // noUncheckedIndexedAccess honest rather than asserting past it.
    const best = [...targeted].sort((a, b) => {
      const specificity = (a.applies_to?.length ?? 0) - (b.applies_to?.length ?? 0);
      return specificity !== 0 ? specificity : bySortOrderThenName(a, b);
    })[0];
    if (best) return { tier: best, reason: 'membership' };
  }

  // `applies_to` absent OR an empty array. The column CHECK forbids an empty
  // array, but a row read through a client that dropped it, or written before
  // the constraint existed, must not fall through to "no price" — an empty
  // list is the shape a UI produces when every box is deselected, and reading
  // that as "prices nobody" would quietly zero out a tournament's fees.
  const anyone = tiers.filter((t) => t.applies_to == null || t.applies_to.length === 0);
  const general = [...anyone].sort(bySortOrderThenName)[0];
  if (general) return { tier: general, reason: 'anyone' };

  // Every tier names a group and none of them names this member's. The
  // is_default tier is the club's own answer to "what if none of these fit",
  // so it is used even though its applies_to excludes this member: an entry
  // priced at the fallback is recoverable, and a refused entry is not.
  const fallback = tiers.filter((t) => t.is_default).sort(bySortOrderThenName)[0];
  return fallback ? { tier: fallback, reason: 'default' } : null;
}

/** The subset of a club_fees entry row a quote can be read off. */
export interface LedgerFee {
  tier_id?: string | null;
  amount_cents?: number | null;
}

export interface FeeQuote {
  tierId: string | null;
  amountCents: number | null;
  /**
   * WHERE THE NUMBER CAME FROM, because "why does it say that" is the question
   * this whole file exists to be able to answer.
   *
   *   'ledger'  the member's own fee row already records a price
   *   others    selectFeeTier's reason, for a member with no row yet
   *   'none'    nothing prices this entry — render it as TBD, never as $0
   */
  source: 'ledger' | TierMatch['reason'] | 'none';
}

/**
 * WHAT THIS MEMBER'S ENTRY COSTS — the one derivation every surface must use.
 *
 * THE BUG THIS EXISTS TO CLOSE. selectFeeTier is membership-aware and had
 * exactly ONE caller in production, ensureEntryFees. Every other screen quoted
 * `tiers.find(t => t.is_default)` instead, so there were two derivations of one
 * number and the display picked the wrong branch. On the live tournament the
 * default tier is External at $25 and internal members are priced at $15: the
 * fees table read $15 off the ledger row (correctly) while the Mark Paid dialog
 * opened from that same row said "External — $25.00", and one click stored $25
 * against a member who owed $15. The member's own /fees screen then changed
 * underneath them.
 *
 * THE LEDGER OUTRANKS THE TIER LIST, and it has to. ensureEntryFees SNAPSHOTS
 * the price at the moment of entry precisely so that editing a tier — or
 * changing somebody's membership_type — cannot silently re-price an entry that
 * has already been made. Re-deriving on read would undo that guarantee on every
 * screen at once. So a row that records a price IS the price, and the tier list
 * is consulted only for somebody who has no row yet.
 *
 * A ROW WITH NEITHER FIELD SET falls through to the tier list rather than
 * quoting nothing. That row means "the club had not priced this entry when it
 * was made" — no figure exists to be protected, and tiers added since are the
 * club's best current answer.
 *
 * `?? null` and `!= null` throughout, never `||`: zero is a legitimate amount
 * (a waived row is $0) and truthiness would throw it away.
 */
export function quoteEntryFee(
  membership: MembershipType | string | null | undefined,
  tiers: readonly PricingTier[],
  fee?: LedgerFee | null,
): FeeQuote {
  if (fee && (fee.amount_cents != null || fee.tier_id != null)) {
    return { tierId: fee.tier_id ?? null, amountCents: fee.amount_cents ?? null, source: 'ledger' };
  }
  const match = selectFeeTier(membership, tiers);
  if (!match) return { tierId: null, amountCents: null, source: 'none' };
  return { tierId: match.tier.id, amountCents: match.tier.amount_cents, source: match.reason };
}
