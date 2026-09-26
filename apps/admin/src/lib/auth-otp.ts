/**
 * Email sign-in by 6-digit code, as the console needs it.
 *
 * The GoTrue templates send a code rather than a magic link, because corporate
 * link scanners (SFU/Microsoft Safe Links) pre-fetch a link and consume the
 * one-time token before the recipient ever clicks it. The console is also
 * sign-in only — it has no signup tab — and both rules below follow from that.
 */

/**
 * GoTrue issues a different OTP token type per flow (verified against the live
 * DB by the player app, which hit this first): an existing account gets a
 * `recovery` token, an account that has never confirmed its email a `signup`
 * (confirmation) token. The `type: 'email'` the docs suggest matches neither
 * and always fails with "Invalid email verification type".
 *
 * The console only ever signs an existing account in — signInWithOtp() passes
 * shouldCreateUser: false — so `recovery` goes first. `signup` stays behind it
 * for the admin whose account was created but never confirmed. A wrong-type
 * attempt reads a different token column and fails without touching the real
 * token, so trying both in turn is safe.
 */
export const SIGNIN_OTP_TYPES = ['recovery', 'signup'] as const;

/**
 * Fall through to the next token type when the code did not match. GoTrue
 * answers a wrong-type attempt exactly as it answers a wrong or expired code,
 * "Token has expired or is invalid", so the two cannot be told apart and the
 * other type must be tried before the code is called expired. Anything else
 * (a rate limit, a network failure) surfaces immediately.
 */
export function shouldTryNextOtpType(message: string): boolean {
  return /verification type|not found|expired or is invalid/i.test(message ?? '');
}

/**
 * shouldCreateUser: false makes GoTrue refuse an unknown address instead of
 * quietly minting an account for it. It refuses in signup-disabled language
 * ("Signups not allowed for otp"), which reads as a misconfigured console
 * rather than as the typo it usually is. Matched loosely: the wording is
 * GoTrue's and has changed between releases.
 */
export function isUnknownAccountError(message: string): boolean {
  return /signups? not allowed|otp[_ ]disabled/i.test(message ?? '');
}
