-- ============================================================================
-- 00169 — Discord scheduled events for tournaments
--
-- When a tournament goes public (draft -> active), the club gets a Discord
-- scheduled event: the thing members can hit "Interested" on, that shows up in
-- the server's Events tab and sends them a reminder when it starts.
--
-- WHAT THIS TABLE IS: the mapping from a tournament to the Discord event it
-- produced, plus a copy of what was last pushed. Nothing else. The decision of
-- what is due lives in the app route, same split as the session pings.
--
-- WHY THE SYNCED_* COLUMNS EXIST, since they are the non-obvious part.
--
-- A rename on the website should move the Discord event too, and the only way
-- to know a rename happened is to remember what was sent. Without these the
-- cron would either never update (a tournament renamed the day before still
-- reads under its working title) or PATCH every event on every tick, which is
-- a rate-limit budget spent on writing the same values back.
--
-- WHY ONE EVENT PER TOURNAMENT, NOT PER tournament_events ROW. The events
-- table has no times of its own — Men's Singles and Mixed Doubles carry a
-- format and a cap and nothing about when they run — so N Discord events would
-- all land at the same instant and read as duplicates in the Events tab. The
-- individual events are enumerated in the description instead. If the club
-- later wants one Discord event per draw, that needs per-event times first.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.discord_tournament_events (
  tournament_id    uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  guild_id         text NOT NULL,
  discord_event_id text NOT NULL,

  -- What was last successfully pushed to Discord. Compared against the live
  -- tournament on every tick to decide whether a PATCH is owed.
  synced_name      text        NOT NULL,
  synced_starts_at timestamptz NOT NULL,
  synced_ends_at   timestamptz NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Per guild, because the bot is multi-guild: the same tournament announced in
  -- a test server and the real one is two Discord events, not a conflict.
  PRIMARY KEY (tournament_id, guild_id)
);

COMMENT ON TABLE public.discord_tournament_events IS
  'Tournament -> Discord scheduled event mapping, plus the last values pushed. Written by the bot after a confirmed Discord call, never before.';

-- Same posture as 00167. A Discord event id is not secret, but the bot reads
-- through the app's service-role client like everything else on this surface,
-- and a table anon can read is a table anon can be confused into reading.
ALTER TABLE public.discord_tournament_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_tournament_events FROM PUBLIC;
REVOKE ALL ON public.discord_tournament_events FROM anon, authenticated;
GRANT ALL  ON public.discord_tournament_events TO service_role;

-- ---- THE SYNC SCHEDULE -----------------------------------------------------
--
-- Every 15 minutes, not every 5. Nothing here is time-critical the way a
-- session ping is — a tournament announced a quarter of an hour later than the
-- click is indistinguishable to a member — and each tick reads every active
-- tournament rather than a narrow window.
--
-- DRIVEN BY CRON RATHER THAN BY THE ACTIVATE BUTTON, which is the design
-- decision worth stating. Creating the Discord event inline when an exec flips
-- the status would mean the announcement is lost for good if the bot happens to
-- be restarting at that moment, and the exec would have no way to tell: the
-- status change succeeded. Polling makes the bot being down a delay instead of
-- a loss.

SELECT cron.unschedule('discord-tournament-events')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-tournament-events');

SELECT cron.schedule(
  'discord-tournament-events',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'discord_bot_url') || '/tournament-events',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (SELECT value FROM cron_config WHERE key = 'discord_service_secret')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  )
  WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'discord_service_secret')
    AND EXISTS (SELECT 1 FROM cron_config WHERE key = 'discord_bot_url');
  $$
);

-- PostgREST caches the schema, and a failed read through it arrives as an EMPTY
-- LIST rather than an error — so without this the route would report "nothing
-- to announce" indefinitely while psql saw the table perfectly.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- OWNER STEPS — none of this is run by the migration.
--
-- ---- 1. GRANT THE BOT "MANAGE EVENTS" IN DISCORD ---------------------------
--
-- AND NOTHING IN THIS FEATURE WORKS UNTIL THIS IS DONE. The bot was invited
-- with Manage Roles only (docs/ops/discord-bot-bringup.md step 1.4), and
-- creating a scheduled event needs MANAGE_EVENTS (1 << 33). Without it every
-- create answers 403 and the Events tab simply stays empty.
--
-- The bot checks for the bit before it tries, and logs
-- "missing MANAGE_EVENTS" rather than a bare 403, so the symptom names its own
-- fix in the log. Two ways to grant it:
--
--   Server Settings -> Roles -> (the bot's role) -> enable "Manage Events"
--
-- or re-invite with the updated scope, which is what the bringup doc now says
-- for a fresh server.
--
-- ---- 2. THE THREE SETTINGS THE SCHEMA CANNOT SUPPLY ------------------------
--
-- `tournaments` stores start_date and end_date as DATE, with no time of day
-- and no location column — but a Discord EXTERNAL event requires a start
-- instant, an end instant AND a location, or the API refuses it. Rather than
-- invent a default in code that nobody can see or change, they are settings:
--
--   INSERT INTO discord_settings (key, value) VALUES
--     ('tournament_event_start_time', '09:00'),
--     ('tournament_event_end_time',   '18:00'),
--     ('tournament_event_location',   'SFU Burnaby')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- Times are CLUB WALL CLOCK (America/Vancouver), 24-hour HH:MM. The route
-- converts with wallClockToUtc rather than Intl, because BC stops changing its
-- clocks on 2026-11-01 and a Node without tzdata 2026b answers an hour out for
-- every date past it.
--
-- These are defaults in code too (09:00 / 18:00 / no location), so a run
-- without the rows is not a crash — but an event with no location reads as
-- unfinished, so set them.
--
-- ---- 3. RE-REGISTER THE SLASH COMMANDS -------------------------------------
--
-- `/tournaments` ships with this migration and DOES NOT EXIST in Discord until
-- the commands are pushed:
--
--   npm run register -w bot
--
-- Global registration takes up to an hour to propagate, so "unknown command"
-- straight after a deploy is the expected state, not a broken one. Register
-- guild-scoped if you want it in the test server immediately.
--
-- ---- 4. IF SOMEBODY DELETES AN EVENT IN DISCORD ----------------------------
--
-- The mapping row still says it exists, and the cron will never recreate it.
-- That is deliberate, and the same call as "removing a self-role does not strip
-- it from anyone": an exec deleting an event in Discord means "I do not want
-- this announced", and a bot that puts it straight back is a bot people turn
-- off. To undo:
--
--   DELETE FROM discord_tournament_events WHERE tournament_id = '<id>';
--
-- and the next tick creates it again.
-- ============================================================================
