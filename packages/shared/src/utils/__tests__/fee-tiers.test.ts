import { describe, it, expect } from 'vitest';
import { selectFeeTier, quoteEntryFee, type PricingTier } from '../fee-tiers';

// The whole point of selectFeeTier being pure is that the tie cases — the ones
// an exec will actually hit and the ones nobody would think to seed a database
// with — are cheap to state. Each test below is a rule from 00094's comment.

const tier = (over: Partial<PricingTier> & { name: string; amount_cents: number }): PricingTier => ({
  id: over.name.toLowerCase(),
  is_default: false,
  sort_order: 0,
  applies_to: null,
  ...over,
});

describe('selectFeeTier', () => {
  it('picks the tier that names the member’s membership', () => {
    const tiers = [
      tier({ name: 'Internal', amount_cents: 1000, applies_to: ['internal'] }),
      tier({ name: 'External', amount_cents: 2500, applies_to: ['external'] }),
    ];
    expect(selectFeeTier('alumni', tiers)).toBeNull();
    expect(selectFeeTier('internal', tiers)).toEqual({ tier: tiers[0], reason: 'membership' });
    expect(selectFeeTier('external', tiers)).toEqual({ tier: tiers[1], reason: 'membership' });
  });

  it('prefers the MORE SPECIFIC tier when two match', () => {
    // "Alumni" is a deliberate statement about alumni; "Alumni + External" is a
    // catch-all that happens to include them.
    const specific = tier({ name: 'Alumni', amount_cents: 1500, applies_to: ['alumni'] });
    const broad = tier({ name: 'Guests', amount_cents: 2500, applies_to: ['alumni', 'external'] });
    expect(selectFeeTier('alumni', [broad, specific])?.tier).toBe(specific);
    expect(selectFeeTier('alumni', [specific, broad])?.tier).toBe(specific);
  });

  it('breaks a same-specificity tie on sort_order, then name — never on input order', () => {
    const a = tier({ name: 'Early bird', amount_cents: 1000, applies_to: ['internal'], sort_order: 1 });
    const b = tier({ name: 'Standard', amount_cents: 2000, applies_to: ['internal'], sort_order: 0 });
    expect(selectFeeTier('internal', [a, b])?.tier).toBe(b);
    expect(selectFeeTier('internal', [b, a])?.tier).toBe(b);

    const x = tier({ name: 'Beta', amount_cents: 1000, applies_to: ['internal'] });
    const y = tier({ name: 'Alpha', amount_cents: 2000, applies_to: ['internal'] });
    expect(selectFeeTier('internal', [x, y])?.tier).toBe(y);
    expect(selectFeeTier('internal', [y, x])?.tier).toBe(y);
  });

  it('falls back to an untargeted tier — the general price — before the default', () => {
    const anyone = tier({ name: 'Entry', amount_cents: 1200 });
    const other = tier({ name: 'Externals', amount_cents: 3000, applies_to: ['external'], is_default: true });
    expect(selectFeeTier('internal', [other, anyone])).toEqual({ tier: anyone, reason: 'anyone' });
  });

  it('treats an empty applies_to as "anyone", not as "nobody"', () => {
    // The column CHECK forbids it, but a row written before the constraint — or
    // read through a client that dropped the array — must not silently zero out
    // a tournament's prices.
    const empty = tier({ name: 'Entry', amount_cents: 1200, applies_to: [] });
    expect(selectFeeTier('alumni', [empty])).toEqual({ tier: empty, reason: 'anyone' });
  });

  it('uses the is_default tier when every tier names a group and none is theirs', () => {
    const tiers = [
      tier({ name: 'Internal', amount_cents: 1000, applies_to: ['internal'] }),
      tier({ name: 'Alumni', amount_cents: 1500, applies_to: ['alumni'], is_default: true }),
    ];
    expect(selectFeeTier('external', tiers)).toEqual({ tier: tiers[1], reason: 'default' });
  });

  it('RETURNS NULL RATHER THAN REFUSING when nothing matches at all', () => {
    // The rule the club owner set: never refuse an entry because no tier
    // matched. A tournament with no tiers is a free event, and one whose tiers
    // all exclude this member gets a fee row with no price rather than a
    // registration failure.
    expect(selectFeeTier('external', [])).toBeNull();
    expect(
      selectFeeTier('external', [tier({ name: 'Internal', amount_cents: 1000, applies_to: ['internal'] })]),
    ).toBeNull();
  });

  it('reads a missing membership as internal, matching the column default', () => {
    const tiers = [tier({ name: 'Members', amount_cents: 1000, applies_to: ['internal'] })];
    expect(selectFeeTier(null, tiers)?.tier).toBe(tiers[0]);
    expect(selectFeeTier(undefined, tiers)?.tier).toBe(tiers[0]);
  });
});

// ---------------------------------------------------------------------------
// quoteEntryFee — the number a SCREEN shows, and the one Mark Paid stores.
// ---------------------------------------------------------------------------
//
// selectFeeTier was membership-aware from the day it was written and had exactly
// one production caller, ensureEntryFees. Every other surface derived the price a
// second way — `tiers.find(t => t.is_default)` — and that second derivation is
// what the Mark Paid dialog seeded from. On the live tournament that is a $10
// error in the club's favour, applied by one click, against the members who are
// cheapest to charge.
//
// THE TIERS BELOW ARE THE LIVE ONES, not illustrative: Internal $15 applying to
// {internal} and NOT default, External $25 applying to {alumni,external} and IS
// default. Every rule in this suite is wrong under the old code and right under
// the new one on exactly this data.

/** The production fee tiers, as they are configured today. */
const INTERNAL: PricingTier = {
  id: 'tier-internal', name: 'Internal', amount_cents: 1500,
  is_default: false, sort_order: 0, applies_to: ['internal'],
};
const EXTERNAL: PricingTier = {
  id: 'tier-external', name: 'External', amount_cents: 2500,
  is_default: true, sort_order: 1, applies_to: ['alumni', 'external'],
};
const LIVE_TIERS = [INTERNAL, EXTERNAL];

/**
 * THE OLD RULE, written out so the discrimination is visible in this file rather
 * than only in a git diff. This is verbatim what tournament-fee-actions.tsx and
 * the fees page both did: one flat default tier, the member never consulted.
 */
const legacyQuote = (tiers: readonly PricingTier[]) => {
  const t = tiers.find((x) => x.is_default) ?? tiers[0] ?? null;
  return { tierId: t?.id ?? null, amountCents: t?.amount_cents ?? null };
};

describe('quoteEntryFee', () => {
  // THE REPORTED DEFECT, on the real data. An internal member with no fee row
  // yet — an exec marking somebody paid at the door before registration filed
  // anything — was quoted the External tier at $25.
  it('quotes an internal member their own tier, not the default one', () => {
    const quote = quoteEntryFee('internal', LIVE_TIERS);

    expect(quote).toEqual({ tierId: 'tier-internal', amountCents: 1500, source: 'membership' });
    // And the old rule, on the same inputs, is the over-charge.
    expect(legacyQuote(LIVE_TIERS)).toEqual({ tierId: 'tier-external', amountCents: 2500 });
  });

  it('quotes alumni and external members the tier that names them', () => {
    expect(quoteEntryFee('alumni', LIVE_TIERS).amountCents).toBe(2500);
    expect(quoteEntryFee('external', LIVE_TIERS).amountCents).toBe(2500);
  });

  // A player row read without the column, or written before 00040, is an
  // internal member — never the most expensive group by accident.
  it('treats an unknown membership as internal rather than as the default tier', () => {
    expect(quoteEntryFee(null, LIVE_TIERS).amountCents).toBe(1500);
    expect(quoteEntryFee(undefined, LIVE_TIERS).amountCents).toBe(1500);
  });

  // THE LEDGER OUTRANKS THE TIER LIST. ensureEntryFees snapshots the price at
  // entry precisely so that editing a tier cannot re-price an entry already
  // made; a screen that re-derived on read would undo that everywhere at once.
  it('reads an existing fee row rather than re-deriving its price', () => {
    const fee = { tier_id: 'tier-internal', amount_cents: 1500 };

    // Even for somebody whose membership now says otherwise — they were charged
    // $15 on the day, and that is the figure the club has to stand behind.
    expect(quoteEntryFee('external', LIVE_TIERS, fee)).toEqual({
      tierId: 'tier-internal', amountCents: 1500, source: 'ledger',
    });
  });

  it('quotes a repriced row at what the row says, not at any tier', () => {
    const fee = { tier_id: null, amount_cents: 2000 };
    expect(quoteEntryFee('internal', LIVE_TIERS, fee)).toEqual({
      tierId: null, amountCents: 2000, source: 'ledger',
    });
  });

  // $0 IS A REAL AMOUNT — a waived row is stored as $0 with method 'waived'.
  // `||` anywhere in this derivation would throw it away and quote a tier price
  // for a fee the club deliberately wrote off.
  it('keeps a zero amount instead of falling through to a tier', () => {
    expect(quoteEntryFee('internal', LIVE_TIERS, { tier_id: null, amount_cents: 0 })).toEqual({
      tierId: null, amountCents: 0, source: 'ledger',
    });
  });

  // A row filed when the tournament had no tiers records no figure at all. There
  // is nothing to protect, so tiers added since are the club's best answer.
  it('falls through to the tier list for a row that records no price', () => {
    expect(quoteEntryFee('internal', LIVE_TIERS, { tier_id: null, amount_cents: null })).toEqual({
      tierId: 'tier-internal', amountCents: 1500, source: 'membership',
    });
  });

  // NULL IS A SUPPORTED ANSWER AND NEVER $0. A tournament that has priced
  // nothing is a free event, and every screen renders null as 'TBD'.
  it('quotes nothing when no tier prices this member and no row exists', () => {
    expect(quoteEntryFee('external', [INTERNAL])).toEqual({
      tierId: null, amountCents: null, source: 'none',
    });
    expect(quoteEntryFee('internal', [])).toEqual({
      tierId: null, amountCents: null, source: 'none',
    });
  });

  // The is_default tier is still the club's own answer to "none of these fit" —
  // reached through selectFeeTier's ordering, not as a flat first guess.
  it('still falls back to the default tier when nothing names this member', () => {
    const alumniOnly: PricingTier = { ...EXTERNAL, applies_to: ['alumni'] };
    expect(quoteEntryFee('external', [INTERNAL, alumniOnly])).toEqual({
      tierId: 'tier-external', amountCents: 2500, source: 'default',
    });
  });
});
