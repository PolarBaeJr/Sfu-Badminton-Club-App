// An Error that carries a registry code and a per-occurrence ref, and sets
// `digest` to `CODE.ref` itself. Next keeps a digest that is already set, so the
// same string reaches the server log and the error screen in the browser, where
// the message is withheld in production.
//
// Imports only ./error-codes and ./error-classify, never the barrel and never
// node:crypto: the Sentry init files deep-import tagErrorCode from here.
import { ERROR_CODES, ERROR_CODE_PATTERN, formatDigest, makeErrorRef, type ErrorCode } from './error-codes';
import { classifyError } from './error-classify';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly ref: string;
  readonly digest: string;
  readonly expected: boolean;

  constructor(
    code: ErrorCode,
    message: string = ERROR_CODES[code].title,
    options: { cause?: unknown; expected?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.ref = makeErrorRef();
    this.digest = formatDigest(code, this.ref);
    this.expected = options.expected === true;
  }
}

/**
 * Structural, for the same reason isExpectedError is: the Sentry init files and
 * app code can reach this module through different entry points. Also true for
 * a coded ExpectedError, which carries the same three fields.
 */
export function isAppError(
  err: unknown,
): err is { code: ErrorCode; ref: string; digest: string; message: string } {
  if (typeof err !== 'object' || err === null) return false;
  const { code, ref, digest } = err as { code?: unknown; ref?: unknown; digest?: unknown };
  return (
    typeof code === 'string' &&
    ERROR_CODE_PATTERN.test(code) &&
    typeof ref === 'string' &&
    typeof digest === 'string' &&
    digest === `${code}.${ref}`
  );
}

/**
 * Wrap a caught error for rethrow. The code is the most specific one the
 * classifier finds, else `fallback`; the message stays the original one unless
 * `message` is given, so nothing that matches on error text changes.
 */
export function raise(fallback: ErrorCode, err: unknown, message?: string): AppError {
  if (err instanceof AppError && message === undefined) return err;
  const own = (err as { message?: unknown } | null)?.message;
  const code = classifyError(err, fallback);
  return new AppError(code, message ?? (typeof own === 'string' ? own : ERROR_CODES[code].title), {
    cause: err,
  });
}

/**
 * Sentry `beforeSend` step: tag an event with the code and ref of the error it
 * came from, so a screenshot's code finds the event. Tags only registry values,
 * never the raw message. Returns the event unchanged for an uncoded error.
 */
export function tagErrorCode<E extends { tags?: { [key: string]: unknown } }>(
  event: E,
  hint?: { originalException?: unknown },
): E {
  const err = hint?.originalException;
  if (!isAppError(err)) return event;
  return { ...event, tags: { ...event.tags, error_code: err.code, error_ref: err.ref } };
}
