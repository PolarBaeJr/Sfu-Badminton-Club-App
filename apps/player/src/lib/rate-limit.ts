import * as Sentry from '@sentry/nextjs';
import { rateLimitShared, type RateLimitResult } from '@badminton/shared';

/**
 * The player app's binding for the cross-replica rate limiter.
 *
 * Exists so the Sentry wiring lives in exactly one place: `packages/shared`
 * has no Sentry dependency, and `rateLimitShared` fails open, so without this
 * the fallback would be silent — the one failure mode that matters here, since
 * a silently-degraded limiter looks identical to a working one.
 *
 * Only the bucket prefix is reported, never the full key: keys embed the
 * client IP and there is no reason to widen where that gets written.
 */
export function sharedRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  return rateLimitShared(key, limit, windowMs, (err) =>
    Sentry.captureException(err, {
      extra: { step: 'shared-rate-limit', bucket: key.split(':')[0] },
    }),
  );
}
