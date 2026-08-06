import { describe, it, expect } from 'vitest';
import { ExpectedError, isExpectedFailure } from '../utils/expected-error';

// These three all reached Sentry as faults on prod despite being the system
// working: an exec opening an admin-only page, a member checking in early, and
// a member mistyping a score (8 reports in one minute from one person).
describe('isExpectedFailure', () => {
  it('accepts an explicit ExpectedError', () => {
    expect(isExpectedFailure(new ExpectedError('Admin access required'))).toBe(true);
  });

  it('accepts an allowlisted guard arriving as a PLAIN Error', () => {
    // The gap: isExpectedError alone returned false here, so it was reported.
    expect(isExpectedFailure(new Error('Not a possible score for this format: 15-2'))).toBe(true);
  });

  it('still treats an unrecognised error as a fault', () => {
    expect(isExpectedFailure(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('does not throw on non-Error values', () => {
    expect(isExpectedFailure(null)).toBe(false);
    expect(isExpectedFailure('a string')).toBe(false);
    expect(isExpectedFailure({ message: 42 })).toBe(false);
  });
});
