/**
 * Sanitized error helpers for server actions / route handlers.
 *
 * Supabase/Postgres errors frequently leak schema hints, constraint names,
 * and internal identifiers when `error.message` is thrown back to the client.
 * These helpers normalise that into a short generic message while keeping the
 * full raw error logged via the canonical structured logger.
 */
import { logError } from './log';

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
 * Convert an arbitrary error to a safe client-facing Error. Logs the raw
 * error via the structured logger so internals stay observable in platform
 * log aggregators.
 *
 * @param err   the caught / returned error
 * @param label short action identifier (e.g. 'player.update') used as the log label
 * @param fallback user-visible fallback message
 */
export function toClientError(
  err: RawError,
  label: string,
  fallback = 'Something went wrong. Please try again.'
): Error {
  const { code, message } = extract(err);

  logError(label, err instanceof Error ? err : new Error(message || 'unknown'), {
    pg_code: code || 'none',
  });

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
