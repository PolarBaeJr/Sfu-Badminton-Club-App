-- ============================================================
-- 00033_auto_session_reminders.sql — remind RSVPs automatically
-- ============================================================
-- Reminders have been manual: an admin opens a session's menu and clicks "Send
-- reminder". This schedules it.
--
-- Postgres cannot send the reminder itself — web push is signed with the VAPID
-- private key, which only the admin app holds — so pg_cron/pg_net simply POST
-- the app's /api/cron/session-reminders route on a schedule and the app does
-- the work.
--
-- Runs HOURLY rather than at a fixed local time. pg_cron schedules in UTC, so a
-- fixed "08:00" would drift by an hour across daylight saving; hourly sidesteps
-- that entirely. The route resolves "today" in America/Vancouver, and
-- reminder_sent_at makes every run after the first a no-op — so the first run
-- on or after midnight local does the work and the other 23 cost a round-trip.
--
-- Requires cron.settings.reminder_secret and .admin_url to be set (see the
-- ALTER DATABASE at the bottom) — they are NOT hardcoded here so the secret
-- never lands in the repo.
-- ============================================================

-- Dedupe: without this a retry, or the next hourly run, re-notifies everyone.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN sessions.reminder_sent_at IS
  'Set when the automatic reminder went out; NULL means still due. Claimed with a conditional UPDATE so concurrent runs cannot both send.';

-- pg_cron is already in shared_preload_libraries and cron.database_name is
-- postgres, so this needs no server restart.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Recreate cleanly so re-running the migration doesn't stack duplicate jobs.
SELECT cron.unschedule('session-reminders')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'session-reminders');

SELECT cron.schedule(
  'session-reminders',
  '7 * * * *',   -- once an hour, off the hour to avoid the busy minute
  $$
  SELECT net.http_post(
    url     := current_setting('cron.settings.admin_url', true) || '/api/cron/session-reminders',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || current_setting('cron.settings.reminder_secret', true)
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- Set these once, out of band (they hold a secret, so they are not in the repo):
--
--   ALTER DATABASE postgres SET cron.settings.admin_url        = 'https://admin.sfubadminton.com';
--   ALTER DATABASE postgres SET cron.settings.reminder_secret  = '<same value as CRON_SECRET in the admin env>';
--
-- and the admin container needs CRON_SECRET set to that same value. Until both
-- exist the route answers 503 (not configured) or 401, and no reminder is sent
-- — it fails closed rather than sending unauthenticated.
