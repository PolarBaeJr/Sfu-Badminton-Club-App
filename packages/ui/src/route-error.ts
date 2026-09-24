export const ROUTE_ERROR_FALLBACK =
  'Something went wrong loading this page. Try again, and if it keeps happening, send the error code below to an exec.';

const GENERIC_SERVER_PREFIX = 'An error occurred in the Server Components render';

/** Next replaces a server error's message with this text in production builds. */
export function isGenericServerMessage(message: string | undefined | null): boolean {
  return typeof message === 'string' && message.startsWith(GENERIC_SERVER_PREFIX);
}

/**
 * A digest means the error came from the server, where the real message is
 * withheld and lives in the log under that digest, so the fallback reads
 * better than whatever Next put in its place. Client errors keep their message.
 */
export function routeErrorMessage(
  error: { message?: string; digest?: string } | undefined | null,
  fallback: string = ROUTE_ERROR_FALLBACK,
): string {
  if (!error) return fallback;
  if (error.digest || isGenericServerMessage(error.message)) return fallback;
  return error.message || fallback;
}
