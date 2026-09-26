import { describe, it, expect } from 'vitest';
import { authErrorCode, friendlyAuthError, withErrorCode } from '../auth-errors';

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

describe('authErrorCode', () => {
  it("prefers GoTrue's own code", () => {
    expect(authErrorCode({ message: 'x', code: 'over_email_send_rate_limit' })).toBe('AUTH-201');
    expect(authErrorCode({ message: 'x', code: 'over_request_rate_limit' })).toBe('AUTH-202');
    expect(authErrorCode({ message: 'x', code: 'otp_expired' })).toBe('AUTH-203');
    expect(authErrorCode({ message: 'x', code: 'signup_disabled' })).toBe('AUTH-204');
    expect(authErrorCode({ message: 'x', code: 'flow_state_expired' })).toBe('AUTH-206');
    expect(authErrorCode({ message: 'x', code: 'user_banned' })).toBe('AUTH-207');
  });

  it('reads the message the way friendlyAuthError does when there is no code', () => {
    expect(authErrorCode('For security purposes, you can only request this after 32 seconds.')).toBe('AUTH-201');
    expect(authErrorCode('email rate limit exceeded')).toBe('AUTH-202');
    expect(authErrorCode('Token has expired or is invalid')).toBe('AUTH-203');
    expect(authErrorCode('{}')).toBe('AUTH-205');
    expect(authErrorCode({ message: 'Bad Gateway', status: 502 })).toBe('AUTH-205');
    expect(authErrorCode('Something new')).toBe('AUTH-000');
    expect(authErrorCode(null)).toBe('AUTH-205');
  });

  it('appends the code without touching the text', () => {
    expect(withErrorCode(friendlyAuthError('{}'), 'AUTH-205')).toBe(`${friendlyAuthError('{}')} (AUTH-205)`);
  });
});
