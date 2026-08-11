import { describe, it, expect } from 'vitest';
import { formatMemberIdentifier } from '../member-identifier';

describe('formatMemberIdentifier', () => {
  it('renders the current integer shape zero-padded', () => {
    expect(formatMemberIdentifier(42)).toBe('#0042');
    expect(formatMemberIdentifier(1)).toBe('#0001');
  });

  it('lets a number past four digits grow rather than truncating it', () => {
    expect(formatMemberIdentifier(123456)).toBe('#123456');
  });

  it('pads a numeric string the same as the number, so the client that returns text agrees', () => {
    expect(formatMemberIdentifier('42')).toBe('#0042');
  });

  // The reason this function exists: the column is on its way to a random
  // seven-character code, and the page must not have to change when it lands.
  it('passes a non-numeric code through without inventing padding', () => {
    expect(formatMemberIdentifier('k7f2b9q')).toBe('#K7F2B9Q');
  });

  it('is null when there is no identifier to show', () => {
    expect(formatMemberIdentifier(null)).toBeNull();
    expect(formatMemberIdentifier(undefined)).toBeNull();
    expect(formatMemberIdentifier('')).toBeNull();
    expect(formatMemberIdentifier('   ')).toBeNull();
    expect(formatMemberIdentifier({})).toBeNull();
  });
});
