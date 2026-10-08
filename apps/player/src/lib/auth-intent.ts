// Pure helpers for the sign-in and signup pages and the /auth/callback route.
//
// Deep import, not the '@badminton/shared' barrel: the callback route and both
// pages only need the two token shapes, and constants.ts has no dependencies.
import {
  CHECKIN_TOKEN_REGEX,
  DISCORD_LINK_TOKEN_REGEX,
} from '@badminton/shared/src/utils/constants';

export type AuthTokenParam = { key: 'checkin' | 'discord'; token: string };

/**
 * The check-in or Discord link token a signed-out visitor arrived with, if any.
 *
 * A player who scans a session QR while logged out arrives at
 * /login?checkin=<token>; carrying that token through sign-in lands them back
 * on /checkin/<token> instead of silently losing it. Deliberately a
 * single-purpose token rather than a `next=` path: an arbitrary redirect
 * target is an open redirect waiting to happen, and a 48-hex token can only
 * ever be one route. The Discord bot's /link button is the second case with
 * exactly this shape. Anything malformed is dropped.
 */
export function authTokenParam(search: string): AuthTokenParam | null {
  const params = new URLSearchParams(search);

  const checkin = params.get('checkin') ?? '';
  if (CHECKIN_TOKEN_REGEX.test(checkin)) return { key: 'checkin', token: checkin };

  const discord = params.get('discord') ?? '';
  if (DISCORD_LINK_TOKEN_REGEX.test(discord)) return { key: 'discord', token: discord };

  return null;
}

/**
 * The query suffix every sign-in hand-off carries: the validated token first,
 * then any `extra` entries in insertion order. '' when there is nothing.
 *
 * ONE function for every hand-off (to /auth/callback for Google and emailed
 * codes, to /auth/post-login for everything else, and between /login and
 * /signup), because missing any one of them would break exactly one sign-in
 * method, silently, and only for members who happen to use that method.
 */
export function authSuffix(search: string, extra?: Record<string, string>): string {
  const out = new URLSearchParams();
  const tokenParam = authTokenParam(search);
  if (tokenParam) out.set(tokenParam.key, tokenParam.token);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) out.set(key, value);
  }
  const query = out.toString();
  return query ? `?${query}` : '';
}

/** Why /signup was reached: a sign-in attempt that found no account. */
export const SIGNUP_NOTICE = 'no-account' as const;

export function parseSignupNotice(value: string | null): typeof SIGNUP_NOTICE | null {
  return value === SIGNUP_NOTICE ? SIGNUP_NOTICE : null;
}

/** The /login?error=auth_failed the callback sends when an exchange fails. */
export function parseAuthError(value: string | null): 'auth_failed' | null {
  return value === 'auth_failed' ? 'auth_failed' : null;
}

/**
 * The "this Google round trip is a SIGN-IN, not a signup" marker.
 *
 * A short-lived cookie rather than a query param on redirectTo: the redirect
 * URL stays byte-identical to what GoTrue's allow-list already accepts, so a
 * strict allow-list cannot silently bounce every Google sign-in to SITE_URL.
 * Forging it only makes sign-in stricter for whoever forges it, so it is not a
 * security boundary. The name must never start with the auth cookie's name,
 * which the cookie-clear helpers match by prefix.
 */
export const LOGIN_INTENT_COOKIE = 'login_intent';
export const LOGIN_INTENT_SIGNIN = 'signin';

export function isSigninIntent(value: string | undefined | null): boolean {
  return value === LOGIN_INTENT_SIGNIN;
}

export function loginIntentCookieString(secure: boolean): string {
  return `${LOGIN_INTENT_COOKIE}=${LOGIN_INTENT_SIGNIN}; Path=/auth; Max-Age=600; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearLoginIntentCookieString(secure: boolean): string {
  return `${LOGIN_INTENT_COOKIE}=; Path=/auth; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * Where the callback sends a Google sign-in that found no account. The token
 * is re-validated here rather than trusted from the previous hop: every step
 * of the chain checks the shape again, so no single missed check turns it into
 * an open redirect.
 */
export function signupRejectPath(tokenParam: AuthTokenParam | null): string {
  const path = `/signup?notice=${SIGNUP_NOTICE}`;
  if (!tokenParam) return path;
  const regex = tokenParam.key === 'checkin' ? CHECKIN_TOKEN_REGEX : DISCORD_LINK_TOKEN_REGEX;
  return regex.test(tokenParam.token) ? `${path}&${tokenParam.key}=${tokenParam.token}` : path;
}
