-- ============================================================
-- 00149_weekly_digest_resumable.sql — let the digest finish
-- ============================================================
-- The route (apps/admin/src/app/api/cron/weekly-digest) now sends a BOUNDED
-- batch per invocation and records where it got to, in cron_config under
-- 'weekly_digest_progress'. That makes a retry safe, which it was not before:
-- the job used to mail every eligible member inside one request, pg_net gave up
-- on it at its 5s default, and re-POSTing a job that looked failed mailed
-- everyone a second time.
--
-- Bounded batches need something to drive them, though. 00038 fired this job
-- exactly once a week, so on its own the new route would mail the first 40
-- members and stop until the following Monday.
--
-- So: fire it every five minutes across a two-hour Monday window instead. The
-- route returns `already_complete` and does nothing once the week is finished,
-- so all but the first few calls are a no-op costing one round trip. 24 slots x
-- 40 sends is capacity for 960 members; the club is nowhere near that, and the
-- window can simply be widened when it is.
--
-- NOTHING HERE NEEDS THE APP DEPLOYED FIRST. Against the OLD route these calls
-- are simply the old behaviour repeated, which is what already happens today
-- whenever somebody retries it. Against the new route they are the intended
-- design. Either ordering is safe.
-- ============================================================

SELECT cron.unschedule('weekly-digest')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-digest');

SELECT cron.schedule(
  'weekly-digest',
  '*/5 17-18 * * 1',   -- Mondays, every 5 min from 17:00 to 18:55 UTC
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/weekly-digest',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (SELECT value FROM cron_config WHERE key = 'reminder_secret')
               ),
    body    := '{}'::jsonb,
    -- 40 sequential provider round trips do not fit in pg_net's 5s default.
    -- Without this every invocation is recorded as a timeout even when it
    -- succeeded, which is what made the old failure so hard to read: the
    -- handler kept running after pg_net gave up, so net._http_response said
    -- "failed" for a run that had in fact mailed everybody.
    timeout_milliseconds := 120000
  )
  WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'reminder_secret');
  $$
);

-- Still fails closed exactly as 00033 and 00038 do: until the secret row is
-- present this is a no-op rather than an unauthenticated POST.
--
-- The cursor row is created by the app on its first run. It is NOT seeded here,
-- because a seeded row claiming a window the app never processed would make the
-- first real run skip that week entirely.
