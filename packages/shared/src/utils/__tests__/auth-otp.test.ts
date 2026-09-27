import { describe, it, expect } from 'vitest';

import {
  SIGNIN_OTP_TYPES,
  SIGNUP_OTP_TYPES,
  isUnknownAccountError,
  shouldRetryOtpSend,
  shouldTryNextOtpType,
} from '../auth-otp';

describe('OTP type order', () => {
  it('tries the existing-account type first on sign-in', () => {
    expect([...SIGNIN_OTP_TYPES]).toEqual(['recovery', 'signup']);
  });

  it('tries the new-account type first on signup', () => {
    expect([...SIGNUP_OTP_TYPES]).toEqual(['signup', 'recovery']);
  });

  it('falls through only on a type mismatch', () => {
    expect(shouldTryNextOtpType('Invalid email verification type')).toBe(true);
    expect(shouldTryNextOtpType('Email rate limit exceeded')).toBe(false);
  });

  // GoTrue gives a wrong-type attempt this same message, so an unconfirmed
  // account's valid code was reported expired before the signup type was tried.
  it('falls through on GoTrue\'s expired-or-invalid answer', () => {
    expect(shouldTryNextOtpType('Token has expired or is invalid')).toBe(true);
  });
});

describe('isUnknownAccountError', () => {
  it('recognises GoTrue refusing to create an account', () => {
    expect(isUnknownAccountError({ code: 'otp_disabled', message: 'x' })).toBe(true);
    expect(isUnknownAccountError({ message: 'Signups not allowed for otp' })).toBe(true);
    expect(isUnknownAccountError('Signups not allowed for otp')).toBe(true);
    expect(isUnknownAccountError('otp_disabled')).toBe(true);
  });

  it('leaves every other failure to the generic handler', () => {
    expect(isUnknownAccountError(null)).toBe(false);
    expect(isUnknownAccountError(undefined)).toBe(false);
    expect(isUnknownAccountError('')).toBe(false);
    expect(isUnknownAccountError('Token has expired or is invalid')).toBe(false);
    expect(isUnknownAccountError({ message: 'Token has expired or is invalid' })).toBe(false);
  });
});

describe('shouldRetryOtpSend', () => {
  it('retries a gateway blip', () => {
    expect(shouldRetryOtpSend({ status: 503, message: '{}' })).toBe(true);
    expect(shouldRetryOtpSend({ message: '' })).toBe(true);
    expect(shouldRetryOtpSend({ message: '[object Object]' })).toBe(true);
  });

  it('never retries an unknown account', () => {
    expect(
      shouldRetryOtpSend({ status: 422, code: 'otp_disabled', message: 'Signups not allowed for otp' })
    ).toBe(false);
  });

  it('never retries a rate limit, which would only push it further', () => {
    expect(shouldRetryOtpSend({ status: 429, message: 'Email rate limit exceeded' })).toBe(false);
    expect(
      shouldRetryOtpSend({ message: 'For security purposes, you can only request this after 30 seconds.' })
    ).toBe(false);
  });

  it('does not retry an ordinary failure or no failure at all', () => {
    expect(shouldRetryOtpSend({ status: 400, message: 'Unable to validate email address' })).toBe(false);
    expect(shouldRetryOtpSend(null)).toBe(false);
  });
});
