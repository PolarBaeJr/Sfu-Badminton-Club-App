/**
 * Lightweight in-memory rate limiter.
 *
 * NOTE: This is per-instance only. On serverless (Vercel) it provides basic
 * abuse protection but is not a hard guarantee — for strict global limits
 * swap the backing store with Upstash Redis (`@upstash/ratelimit`).
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

/**
 * Best-effort client IP extraction from a Request.
 *
 * Never trust the LEFTMOST X-Forwarded-For entry: anything to the left of the
 * hop our own proxy appended is attacker-supplied, so a rotating
 * `X-Forwarded-For` header would mint a fresh rate-limit bucket per request and
 * defeat throttling entirely.
 *
 * Order of trust:
 *  1. `cf-connecting-ip` — set by Cloudflare, which overwrites any
 *     client-supplied copy, so it is authoritative when we sit behind it.
 *  2. the RIGHTMOST `x-forwarded-for` entry — appended by the closest proxy;
 *     a client can prepend entries but cannot append past our edge.
 *  3. `x-real-ip`, then 'unknown'.
 */
export function getClientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;

  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    const hops = fwd.split(',').map((h) => h.trim()).filter(Boolean);
    const rightmost = hops[hops.length - 1];
    if (rightmost) return rightmost;
  }
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
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
