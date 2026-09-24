import { describe, it, expect } from 'vitest';

import {
  authSuffix,
  authTokenParam,
  clearLoginIntentCookieString,
  isSigninIntent,
  loginIntentCookieString,
  parseAuthError,
  parseSignupNotice,
  signupRejectPath,
} from '../auth-intent';

const CHECKIN = 'a'.repeat(48);
const DISCORD = 'b'.repeat(64);

describe('authSuffix', () => {
  it('carries a valid check-in token', () => {
    expect(authSuffix(`?checkin=${CHECKIN}`)).toBe(`?checkin=${CHECKIN}`);
  });

  it('drops a malformed token', () => {
    expect(authSuffix('?checkin=abc')).toBe('');
    expect(authSuffix(`?checkin=${'A'.repeat(48)}`)).toBe('');
  });

  it('prefers the check-in token over the discord one', () => {
    expect(authSuffix(`?discord=${DISCORD}&checkin=${CHECKIN}`)).toBe(`?checkin=${CHECKIN}`);
  });

  it('carries a valid discord token', () => {
    expect(authSuffix(`?discord=${DISCORD}`)).toBe(`?discord=${DISCORD}`);
  });

  it('appends extras after the token', () => {
    expect(authSuffix(`?checkin=${CHECKIN}`, { notice: 'no-account' })).toBe(
      `?checkin=${CHECKIN}&notice=no-account`
    );
  });

  it('builds extras alone when there is no token', () => {
    expect(authSuffix('', { notice: 'no-account' })).toBe('?notice=no-account');
  });

  it('never carries any other parameter, an email least of all', () => {
    expect(authSuffix('?email=member@example.com')).toBe('');
    expect(authSuffix('?notice=no-account')).toBe('');
  });
});

describe('authTokenParam', () => {
  it('names the key the token belongs to', () => {
    expect(authTokenParam(`?checkin=${CHECKIN}`)).toEqual({ key: 'checkin', token: CHECKIN });
    expect(authTokenParam(`?discord=${DISCORD}`)).toEqual({ key: 'discord', token: DISCORD });
    expect(authTokenParam('')).toBeNull();
  });
});

describe('parseSignupNotice', () => {
  it('accepts the exact literal only', () => {
    expect(parseSignupNotice('no-account')).toBe('no-account');
    expect(parseSignupNotice('No-Account')).toBeNull();
    expect(parseSignupNotice('no-account ')).toBeNull();
    expect(parseSignupNotice('x')).toBeNull();
    expect(parseSignupNotice(null)).toBeNull();
  });
});

describe('parseAuthError', () => {
  it('accepts the exact literal only', () => {
    expect(parseAuthError('auth_failed')).toBe('auth_failed');
    expect(parseAuthError('<script>')).toBeNull();
    expect(parseAuthError(null)).toBeNull();
  });
});

describe('isSigninIntent', () => {
  it('is true for the exact sign-in marker only', () => {
    expect(isSigninIntent('signin')).toBe(true);
    expect(isSigninIntent('signup')).toBe(false);
    expect(isSigninIntent('')).toBe(false);
    expect(isSigninIntent(undefined)).toBe(false);
    expect(isSigninIntent(null)).toBe(false);
    expect(isSigninIntent('signin ')).toBe(false);
  });
});

describe('the intent cookie', () => {
  it('is scoped to /auth, Lax and short-lived', () => {
    const set = loginIntentCookieString(false);
    expect(set).toContain('login_intent=signin');
    expect(set).toContain('Path=/auth');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Max-Age=600');
    expect(set).not.toContain('Secure');
  });

  it('is Secure only when asked', () => {
    expect(loginIntentCookieString(true)).toContain('; Secure');
  });

  it('clears on the same path', () => {
    const clear = clearLoginIntentCookieString(true);
    expect(clear).toContain('login_intent=;');
    expect(clear).toContain('Path=/auth');
    expect(clear).toContain('Max-Age=0');
    expect(clear).toContain('; Secure');
  });

  it('never shares a prefix with the auth cookie', () => {
    expect(loginIntentCookieString(false).startsWith('sb-')).toBe(false);
  });
});

describe('signupRejectPath', () => {
  it('sends a bare rejection to the signup notice', () => {
    expect(signupRejectPath(null)).toBe('/signup?notice=no-account');
  });

  it('carries a valid token', () => {
    expect(signupRejectPath({ key: 'checkin', token: CHECKIN })).toBe(
      `/signup?notice=no-account&checkin=${CHECKIN}`
    );
    expect(signupRejectPath({ key: 'discord', token: DISCORD })).toBe(
      `/signup?notice=no-account&discord=${DISCORD}`
    );
  });

  it('drops a token that does not match its shape', () => {
    expect(signupRejectPath({ key: 'checkin', token: 'not-a-token' })).toBe('/signup?notice=no-account');
    expect(signupRejectPath({ key: 'checkin', token: DISCORD })).toBe('/signup?notice=no-account');
  });
});
