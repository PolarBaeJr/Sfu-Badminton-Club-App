-- ============================================================
-- 00166 — reconcile Discord roles once a night
--
-- 00165 gave the bot a link table and the app a way to publish what a member
-- is; POST /sync is what pushes that into Discord. Until this migration
-- nothing called it, so roles only ever changed at the moment somebody ran
-- /link or /unlink. Everything the APP changes — a promotion, a ban, a
-- membership lapsing, an exec handing over a portfolio — reached Discord
-- never.
--
-- ---- WHY A NIGHTLY JOB AND NOT A FREQUENT ONE ----
--
-- The sweep is O(members x guilds) Discord calls and it holds one HTTP request
-- open for the duration, so it is the wrong shape to run every five minutes
-- like session-reminders does. It is also not the fast path: /link and /unlink
-- already apply roles immediately via /sync-member. This is the REPAIR pass —
-- it fixes a role somebody edited by hand in Discord, a member whose status
-- changed in the app, and anything that failed while the bot was down. Once a
-- night is the right cadence for that, and it is what the club asked for.
--
-- 10:50 UTC = 03:50 in Vancouver, genuinely overnight rather than late
-- evening. Fixed UTC is safe here in a way it usually is not: BC drops the
-- winter fallback from 2026-11-01, so America/Vancouver stays at UTC-7 all
-- year and this hour does not drift into the evening in November. Clear of
-- inactivity-notices (04:20), session-reminders (every 5 min) and the
-- weekly digest (Mondays 17:00-18:55).
--
-- ---- THE JOB IS INERT UNTIL IT IS CONFIGURED ----
--
-- No secret is written by this file. The job's WHERE EXISTS makes it a no-op
-- until BOTH config rows are present, following 00034's session-reminders
-- pattern, so applying this migration on a database that has no Discord bot
-- does nothing at all rather than posting to a URL that is not there.
--
-- The owner supplies them separately (see the bottom of this file).
--
-- ---- READING THE RESULT ----
--
-- pg_net FOLLOWS REDIRECTS, so a 200 in net._http_response proves only that
-- SOMETHING answered — it does not prove the sweep ran. POST /sync returns its
-- summary in the body for exactly this reason. Diagnose from `content`, never
-- from `status_code` alone.
--
-- SAFE TO APPLY AT ANY TIME. One new cron job that no-ops until configured.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cron_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE cron_config ENABLE ROW LEVEL SECURITY;  -- no policies = no access
REVOKE ALL ON cron_config FROM PUBLIC, anon, authenticated;

-- Unschedule first so re-running this file edits the job rather than failing
-- on a duplicate name.
SELECT cron.unschedule('discord-role-sync')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-role-sync');

SELECT cron.schedule(
  'discord-role-sync',
  '50 10 * * *',   -- daily, 10:50 UTC = 03:50 America/Vancouver
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'discord_bot_url') || '/sync',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (SELECT value FROM cron_config WHERE key = 'discord_service_secret')
               ),
    body    := '{}'::jsonb,
    -- The sweep is a long request by design: it walks every linked member in
    -- every guild, sequentially, because the role calls share one Discord
    -- rate-limit bucket. The default pg_net timeout would abandon it partway
    -- and report a failure for a sweep that was working fine.
    timeout_milliseconds := 120000
  )
  WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'discord_service_secret')
    AND EXISTS (SELECT 1 FROM cron_config WHERE key = 'discord_bot_url');
  $$
);

COMMIT;

-- ============================================================
-- OWNER STEP — not run by this migration, because it carries a secret.
--
-- Run these two INSERTs once the bot is deployed and the secret exists. The
-- job stays a no-op until both are present, and starts working on the next
-- 10:50 UTC without any further action.
--
--   INSERT INTO cron_config (key, value)
--   VALUES ('discord_bot_url', 'https://discord.sfubadminton.com')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
--   INSERT INTO cron_config (key, value)
--   VALUES ('discord_service_secret', '<the same value the bot and player get>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- To check it afterwards — read the BODY, not the status:
--
--   SELECT r.status_code, r.content, r.created
--     FROM net._http_response r
--    ORDER BY r.created DESC
--    LIMIT 5;
--
-- A healthy sweep answers {"ok":true,"members":N,...}. A 200 whose content is
-- an HTML page means something in front of the bot answered instead of the bot.
-- ============================================================
