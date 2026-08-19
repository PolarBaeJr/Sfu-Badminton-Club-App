-- 00158 — a rate limit is not a per-process fact
--
-- SAFE TO APPLY IN EITHER ORDER, BEFORE OR AFTER THE APP DEPLOY.
-- The calling code fails OPEN: if this function is missing, rateLimitShared()
-- catches the PostgREST error and falls back to the existing in-process
-- limiter, which is exactly today's behaviour. So applying this early does
-- nothing until the deploy lands, and deploying early degrades to the status
-- quo instead of locking anyone out of login. That was a deliberate choice —
-- fail-closed on /auth/callback during a DB hiccup would be worse than the
-- bug being fixed here.
--
-- WHAT WAS WRONG
--
-- packages/shared/src/utils/rate-limit.ts keeps its buckets in a module-level
-- Map and says so in its own header ("per-instance only"). That was true and
-- harmless while the player ran as a single container.
--
-- On 2026-08-19 prod moved to TWO player replicas (measured +33% throughput;
-- see docs/sensitive/SCALE-TEST-2026-08-19.md). Two processes means two
-- independent Maps, and proxy-manager round-robins between them — so every
-- configured limit silently became 2x per client IP:
--
--     /auth/callback              10/min  ->  20/min
--     /api/passkey/register/*     10/min  ->  20/min
--     /api/passkey/login/verify   20/min  ->  40/min
--     /api/passkey/login/options  60/min  -> 120/min
--
-- These are the brute-force gates on the login path, so doubling them is a
-- real weakening rather than a cosmetic drift. Scaling to N replicas would
-- multiply them by N.
--
-- Deliberately NOT converted: unsubscribe (30) and /api/calendar/[token] (30)
-- are token-scoped nuisance limits where 30 vs 60 changes nothing, and
-- /checkin/[token] (20) is intentionally generous because a gym full of
-- players shares one NAT bucket. The admin app is untouched — it still runs
-- proxy.unscalable=true at one replica, so its in-process Map is already
-- globally correct.
--
-- WHY A TABLE AND NOT REDIS
--
-- There is no Redis on this box and these are low-volume auth endpoints, so a
-- Postgres round-trip is affordable where it would not be on a hot path.
--
-- THE ATOMICITY IS THE WHOLE POINT
--
-- consume_rate_limit is ONE statement. A read-then-write implementation would
-- race between the two replicas and would still pass any single-threaded test,
-- so the INSERT ... ON CONFLICT DO UPDATE below is load-bearing, not a style
-- choice. The returned count INCLUDES the current request, hence `hits <= limit`
-- at the caller rather than `<`.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rate_limits (
  key      text        PRIMARY KEY,
  count    integer     NOT NULL,
  reset_at timestamptz NOT NULL
);

-- Only the sweep below reads by this column; the hot path is always by PK.
CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx ON public.rate_limits (reset_at);

-- RLS on with NO policies: service_role bypasses RLS, and nothing else has any
-- business here. A member who could write this table could clear their own
-- bucket; one who could read it learns which IPs are hitting the login page.
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rate_limits FROM anon, authenticated;

-- Consume one token from `p_key`'s fixed window, creating or rolling the
-- window as needed. Returns the post-increment hit count so the caller can
-- compare it against its own limit -- the limit deliberately does not live in
-- the database, so changing a route's ceiling stays a code-only change.
CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_key       text,
  p_window_ms integer
)
RETURNS TABLE (hits integer, resets_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  INSERT INTO public.rate_limits AS rl (key, count, reset_at)
  VALUES (p_key, 1, now() + make_interval(secs => (p_window_ms / 1000.0)::double precision))
  ON CONFLICT (key) DO UPDATE
    SET count = CASE WHEN rl.reset_at <= now() THEN 1 ELSE rl.count + 1 END,
        reset_at = CASE
                     WHEN rl.reset_at <= now()
                       THEN now() + make_interval(secs => (p_window_ms / 1000.0)::double precision)
                     ELSE rl.reset_at
                   END
  RETURNING rl.count, rl.reset_at;
$fn$;

-- Callable ONLY by service_role. If anon or authenticated could call this they
-- could burn any other client's bucket by passing that client's key.
REVOKE ALL ON FUNCTION public.consume_rate_limit(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text, integer) TO service_role;

-- The in-process limiter this replaces swept its Map every 60s. Parity means
-- this table needs a reaper too, or it grows one row per (bucket, IP) forever.
-- Expired rows are already logically dead -- the function rolls the window on
-- read -- so the hour of slack is pure paranoia.
SELECT cron.unschedule('rate-limits-sweep')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rate-limits-sweep');

SELECT cron.schedule(
  'rate-limits-sweep',
  '*/15 * * * *',
  $$DELETE FROM public.rate_limits WHERE reset_at < now() - interval '1 hour'$$
);
