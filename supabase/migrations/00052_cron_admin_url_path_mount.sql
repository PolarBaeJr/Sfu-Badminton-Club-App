-- ============================================================
-- 00052_cron_admin_url_path_mount.sql — point the scheduled jobs
-- at the console's new address
--
-- The admin console moved off admin.sfubadminton.com and onto
-- sfubadminton.com/admin (same origin as the player app, because
-- a PWA cannot keep a cross-origin navigation in its window).
-- Once nothing serves the subdomain, proxy-manager answers that
-- host with a 404.
--
-- Two pg_cron jobs build their target from cron_config.admin_url:
--   session-reminders (00033, retargeted by 00034)
--   weekly-digest     (00038)
-- Both were seeded with the subdomain, and both seeds are
-- ON CONFLICT DO NOTHING — so re-running those migrations will
-- NOT fix the row. It has to be updated explicitly, here.
--
-- Left stale, this fails quietly in the worst way: net.http_post
-- records a response, nobody is watching the status, and members
-- simply stop getting session reminders and the weekly digest.
-- Nothing errors. (pg_net also follows redirects, so even a 200
-- in net._http_response proves nothing on its own — check
-- .content.)
-- ============================================================

DO $$
DECLARE
  current_url TEXT;
  new_url     CONSTANT TEXT := 'https://sfubadminton.com/admin';
  old_url     CONSTANT TEXT := 'https://admin.sfubadminton.com';
BEGIN
  SELECT value INTO current_url FROM cron_config WHERE key = 'admin_url';

  IF current_url IS NULL THEN
    INSERT INTO cron_config (key, value) VALUES ('admin_url', new_url);
    RAISE NOTICE 'cron_config.admin_url was missing; seeded as %', new_url;

  ELSIF current_url = new_url THEN
    RAISE NOTICE 'cron_config.admin_url already %; nothing to do', new_url;

  ELSIF current_url = old_url THEN
    UPDATE cron_config SET value = new_url WHERE key = 'admin_url';
    RAISE NOTICE 'cron_config.admin_url moved from % to %', old_url, new_url;

  ELSE
    -- Deliberately not overwritten: an unrecognised value is more
    -- likely a considered override (a staging host, say) than the
    -- stale subdomain this migration exists to fix. Shout instead
    -- of silently redirecting someone's cron traffic.
    RAISE WARNING
      'cron_config.admin_url is % — left as-is. If that host no longer serves the console, the session-reminder and weekly-digest jobs are posting into the void; set it to % by hand.',
      current_url, new_url;
  END IF;
END $$;

-- The jobs themselves need no change: both interpolate
-- cron_config.admin_url at run time, so
--   'https://sfubadminton.com/admin' || '/api/cron/session-reminders'
-- lands on the basePath-mounted route. Verified against the built
-- app: that path answers 503 without the shared secret (the
-- handler's own check), rather than redirecting to /login — which
-- is the failure mode pg_net would have swallowed as a 200.
