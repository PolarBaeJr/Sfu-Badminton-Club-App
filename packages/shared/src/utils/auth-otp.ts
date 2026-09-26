/**
 * Email sign-in by 6-digit code, shared by the player app and the console.
 *
 * The GoTrue templates send a code rather than a magic link, because corporate
 * link scanners (SFU/Microsoft Safe Links) pre-fetch a link and consume the
 * one-time token before the recipient ever clicks it.
 */

/**
 * GoTrue issues a different OTP token type per flow (verified against the live
 * DB by the player app, which hit this first): an existing account gets a
 * `recovery` token, an account that has never confirmed its email a `signup`
 * (confirmation) token. The `type: 'email'` the docs suggest matches neither
 * and always fails with "Invalid email verification type".
 *
 * Sign-in only ever signs an existing account in (signInWithOtp() passes
 * shouldCreateUser: false), so `recovery` goes first. `signup` stays behind it
 * for the account that was created but never confirmed. A wrong-type attempt
 * reads a different token column and fails without touching the real token,
 * so trying both in turn is safe.
 */
export const SIGNIN_OTP_TYPES = ['recovery', 'signup'] as const;

/**
 * The signup page's order: a brand-new address gets a `signup` token, and an
 * existing member who typed their address into the signup form gets a
 * `recovery` one, so that is the fallback.
 */
export const SIGNUP_OTP_TYPES = ['signup', 'recovery'] as const;

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
 * quietly minting an account for it. It refuses with HTTP 422, code
 * `otp_disabled`, in signup-disabled language ("Signups not allowed for otp"),
 * which reads as a misconfiguration rather than as the typo it usually is.
 * The message is matched loosely: the wording is GoTrue's and has changed
 * between releases. Takes either the bare message or the error object.
 */
export function isUnknownAccountError(
  err: string | { message?: string; code?: string } | null | undefined
): boolean {
  if (!err) return false;
  if (typeof err !== 'string' && err.code === 'otp_disabled') return true;
  const message = typeof err === 'string' ? err : err.message;
  return /signups? not allowed|otp[_ ]disabled/i.test(message ?? '');
}

/**
 * Whether a failed code send is worth one silent retry. The auth gateway can
 * 503 on the first request after an idle period, arriving with a "{}" body;
 * retrying that makes it invisible. Nothing else is retried: a rate limit
 * would only be pushed further, and an unknown account would be refused again.
 */
export function shouldRetryOtpSend(
  err: { message?: string; code?: string; status?: number } | null | undefined
): boolean {
  if (!err) return false;
  if (isUnknownAccountError(err)) return false;
  const msg = (err.message ?? '').trim();
  if (/rate|after \d|security purposes|too many/i.test(msg)) return false;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  return !msg || msg === '{}' || msg === '[object Object]';
}
