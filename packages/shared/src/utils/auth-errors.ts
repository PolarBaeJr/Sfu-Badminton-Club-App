import type { ErrorCode } from './error-codes';

// Supabase auth errors reach the client as raw strings; a gateway 503 arrives
// with a "{}" body and rate limits phrase themselves oddly. Map both to
// something a human can act on instead of leaking the raw payload.
//
// Lives here rather than in either login page because both of them sign people
// in with the same auth gateway and hit the same unhelpful strings.
export function friendlyAuthError(message: string): string {
  const msg = (message ?? '').trim();
  if (!msg || msg === '{}' || msg === '[object Object]') {
    return 'Something went wrong reaching the server. Please try again in a moment.';
  }
  // GoTrue allows one email per address per minute and says how long is left
  // ("you can only request this after 32 seconds"). That refusal means a code
  // WAS sent moments ago, so point at the inbox and keep the countdown.
  const wait = msg.match(/after (\d+) seconds?/i);
  if (wait) {
    const n = Number(wait[1]);
    return `A code was sent to this email moments ago. Check your inbox, or ask for a new one in ${n} second${n === 1 ? '' : 's'}.`;
  }
  if (/rate|security purposes|too many/i.test(msg)) {
    return 'Too many attempts. Please wait a minute before trying again.';
  }
  return msg;
}

const AUTH_CODES: Record<string, ErrorCode> = {
  over_email_send_rate_limit: 'AUTH-201',
  over_request_rate_limit: 'AUTH-202',
  otp_expired: 'AUTH-203',
  otp_disabled: 'AUTH-204',
  signup_disabled: 'AUTH-204',
  bad_oauth_state: 'AUTH-206',
  bad_oauth_callback: 'AUTH-206',
  flow_state_expired: 'AUTH-206',
  flow_state_not_found: 'AUTH-206',
  bad_code_verifier: 'AUTH-206',
  user_banned: 'AUTH-207',
};

// The registry code for an auth failure, so a banner can say which one it was.
// GoTrue's own `code` wins when it has one; older responses and the gateway's
// empty body only have a message, so that is read the way friendlyAuthError
// reads it.
export function authErrorCode(
  err: { message?: string | null; code?: string | null; status?: number | null } | string | null | undefined,
): ErrorCode {
  const e = typeof err === 'string' ? { message: err } : err ?? {};
  const mapped = e.code ? AUTH_CODES[e.code] : undefined;
  if (mapped) return mapped;
  if (typeof e.status === 'number' && e.status >= 500) return 'AUTH-205';
  const msg = (e.message ?? '').trim();
  if (!msg || msg === '{}' || msg === '[object Object]') return 'AUTH-205';
  if (/after \d+ seconds?/i.test(msg)) return 'AUTH-201';
  if (/rate|security purposes|too many/i.test(msg)) return 'AUTH-202';
  if (/token has expired or is invalid/i.test(msg)) return 'AUTH-203';
  return 'AUTH-000';
}

/** A banner's text with the code after it, for the member to quote. */
export function withErrorCode(message: string, code: ErrorCode): string {
  return `${message} (${code})`;
}
