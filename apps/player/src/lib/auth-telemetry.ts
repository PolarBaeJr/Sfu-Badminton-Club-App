// Sign-in failures, reported to Sentry so a member's "it didn't work" arrives
// with the actual error. Before this, a failed passkey or email code left no
// trace anywhere: the browser swallowed it and the server never saw it.
//
// Privacy: nothing that identifies the member is sent. No email, no code, no
// player id (the scope's user is cleared), and no breadcrumbs, because those
// can carry request URLs from the same page. Sentry still records the browser
// and OS from the user agent, which is the part this is for.
//
// A password must never go in `message` or `extra`. scrubAuthText below only
// catches emails and 6-digit codes; it cannot recognise a password.
import * as Sentry from '@sentry/nextjs';

export type AuthFlow =
  | 'passkey_signin'
  | 'passkey_enrol'
  | 'email_code_send'
  | 'email_code_verify'
  | 'password_signin'
  | 'password_set'
  | 'password_reauth';

export type AuthStage = 'options' | 'ceremony' | 'verify' | 'send' | 'update';

export type AuthFailure = {
  flow: AuthFlow;
  stage: AuthStage;
  /** DOMException name, GoTrue error code, or HTTP status, whichever applies. */
  error: string;
  /** Free-text detail. Must never contain the email or the code. */
  message?: string;
  /** How long the failing step took. A passkey "cancel" in under ~300ms was
   *  never shown to the member: the OS refused it outright. */
  elapsedMs?: number;
  extra?: Record<string, string | number | boolean | null>;
};

// Anything shaped like an email, or a run of 6 digits, is scrubbed from the
// message in case an upstream error ever echoes one back.
export function scrubAuthText(text: string): string {
  return text
    .replace(/[^\s@<>"']+@[^\s@<>"']+/g, '<email>')
    .replace(/\b\d{6}\b/g, '<code>');
}

export function buildAuthFailureEvent(f: AuthFailure) {
  // A member closing the passkey sheet is normal. Keep it, at info, because
  // an instant one is the signature of the OS refusing the sheet.
  const cancelled = f.error === 'NotAllowedError' || f.error === 'AbortError';
  return {
    message: `auth failure: ${f.flow} at ${f.stage}`,
    level: (cancelled ? 'info' : 'warning') as 'info' | 'warning',
    fingerprint: ['auth-failure', f.flow, f.stage, f.error],
    tags: { auth_flow: f.flow, auth_stage: f.stage, auth_error: f.error },
    extra: {
      message: f.message === undefined ? null : scrubAuthText(f.message),
      elapsed_ms: f.elapsedMs ?? null,
      ...(f.extra ?? {}),
    },
  };
}

export function reportAuthFailure(f: AuthFailure): void {
  try {
    const event = buildAuthFailureEvent(f);
    Sentry.withScope((scope) => {
      scope.setUser(null);
      scope.clearBreadcrumbs();
      scope.setFingerprint(event.fingerprint);
      scope.setTags(event.tags);
      scope.setExtras(event.extra);
      scope.setLevel(event.level);
      Sentry.captureMessage(event.message);
    });
  } catch {
    // Reporting must never break sign-in.
  }
}

/** The name of a thrown DOMException or Error, for the `error` field. */
export function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : 'unknown';
}

export function errorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(err);
}

/** GoTrue's machine-readable code ("otp_expired", "over_email_send_rate_limit"),
 *  else its HTTP status, for the `error` field of an email-code failure. */
export function authErrorCode(err: unknown): string {
  const e = err as { code?: unknown; status?: unknown } | null;
  if (typeof e?.code === 'string' && e.code) return e.code;
  if (typeof e?.status === 'number') return String(e.status);
  return 'unknown';
}

/** Whole seconds since `since`, or null when it was never set. */
export function secondsSince(since: number | null): number | null {
  return since === null ? null : Math.round((Date.now() - since) / 1000);
}
