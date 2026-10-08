import { describe, it, expect } from 'vitest';
import { REASON_MIN, requireReason } from '../audit-reason';

// The console's rule is that every audited action carries a typed reason. The
// dialog asks for one; this is what makes it true when the dialog is not there
// — a stale tab, a client that never rendered the field, a direct call to the
// server action.

describe('requireReason', () => {
  it('accepts a reason at the floor and above', () => {
    expect(requireReason('Typo.', 'Editing a session')).toBe('Typo.');
    expect(requireReason('Gym double-booked', 'Editing a session')).toBe('Gym double-booked');
  });

  it('returns the trimmed string, not what was typed', () => {
    // What lands in audit_logs.reason should not carry the whitespace that got
    // it past the length check.
    expect(requireReason('  Moved to Court 3  ', 'Editing a session')).toBe('Moved to Court 3');
  });

  it('refuses whitespace padded out to the floor', () => {
    // THE CASE THE CLIENT CANNOT CATCH ON ITS OWN. `required` on an input is
    // satisfied by a single character, and eight spaces is longer than five.
    expect(() => requireReason('        ', 'Editing a session')).toThrow(/at least 5 characters/);
    expect(() => requireReason('  .  ', 'Editing a session')).toThrow(/at least 5 characters/);
  });

  it('refuses empty and near-empty reasons', () => {
    expect(() => requireReason('', 'Editing a session')).toThrow();
    expect(() => requireReason('fix', 'Editing a session')).toThrow();
  });

  it('names what was refused, so the toast says which action failed', () => {
    expect(() => requireReason('', 'Archiving a session')).toThrow(
      'Archiving a session needs a reason of at least 5 characters.',
    );
    expect(() => requireReason('', 'Deleting a session')).toThrow(/^Deleting a session/);
  });

  it('survives a missing argument rather than throwing on .trim()', () => {
    // A server action reached with the argument absent should get the rule's
    // error message, not a TypeError from inside the check.
    expect(() => requireReason(undefined as unknown as string, 'Editing a session')).toThrow(
      /at least 5 characters/,
    );
  });

  it('is enforced at exactly REASON_MIN characters', () => {
    expect(requireReason('a'.repeat(REASON_MIN), 'x')).toHaveLength(REASON_MIN);
    expect(() => requireReason('a'.repeat(REASON_MIN - 1), 'x')).toThrow();
  });
});
