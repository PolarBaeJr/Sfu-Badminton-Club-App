import * as Sentry from '@sentry/nextjs';
import { isAppError, isExpectedFailure } from '@badminton/shared';

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; ref?: string };

const NEXT_CONTROL_FLOW = /^NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR_FALLBACK)/;

export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const digest = (err as { digest?: string } | null)?.digest;
    if (typeof digest === 'string' && NEXT_CONTROL_FLOW.test(digest)) throw err;
    // Returned-as-value errors bypass Sentry's automatic server-action capture,
    // so report here to keep them logged.
    // Expected rejections (validation, permission guards) are the system
    // working — surface them to the caller without reporting a fault. Matches
    // on the allowlisted guard message too, not just on ExpectedError: a guard
    // that arrives as a plain Error is still the system working.
    if (!isExpectedFailure(err)) Sentry.captureException(err);
    // A coded error also hands back its code and ref, so the toast can show
    // what to report. Next never logs an error returned as a value, so a coded
    // fault is logged here, under the same CODE.ref the member sees.
    if (!isAppError(err)) {
      return { ok: false, error: err instanceof Error ? err.message : 'Something went wrong' };
    }
    if (!isExpectedFailure(err)) console.error('[action]', err.digest, err);
    return { ok: false, error: err.message, code: err.code, ref: err.ref };
  }
}
