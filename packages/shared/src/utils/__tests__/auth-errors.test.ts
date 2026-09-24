import { describe, it, expect } from 'vitest';
import { friendlyAuthError } from '../auth-errors';

describe('friendlyAuthError', () => {
  it('turns the per-address cooldown into "a code was sent" with the seconds left', () => {
    expect(
      friendlyAuthError('For security purposes, you can only request this after 32 seconds.'),
    ).toBe('A code was sent to this email moments ago. Check your inbox, or ask for a new one in 32 seconds.');
    expect(friendlyAuthError('you can only request this after 1 second')).toMatch(/in 1 second\.$/);
  });

  it('keeps a generic message for other rate limits', () => {
    expect(friendlyAuthError('email rate limit exceeded')).toBe(
      'Too many attempts. Please wait a minute before trying again.',
    );
  });

  it('maps an empty gateway body and passes anything else through', () => {
    expect(friendlyAuthError('{}')).toMatch(/reaching the server/);
    expect(friendlyAuthError('Token has expired or is invalid')).toBe('Token has expired or is invalid');
  });

  it('writes no em dash', () => {
    for (const m of ['{}', 'email rate limit exceeded', 'after 5 seconds']) {
      expect(friendlyAuthError(m)).not.toContain('—');
    }
  });
});
