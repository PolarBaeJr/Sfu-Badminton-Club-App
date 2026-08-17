import { describe, it, expect } from 'vitest';
import {
  parsePrivilegeClaimReview,
  hasPrivilegeClaimReview,
  restoreWithheldPrivileges,
  describePrivileges,
  describePrivilegeClaimReview,
} from '../privilege-claim';

// The fixtures are the shapes ensure_player_for_user actually writes (00132
// section 4) and the shape its backfill writes (section 6). If the SQL changes
// what it stores, these are what should fail.
const HELD = {
  state: 'held',
  at: '2026-08-16T04:00:00Z',
  player_id: 'f4d388d5-992b-48e2-880d-9d1bedabfc71',
  withheld: { role: 'admin', is_exec: true },
};
const KEPT = {
  state: 'kept',
  at: '2026-08-16T04:00:00Z',
  player_id: 'x',
  kept: { is_exec: true, is_trainer: true },
};
const MIXED = {
  state: 'mixed',
  at: '2026-08-16T04:00:00Z',
  player_id: 'x',
  kept: { is_exec: true },
  withheld: { role: 'admin' },
};

describe('parsePrivilegeClaimReview — what it accepts', () => {
  it('reads a held review', () => {
    const review = parsePrivilegeClaimReview(HELD);
    expect(review).not.toBeNull();
    expect(review!.state).toBe('held');
    expect(review!.withheld).toEqual({ role: 'admin', is_exec: true });
    expect(review!.kept).toEqual({});
    expect(review!.at).toBe('2026-08-16T04:00:00Z');
    expect(review!.backfilled).toBe(false);
  });

  it('reads a kept review', () => {
    const review = parsePrivilegeClaimReview(KEPT)!;
    expect(review.state).toBe('kept');
    expect(review.kept).toEqual({ is_exec: true, is_trainer: true });
    expect(review.withheld).toEqual({});
  });

  it('reads a mixed review', () => {
    const review = parsePrivilegeClaimReview(MIXED)!;
    expect(review.state).toBe('mixed');
    expect(review.kept).toEqual({ is_exec: true });
    expect(review.withheld).toEqual({ role: 'admin' });
  });

  it('marks the 00132 backfill so the console can say the timestamp is the strip’s', () => {
    expect(parsePrivilegeClaimReview({ ...HELD, backfilled: true })!.backfilled).toBe(true);
  });
});

describe('parsePrivilegeClaimReview — total, never throwing', () => {
  // The column is jsonb. Every one of these has to come back null rather than
  // take down the roster page, which is the only screen that reads it.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'held'],
    ['a number', 3],
    ['an array', [{ role: 'admin' }]],
    ['an empty object', {}],
    ['a review naming no privilege', { state: 'held', withheld: {} }],
    ['withheld as a string', { state: 'held', withheld: 'admin' }],
  ])('returns null for %s', (_label, value) => {
    expect(parsePrivilegeClaimReview(value)).toBeNull();
    expect(hasPrivilegeClaimReview(value)).toBe(false);
  });

  it('ignores keys that are not claim privileges', () => {
    const review = parsePrivilegeClaimReview({
      state: 'held',
      withheld: { role: 'admin', status: 'competitive', fee_exempt: true },
    })!;
    // status and fee_exempt are deliberately NOT claim privileges — a claim has
    // never touched them, and letting one through here would put it into the
    // update statement restoreWithheldPrivileges builds.
    expect(review.withheld).toEqual({ role: 'admin' });
  });

  it('ignores a false or non-boolean is_exec rather than treating it as set', () => {
    expect(parsePrivilegeClaimReview({ state: 'held', withheld: { is_exec: false } })).toBeNull();
    expect(parsePrivilegeClaimReview({ state: 'held', withheld: { is_exec: 'yes' } })).toBeNull();
  });

  it('re-derives an unrecognised state from what is actually there', () => {
    expect(parsePrivilegeClaimReview({ state: 'wat', withheld: { is_exec: true } })!.state).toBe('held');
    expect(parsePrivilegeClaimReview({ kept: { is_exec: true } })!.state).toBe('kept');
    expect(
      parsePrivilegeClaimReview({ kept: { is_exec: true }, withheld: { role: 'admin' } })!.state,
    ).toBe('mixed');
  });
});

describe('restoreWithheldPrivileges', () => {
  it('names exactly the privileges that were withheld', () => {
    expect(restoreWithheldPrivileges(parsePrivilegeClaimReview(HELD))).toEqual({
      role: 'admin',
      is_exec: true,
    });
  });

  it('is empty for a review that kept everything — there is nothing to restore', () => {
    expect(restoreWithheldPrivileges(parsePrivilegeClaimReview(KEPT))).toEqual({});
  });

  it('is empty for no review at all', () => {
    expect(restoreWithheldPrivileges(null)).toEqual({});
  });

  it('never writes a column outside the three a claim decides about', () => {
    const review = parsePrivilegeClaimReview({
      state: 'held',
      withheld: { role: 'admin', is_banned: true, permission_role: 'finance' },
    });
    expect(Object.keys(restoreWithheldPrivileges(review))).toEqual(['role']);
  });
});

describe('describe helpers', () => {
  it('orders role, exec, trainer — biggest word first', () => {
    expect(describePrivileges({ role: 'admin', is_exec: true, is_trainer: true })).toBe(
      'admin · exec · trainer',
    );
  });

  it('does not name role player, which is not a privilege', () => {
    expect(describePrivileges({ role: 'player', is_exec: true })).toBe('exec');
  });

  it('says what a hold means for the member, not just that it happened', () => {
    const sentence = describePrivilegeClaimReview(parsePrivilegeClaimReview(HELD)!);
    expect(sentence).toContain('admin · exec');
    expect(sentence).toContain('ordinary member');
  });

  it('says a kept claim was deliberate', () => {
    expect(describePrivilegeClaimReview(parsePrivilegeClaimReview(KEPT)!)).toContain('deliberately');
  });
});
