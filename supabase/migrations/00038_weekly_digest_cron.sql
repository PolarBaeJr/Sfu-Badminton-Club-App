-- ============================================================
-- 00038_weekly_digest_cron.sql — schedule the weekly recap email
-- ============================================================
-- weeklyDigestEmail has existed since the email module was written and has
-- never had a caller: the template was built, wired to a sender, and then
-- nothing ever invoked it. This schedules it.
--
-- Same mechanism as 00033: Postgres cannot talk to the mail provider, so
-- pg_cron/pg_net POST the admin app and the app does the work. Reuses that
-- migration's cron_config table, so the URL and the shared secret are set once
-- and both jobs read them.
--
-- Monday 09:00 America/Vancouver. pg_cron schedules in UTC and does not track
-- daylight saving, so this is pinned to 17:00 UTC — which is 09:00 PDT in
-- summer and 09:00 PST would be 17:00 too only in winter; in practice the recap
-- lands at 09:00 or 10:00 local depending on the season. A weekly summary does
-- not care about an hour, and the alternative (an hourly job checking the local
-- clock, as session-reminders does) is not worth the 167 wasted round-trips for
-- something with no deadline.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Recreate cleanly so re-running the migration doesn't stack duplicate jobs.
SELECT cron.unschedule('weekly-digest')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-digest');

-- cron_config is created by 00033; guard so this migration stands alone if the
-- ordering ever changes.
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
  'weekly-digest',
  '0 17 * * 1',   -- Mondays, 17:00 UTC
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/weekly-digest',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (SELECT value FROM cron_config WHERE key = 'reminder_secret')
               ),
    body    := '{}'::jsonb
  )
  WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'reminder_secret');
  $$
);

-- Shares 'reminder_secret' with the session-reminders job on purpose: both
-- routes check the same CRON_SECRET from the admin env, so a second key would
-- be a second thing to rotate for no gain. The WHERE EXISTS means that until
-- the secret row is present this job is a no-op rather than an unauthenticated
-- POST — it fails closed exactly as 00033 does.
--
-- Nothing is sent to a member who muted the category or is on
-- email_suppressions: the route goes through sendCategoryEmail, which checks
-- both before calling the provider. This is the only scheduled mail the app
-- sends, so it is the one that most needs that gate.
