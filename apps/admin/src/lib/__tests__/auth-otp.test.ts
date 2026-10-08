import { describe, it, expect } from 'vitest';

import { SIGNIN_OTP_TYPES, shouldTryNextOtpType, isUnknownAccountError } from '../auth-otp';

describe('SIGNIN_OTP_TYPES', () => {
  it('tries the existing-account type first', () => {
    expect(SIGNIN_OTP_TYPES[0]).toBe('recovery');
  });

  it('keeps a fallback for an account that never confirmed its email', () => {
    expect([...SIGNIN_OTP_TYPES]).toEqual(['recovery', 'signup']);
  });
});

describe('shouldTryNextOtpType', () => {
  it('falls through when the token type was wrong', () => {
    expect(shouldTryNextOtpType('Invalid email verification type')).toBe(true);
    expect(shouldTryNextOtpType('Token not found')).toBe(true);
  });

  // GoTrue gives a wrong-type attempt this same message, so an unconfirmed
  // account's valid code was reported expired before the signup type was tried.
  it('falls through on GoTrue\'s expired-or-invalid answer', () => {
    expect(shouldTryNextOtpType('Token has expired or is invalid')).toBe(true);
  });

  it('stops on anything that is not a token mismatch', () => {
    expect(shouldTryNextOtpType('Email rate limit exceeded')).toBe(false);
    expect(shouldTryNextOtpType('Failed to fetch')).toBe(false);
  });

  it('stops when there is no message at all', () => {
    expect(shouldTryNextOtpType('')).toBe(false);
    expect(shouldTryNextOtpType(undefined as unknown as string)).toBe(false);
  });
});

describe('isUnknownAccountError', () => {
  it('recognises GoTrue refusing to create an account', () => {
    expect(isUnknownAccountError('Signups not allowed for otp')).toBe(true);
    expect(isUnknownAccountError('otp_disabled')).toBe(true);
  });

  it('leaves every other failure to the generic handler', () => {
    expect(isUnknownAccountError('Token has expired or is invalid')).toBe(false);
    expect(isUnknownAccountError('')).toBe(false);
  });
});
