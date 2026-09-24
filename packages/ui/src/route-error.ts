// Deep import, not the barrel: this module reaches client bundles, and the
// barrel pulls server-only modules (resend, node crypto) in with it.
import {
  ERROR_FALLBACK_MESSAGE,
  isGenericServerMessage,
} from '@badminton/shared/src/utils/error-codes';

export { isGenericServerMessage };

export const ROUTE_ERROR_FALLBACK = ERROR_FALLBACK_MESSAGE;

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
