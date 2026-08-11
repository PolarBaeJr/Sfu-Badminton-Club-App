import { describe, it, expect } from 'vitest';
import { selectFeeTier, type PricingTier } from '../fee-tiers';

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
