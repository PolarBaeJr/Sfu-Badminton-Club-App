import { describe, it, expect } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isReauthNeededError,
  isSamePasswordError,
  passwordProblem,
} from '../password-policy';

describe('passwordProblem', () => {
  it('holds the limits GoTrue is configured with', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(10);
    expect(PASSWORD_MAX_LENGTH).toBe(72);
  });

  it('refuses one short of the minimum and accepts the minimum', () => {
    expect(passwordProblem('a'.repeat(9))).toMatch(/at least 10/);
    expect(passwordProblem('a'.repeat(10))).toBeNull();
  });

  it('accepts the maximum and refuses one past it', () => {
    expect(passwordProblem('a'.repeat(72))).toBeNull();
    expect(passwordProblem('a'.repeat(73))).toMatch(/at most 72/);
  });

  it('measures the maximum in bytes, the way bcrypt does', () => {
    // 36 characters, 72 bytes: fine. 37 characters, 74 bytes: too long.
    expect(passwordProblem('é'.repeat(36))).toBeNull();
    expect(passwordProblem('é'.repeat(37))).toMatch(/at most 72/);
  });

  it('refuses an empty or all-whitespace password', () => {
    expect(passwordProblem('')).toMatch(/Choose a password/);
    expect(passwordProblem(' '.repeat(12))).toMatch(/Choose a password/);
  });

  it('asks for no particular mix of characters', () => {
    expect(passwordProblem('correct horse battery')).toBeNull();
  });

  it('writes no em dash', () => {
    for (const p of ['', 'short', 'a'.repeat(80)]) expect(passwordProblem(p)).not.toContain('—');
  });
});

describe('isSamePasswordError', () => {
  it('matches by code and by message', () => {
    expect(isSamePasswordError({ code: 'same_password', message: 'x' })).toBe(true);
    expect(
      isSamePasswordError({ message: 'New password should be different from the old password.' }),
    ).toBe(true);
  });

  it('matches nothing else', () => {
    expect(isSamePasswordError({ code: 'weak_password', message: 'Password should be at least 10 characters.' })).toBe(false);
    expect(isSamePasswordError(null)).toBe(false);
  });
});

describe('isReauthNeededError', () => {
  it('matches by code and by message', () => {
    expect(isReauthNeededError({ code: 'reauthentication_needed', message: 'x' })).toBe(true);
    expect(isReauthNeededError({ message: 'Password update requires reauthentication' })).toBe(true);
  });

  it('does not match a rejected nonce, which a new code will not fix by itself', () => {
    expect(isReauthNeededError({ code: 'reauthentication_not_valid', message: 'Reauthentication failed' })).toBe(false);
    expect(isReauthNeededError(undefined)).toBe(false);
  });
});
