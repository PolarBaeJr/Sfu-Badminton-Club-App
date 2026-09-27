import { describe, it, expect } from 'vitest';
import {
  ENTRY_MEMBERSHIP_CASES,
  entryMembership,
  isFeeExempt,
  membershipRefusalMessage,
  membershipUnpaidMessage,
  screenMembershipEntry,
  type EntryMembershipFacts,
} from '../membership';

// "internal is when a person has paid for membership fees, externals is anyone
// who is not paying our club fees" (the club owner). entryMembership is that
// sentence, and 00260 applies the same table in SQL.

const facts = (over: Partial<EntryMembershipFacts>): EntryMembershipFacts => ({
  stored: 'internal',
  exempt: false,
  paid: false,
  hasSeason: true,
  ...over,
});

describe('entryMembership', () => {
  it('covers every combination exactly once', () => {
    expect(ENTRY_MEMBERSHIP_CASES).toHaveLength(24);
    const keys = new Set(ENTRY_MEMBERSHIP_CASES.map((c) => `${c.stored}/${c.exempt}/${c.paid}/${c.hasSeason}`));
    expect(keys.size).toBe(24);
  });

  for (const c of ENTRY_MEMBERSHIP_CASES) {
    it(`${c.stored}, exempt=${c.exempt}, paid=${c.paid}, season=${c.hasSeason} enters as ${c.expected}`, () => {
      expect(entryMembership(c)).toBe(c.expected);
    });
  }

  it('an unpaid internal member enters as external', () => {
    expect(entryMembership(facts({}))).toBe('external');
  });

  it('a paid external member enters as internal', () => {
    expect(entryMembership(facts({ stored: 'external', paid: true }))).toBe('internal');
  });

  it('an unpaid alum stays alumni', () => {
    expect(entryMembership(facts({ stored: 'alumni' }))).toBe('alumni');
  });

  it('with no season, nobody could have paid, so the stored group stands', () => {
    expect(entryMembership(facts({ hasSeason: false }))).toBe('internal');
    expect(entryMembership(facts({ stored: 'external', hasSeason: false }))).toBe('external');
  });

  it('reads a null or unknown stored value as internal, like the column default', () => {
    expect(entryMembership(facts({ stored: null, hasSeason: false }))).toBe('internal');
    expect(entryMembership(facts({ stored: 'nonsense', hasSeason: false }))).toBe('internal');
    // ...and as internal it is subject to the dues rule like anybody else.
    expect(entryMembership(facts({ stored: null }))).toBe('external');
  });
});

describe('screenMembershipEntry', () => {
  const INTERNAL_ONLY = ['internal'];

  it('refuses an unpaid internal member from an internal-only event as UNPAID', () => {
    const r = screenMembershipEntry(facts({}), INTERNAL_ONLY);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('membership_unpaid');
      expect(r.message).toBe(membershipUnpaidMessage(INTERNAL_ONLY));
    }
  });

  it('admits the same member once paid', () => {
    expect(screenMembershipEntry(facts({ paid: true }), INTERNAL_ONLY).ok).toBe(true);
  });

  it('never refuses an exec or a fee-exempt member from an internal-only event', () => {
    for (const stored of ['internal', 'alumni', 'external']) {
      expect(screenMembershipEntry(facts({ stored, exempt: true }), INTERNAL_ONLY).ok).toBe(true);
    }
  });

  it('refuses a paid member at an alumni-only event as NOT ALLOWED, because paying cannot help', () => {
    const r = screenMembershipEntry(facts({ paid: true }), ['alumni']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('membership_not_allowed');
      expect(r.message).toBe(membershipRefusalMessage(['alumni']));
    }
  });

  it('refuses an unpaid external member from an internal-only event as UNPAID', () => {
    const r = screenMembershipEntry(facts({ stored: 'external' }), INTERNAL_ONLY);
    expect(!r.ok && r.reason).toBe('membership_unpaid');
  });

  it('refuses as NOT ALLOWED when there is no season to pay for', () => {
    const r = screenMembershipEntry(facts({ stored: 'external', hasSeason: false }), INTERNAL_ONLY);
    expect(!r.ok && r.reason).toBe('membership_not_allowed');
  });

  it('admits an unpaid internal member to an externals-only event, since that is what they enter as', () => {
    expect(screenMembershipEntry(facts({}), ['external']).ok).toBe(true);
  });

  it('fails open on a missing or empty allow-list', () => {
    expect(screenMembershipEntry(facts({ stored: 'external' }), null).ok).toBe(true);
    expect(screenMembershipEntry(facts({ stored: 'external' }), undefined).ok).toBe(true);
    expect(screenMembershipEntry(facts({ stored: 'external' }), []).ok).toBe(true);
  });

  it('reports the group the member enters as', () => {
    expect(screenMembershipEntry(facts({ stored: 'external', paid: true }), null)).toEqual({
      ok: true,
      effective: 'internal',
    });
  });
});

describe('membershipUnpaidMessage', () => {
  it('says what Internal means and where to pay', () => {
    expect(membershipUnpaidMessage(['internal'])).toBe(
      "This event is open to Internal members only, and Internal means this season's club fee is paid. " +
        'Pay it on the Membership page, then enter.',
    );
  });

  it('names alumni too when the event admits them', () => {
    expect(membershipUnpaidMessage(['internal', 'alumni'])).toMatch(/^This event is open to Internal and Alumni members only, /);
  });
});

describe('isFeeExempt', () => {
  it('is an exec or a fee-exempt member, and nobody else', () => {
    expect(isFeeExempt({ is_exec: true, fee_exempt: false })).toBe(true);
    expect(isFeeExempt({ is_exec: false, fee_exempt: true })).toBe(true);
    expect(isFeeExempt({ is_exec: false, fee_exempt: false })).toBe(false);
    expect(isFeeExempt({ is_exec: null, fee_exempt: null })).toBe(false);
    expect(isFeeExempt(null)).toBe(false);
  });
});

describe('membershipUnpaidMessage without the Membership page', () => {
  it('sends the member to an exec instead of a page that is switched off', () => {
    const m = membershipUnpaidMessage(['internal'], false);
    expect(m).toMatch(/Ask an exec to record your club fee\.$/);
    expect(m).not.toMatch(/Membership page/);
  });
});
