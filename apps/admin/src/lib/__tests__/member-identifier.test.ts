import { describe, it, expect } from 'vitest';
import { formatMemberIdentifier, memberIdentifier } from '../member-identifier';

/**
 * The point of these is the SHAPE CHANGE, not the formatting. member_number is
 * an integer today and a seven-character code shortly; the roster has to render
 * both without an edit, because a migration is not instantaneous and the two
 * shapes coexist while it runs.
 */
describe('formatMemberIdentifier', () => {
  it('pads the integer shape the column holds today', () => {
    expect(formatMemberIdentifier(42)).toBe('#0042');
    expect(formatMemberIdentifier(7)).toBe('#0007');
  });

  it('lets a number past four digits grow rather than truncating it', () => {
    expect(formatMemberIdentifier(12345)).toBe('#12345');
  });

  it('leaves the seven-character code alone — padding it would invent characters', () => {
    expect(formatMemberIdentifier('AB12X9K')).toBe('#AB12X9K');
  });

  it('uppercases a code, so a column of them is not ragged', () => {
    expect(formatMemberIdentifier('ab12x9k')).toBe('#AB12X9K');
  });

  it('treats a numeric STRING as the number it is — the shape mid-migration', () => {
    expect(formatMemberIdentifier('42')).toBe('#0042');
  });

  it('is null for a member who has none, so the caller drops the line', () => {
    expect(formatMemberIdentifier(null)).toBeNull();
    expect(formatMemberIdentifier(undefined)).toBeNull();
    expect(formatMemberIdentifier('')).toBeNull();
    expect(formatMemberIdentifier('   ')).toBeNull();
  });
});

describe('memberIdentifier', () => {
  it('prefers the handle, written the way the club writes it', () => {
    expect(memberIdentifier({ handle: 'kiera', member_number: 42 })).toBe('@kiera');
  });

  it('falls back to the number for the members who have not picked one', () => {
    expect(memberIdentifier({ handle: null, member_number: 42 })).toBe('#0042');
  });

  it('is null when there is neither — a pending signup has no number yet', () => {
    expect(memberIdentifier({ handle: null, member_number: null })).toBeNull();
  });
});
