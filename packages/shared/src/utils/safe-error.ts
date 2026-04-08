/**
 * Sanitized error helpers for server actions / route handlers.
 *
 * Supabase/Postgres errors frequently leak schema hints, constraint names,
 * and internal identifiers when `error.message` is thrown back to the client.
 * These helpers normalise that into a short generic message while keeping the
 * full raw error in Sentry for debugging.
 */

type RawError = { message?: string; code?: string; details?: string; hint?: string } | Error | unknown;

const PG_CODE_MESSAGES: Record<string, string> = {
  '23505': 'This record already exists.',
  '23503': 'Referenced record is missing.',
  '23514': 'Invalid value for this field.',
  '42501': 'You are not allowed to perform this action.',
  'PGRST116': 'Record not found.',
  'PGRST301': 'You are not allowed to perform this action.',
};

function extract(e: RawError): { code?: string; message?: string } {
  if (!e || typeof e !== 'object') return {};
  const rec = e as Record<string, unknown>;
  return {
    code: typeof rec.code === 'string' ? rec.code : undefined,
    message: typeof rec.message === 'string' ? rec.message : undefined,
  };
}

/**
 * Convert an arbitrary error to a safe client-facing Error.
 * Logs the raw error to Sentry when available so internals stay observable.
 *
 * @param err   the caught / returned error
 * @param label short action identifier (e.g. 'player.update') for Sentry tags
 * @param fallback user-visible fallback message
 */
export function toClientError(
  err: RawError,
  label: string,
  fallback = 'Something went wrong. Please try again.'
): Error {
  const { code, message } = extract(err);

  // Sentry: best-effort, don't fail if @sentry/nextjs isn't loaded.
  try {
    // Dynamic require so this file stays framework-agnostic.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require('@sentry/nextjs');
    if (Sentry?.captureException) {
      Sentry.captureException(err instanceof Error ? err : new Error(message || 'unknown'), {
        tags: { action: label, pg_code: code || 'none' },
      });
    }
  } catch {
    // ignore — Sentry not configured
  }

  if (code && PG_CODE_MESSAGES[code]) {
    return new Error(PG_CODE_MESSAGES[code]);
  }

  return new Error(fallback);
}

/**
 * Throw a sanitized error. Convenience wrapper for:
 *   if (error) throw toClientError(error, 'label');
 */
export function throwClientError(err: RawError, label: string, fallback?: string): never {
  throw toClientError(err, label, fallback);
}
