/**
 * ONE remaining in-memory rate limiter. It has exactly one caller, and new
 * code should not reach for it.
 *
 * This module used to also export `getClientIp`. Every call site went with the
 * limiters, which left it with zero callers, so it was deleted rather than kept
 * "just in case". Nothing in this app needs to key on a client IP any more --
 * that job moved to the edge, which sees the real peer address directly instead
 * of having to reconstruct it from forwarded headers.
 *
 * WHY IT IS ALMOST GONE. The limiter is a module-scope Map, so it is per Node
 * PROCESS, so the real allowance is the written number times the number of
 * processes serving the route. That multiplier is not a constant and has
 * already moved once: it was 2 when this was measured (an 80-request burst
 * against a limit of 30 let 60 through, on two player replicas), and as of
 * 2026-08-26 production runs FIVE player replicas across two hosts. Nobody
 * edited a limit when that happened, because nothing connects the two. That is tolerable for
 * anti-spam and is not tolerable for an auth gate, so every IP-keyed call site
 * was deleted and replaced with a per-path limit at the edge, where the bucket
 * is shared across replicas via Redis. See docs/ops/rate-limits.md.
 *
 * WHY ONE CALLER SURVIVES. /api/discord/feedback keys on the reporting Discord
 * user, not on an IP. Every request to it arrives from the single bot process,
 * so an IP-keyed edge limit would put the entire club in one bucket and the
 * first member to file a few reports would silence everyone else. There is no
 * way to express "per Discord user" at the edge, and a per-process bucket is
 * strictly better than nothing for that one anti-spam job. The multiplier is
 * harmless there: the limit is volume control on a feature that writes a row,
 * not a gate on anything privileged. It is exactly why the same slop was not
 * acceptable on the auth routes.
 *
 * Do not "fix" the multiplier with a database-backed store. That was built, evaluated,
 * and rejected by the owner on 2026-08-24; the per-process behaviour is the
 * accepted trade for this one call site.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Fixed-window rate limiter.
 * @param key   unique identifier (e.g. `auth:<ip>`)
 * @param limit max requests allowed in the window
 * @param windowMs window length in milliseconds
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { success: true, remaining: limit - 1, resetAt };
  }

  if (existing.count >= limit) {
    return { success: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return { success: true, remaining: limit - existing.count, resetAt: existing.resetAt };
}


// Periodic cleanup to prevent unbounded growth (no-op in short-lived envs).
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
  }, 60_000).unref?.();
}
