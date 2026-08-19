/**
 * Cross-replica rate limiter, backed by Postgres.
 *
 * The sibling `rateLimit()` keeps buckets in a module-level Map, which is
 * correct only while a service runs as ONE process. Prod moved the player to
 * two replicas on 2026-08-19, and proxy-manager round-robins between them, so
 * every in-process limit silently became 2x per client IP. This module is the
 * shared-store version for the handful of routes where that doubling actually
 * weakens something — the login brute-force gates.
 *
 * Use `rateLimit()` for nuisance limits that are already generous (check-in
 * scans, calendar feeds, unsubscribe) — a DB round-trip is not worth it there,
 * and those limits are token-scoped rather than credential-guarding.
 *
 * See supabase/migrations/00158_a_rate_limit_is_not_per_process.sql.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { rateLimit, type RateLimitResult } from './rate-limit';

let admin: SupabaseClient | null = null;

/**
 * Its own service-role client, mirroring the email sender's reasoning: the
 * callers are route handlers that gate BEFORE authenticating anyone, so there
 * is no per-request client in hand to borrow at that point.
 */
function getAdmin(): SupabaseClient | null {
  if (admin) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  admin = createClient(url, key, { auth: { persistSession: false } });
  return admin;
}

/**
 * Fixed-window rate limiter shared across every replica of a service.
 *
 * Fails OPEN — on any DB error this degrades to the per-process limiter rather
 * than rejecting. That is deliberate: these gates sit on /auth/callback and the
 * passkey routes, so failing closed during a database hiccup would lock members
 * out of signing in, which is strictly worse than the 2x-limit bug this fixes.
 * The fallback is still a real limit, just a per-replica one — i.e. exactly the
 * behaviour that shipped before this module existed.
 *
 * @param key      unique bucket identifier (e.g. `auth-cb:<ip>`)
 * @param limit    max requests allowed in the window
 * @param windowMs window length in milliseconds
 * @param onError  optional reporter for the fail-open path; `packages/shared`
 *                 has no Sentry dependency, so the app injects one.
 */
export async function rateLimitShared(
  key: string,
  limit: number,
  windowMs: number,
  onError?: (err: unknown) => void,
): Promise<RateLimitResult> {
  const client = getAdmin();
  if (!client) return rateLimit(key, limit, windowMs);

  try {
    const { data, error } = await client.rpc('consume_rate_limit', {
      p_key: key,
      p_window_ms: windowMs,
    });
    if (error) throw new Error(`consume_rate_limit: ${error.message}`);

    // RETURNS TABLE arrives as a single-element array through PostgREST.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { hits: number | string; resets_at: string }
      | undefined;
    if (!row) throw new Error('consume_rate_limit returned no row');

    const hits = Number(row.hits);
    const resetAt = new Date(row.resets_at).getTime();
    if (!Number.isFinite(hits) || !Number.isFinite(resetAt)) {
      throw new Error('consume_rate_limit returned an unparseable row');
    }

    // `hits` counts the request we just made, so the limit is inclusive.
    return { success: hits <= limit, remaining: Math.max(0, limit - hits), resetAt };
  } catch (err) {
    onError?.(err);
    return rateLimit(key, limit, windowMs);
  }
}
