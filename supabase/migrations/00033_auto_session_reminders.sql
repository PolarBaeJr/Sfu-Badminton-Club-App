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
-- The URL and shared secret live in a locked-down table rather than custom
-- GUCs: Supabase's `postgres` role is not a superuser, so
-- `ALTER DATABASE ... SET cron.settings.*` is refused. A table also means the
-- values can be changed with a plain UPDATE, and never appear in this repo.
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

-- Config for the job. Readable only by its owner (and service_role) — the
-- secret must never be reachable from `authenticated`.
CREATE TABLE IF NOT EXISTS cron_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE cron_config ENABLE ROW LEVEL SECURITY;  -- no policies = no access
REVOKE ALL ON cron_config FROM PUBLIC, anon, authenticated;

INSERT INTO cron_config (key, value)
VALUES ('admin_url', 'https://admin.sfubadminton.com')
ON CONFLICT (key) DO NOTHING;

SELECT cron.schedule(
  'session-reminders',
  '7 * * * *',   -- once an hour, off the hour to avoid the busy minute
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/session-reminders',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (SELECT value FROM cron_config WHERE key = 'reminder_secret')
               ),
    body    := '{}'::jsonb
  )
  WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'reminder_secret');
  $$
);

-- Set the secret once, out of band (same value as CRON_SECRET in the admin env):
--
--   INSERT INTO cron_config (key, value) VALUES ('reminder_secret', '<secret>')
--     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- Until it exists the scheduled statement's WHERE EXISTS makes the job a no-op,
-- so nothing is ever POSTed without a credential. If the two values disagree the
-- route answers 401. Either way it fails closed rather than firing
-- unauthenticated.
