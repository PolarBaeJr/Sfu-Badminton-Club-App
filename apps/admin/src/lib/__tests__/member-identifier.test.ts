import { describe, it, expect } from 'vitest';
import { memberIdentifier } from '../member-identifier';

/**
 * The point of these is the CHOICE — handle, else code, else nothing — not the
 * formatting. Formatting a code is shared's job now, and is tested there; this
 * file used to duplicate it only because the column's shape was mid-change.
 */
describe('memberIdentifier', () => {
  it('prefers the handle, written the way the club writes it', () => {
    expect(memberIdentifier({ handle: 'kiera', member_code: 'K3F9TQ2' })).toBe('@kiera');
  });

  it('falls back to the code for the members who have not picked one', () => {
    expect(memberIdentifier({ handle: null, member_code: 'K3F9TQ2' })).toBe('K3F9TQ2');
  });

  it('uppercases the code, so a column of them is not ragged', () => {
    expect(memberIdentifier({ handle: null, member_code: 'k3f9tq2' })).toBe('K3F9TQ2');
  });

  it('does not pad or prefix — a code is not a number', () => {
    const identifier = memberIdentifier({ handle: null, member_code: 'K3F9TQ2' });
    expect(identifier).not.toContain('#');
    expect(identifier).toHaveLength(7);
  });

  it('treats a blank handle as no handle at all', () => {
    expect(memberIdentifier({ handle: '   ', member_code: 'K3F9TQ2' })).toBe('K3F9TQ2');
  });

  it('is null when there is neither — a pending signup has no code yet', () => {
    expect(memberIdentifier({ handle: null, member_code: null })).toBeNull();
  });
});
