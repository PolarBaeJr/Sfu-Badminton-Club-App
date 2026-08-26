/**
 * ONE remaining in-memory rate limiter. It has exactly one caller, and new
 * code should not reach for it.
 *
 * This module used to also export `getClientIp`. It was deleted along with the
 * call sites, and deliberately not kept "just in case": it read the RIGHTMOST
 * X-Forwarded-For hop, which behind Cloudflare plus the host nginx is the CF
 * edge address, not the member's -- so anything keyed on it would have bucketed
 * an entire region together. Nothing in this app should key on a client IP any
 * more; that job belongs to the edge, which sees the real peer.
 *
 * WHY IT IS ALMOST GONE. The limiter is a module-scope Map, so it is per Node
 * PROCESS. Production runs two player replicas, which means every number ever
 * written against it was enforced at roughly 2x — measured, not assumed: an
 * 80-request burst against a limit of 30 let 60 through. That is tolerable for
 * anti-spam and is not tolerable for an auth gate, so every IP-keyed call site
 * was deleted and replaced with a per-path limit at the edge, where the bucket
 * is shared across replicas via Redis. See docs/ops/rate-limits.md.
 *
 * WHY ONE CALLER SURVIVES. /api/discord/feedback keys on the reporting Discord
 * user, not on an IP. Every request to it arrives from the single bot process,
 * so an IP-keyed edge limit would put the entire club in one bucket and the
 * first member to file a few reports would silence everyone else. There is no
 * way to express "per Discord user" at the edge, and a per-process bucket is
 * strictly better than nothing for that one anti-spam job. The 2x is harmless
 * there: the limit is volume control on a feature that writes a row, not a
 * gate on anything privileged.
 *
 * Do not "fix" the 2x with a database-backed store. That was built, evaluated,
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
