-- ============================================================
-- 00060_inactivity_notice_cron.sql — schedule the "your
-- membership is now inactive" notice
-- ============================================================
-- Same mechanism as 00033 and 00038: Postgres cannot talk to the
-- mail provider, so pg_cron/pg_net POST the admin console and the
-- app does the work. Reuses their cron_config table, so the URL
-- and the shared secret are set once and every job reads them.
--
-- APPLY THIS AFTER 00059 AND AFTER THE APP IS DEPLOYED.
-- 00059 adds players.inactivity_notice_sent_at, which the route
-- reads and writes; and the route itself does not exist until the
-- console ships. Scheduled early, this POSTs into a 404 — which
-- pg_net records as a response and nobody watches (see the note
-- in 00052 about exactly that failure mode).
--
-- 04:20 UTC daily = 20:20/21:20 America/Vancouver. Deliberately
-- offset from the hour: the sweep is meant to run AFTER
-- mark-inactive-players has done the previous night's
-- deactivations, and a notice with a few hours' lag is
-- indistinguishable from an instant one to somebody who has not
-- opened the app in four months.
--
-- Daily rather than hourly because this is not time-sensitive and
-- because the job is a no-op on almost every run:
-- inactivity_notice_sent_at means an already-notified member is
-- never a candidate again, and the partial index in 00059 makes
-- "nobody to tell" a cheap answer.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Recreate cleanly so re-running the migration doesn't stack duplicate jobs.
SELECT cron.unschedule('inactivity-notices')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'inactivity-notices');

-- cron_config is created by 00033; guard so this migration stands alone if the
-- ordering ever changes.
CREATE TABLE IF NOT EXISTS cron_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE cron_config ENABLE ROW LEVEL SECURITY;  -- no policies = no access
REVOKE ALL ON cron_config FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'inactivity-notices',
  '20 4 * * *',   -- daily, 04:20 UTC
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/inactivity-notices',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (SELECT value FROM cron_config WHERE key = 'reminder_secret')
               ),
    body    := '{}'::jsonb
  )
  WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'reminder_secret');
  $$
);

-- Shares 'reminder_secret' with session-reminders and weekly-digest for the
-- same reason they share it with each other: all three routes check the same
-- CRON_SECRET from the admin env, so a second key would be another thing to
-- rotate for no gain. The WHERE EXISTS means that until the secret row is
-- present this job is a no-op rather than an unauthenticated POST.
--
-- NOTE FOR WHOEVER APPLIES THIS: mark-inactive-players — the job that puts
-- members INTO the state this notice is about — currently has no schedule on
-- prod at all. cron.job holds only session-reminders and weekly-digest. Until
-- that edge function is scheduled, nobody is ever marked inactive by the clock,
-- so this job will correctly find nothing to send, night after night. That is
-- not a bug in this migration; it is the upstream trigger being unwired.
