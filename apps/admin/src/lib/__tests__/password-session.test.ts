import { describe, it, expect } from 'vitest';
import { isPasswordOnlySession } from '../password-session';

describe('isPasswordOnlySession', () => {
  it('flags a session made with a password alone, in either claim shape', () => {
    expect(isPasswordOnlySession(['password'])).toBe(true);
    expect(isPasswordOnlySession([{ method: 'password', timestamp: 1700000000 }])).toBe(true);
    expect(
      isPasswordOnlySession([
        { method: 'password', timestamp: 1700000000 },
        { method: 'password', timestamp: 1700000100 },
      ]),
    ).toBe(true);
  });

  it('passes a code, Google or passkey session', () => {
    expect(isPasswordOnlySession(['otp'])).toBe(false);
    expect(isPasswordOnlySession([{ method: 'otp', timestamp: 1700000000 }])).toBe(false);
    expect(isPasswordOnlySession([{ method: 'recovery', timestamp: 1700000000 }])).toBe(false);
    expect(isPasswordOnlySession([{ method: 'magiclink', timestamp: 1700000000 }])).toBe(false);
    expect(isPasswordOnlySession([{ method: 'oauth', timestamp: 1700000000 }])).toBe(false);
  });

  it('passes a password that was stepped up with a second method', () => {
    expect(isPasswordOnlySession(['password', 'totp'])).toBe(false);
    expect(
      isPasswordOnlySession([
        { method: 'password', timestamp: 1700000000 },
        { method: 'mfa/webauthn', timestamp: 1700000100 },
      ]),
    ).toBe(false);
  });

  it('passes a claim it cannot judge', () => {
    expect(isPasswordOnlySession([])).toBe(false);
    expect(isPasswordOnlySession(undefined)).toBe(false);
    expect(isPasswordOnlySession(null)).toBe(false);
    expect(isPasswordOnlySession('password')).toBe(false);
  });

  it('does not treat a malformed entry as a password', () => {
    expect(isPasswordOnlySession([{ timestamp: 1700000000 }])).toBe(false);
    expect(isPasswordOnlySession([{ method: 'password' }, null])).toBe(false);
    expect(isPasswordOnlySession([42])).toBe(false);
  });
});
