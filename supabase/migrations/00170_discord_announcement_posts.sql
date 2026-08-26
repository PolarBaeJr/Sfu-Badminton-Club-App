-- ============================================================================
-- 00170 — Relaying club announcements into Discord
--
-- An announcement published on the website is posted to a Discord channel, and
-- kept in step with it afterwards: an edit edits the message, a retraction
-- deletes it. This table is the mapping, plus a copy of what was last pushed.
--
-- ONLY target_audience = 'all' IS EVER RELAYED, and that is the whole security
-- design of this feature rather than a limitation to work around later.
--
-- apps/player/src/lib/announcement-visibility.ts settles who may see an
-- announcement, and its audience rule is a PER-VIEWER predicate:
-- 'competitive' matches the member's own players.status, and 'eligible_only'
-- reads their eligibility_flag. A Discord channel is not a viewer. Pointing
-- competitive announcements at a #competitive channel would not apply that
-- rule — it would ASSERT that everyone who can read the channel has
-- status = 'competitive', with nothing in the system checking the assertion.
-- The two sets are known to drift: that is why the role reconcile sweep
-- exists, and a member can hold @Competitive Team in Discord while the app
-- says otherwise. eligibility_flag has no Discord analogue at all.
--
-- So a narrowly-addressed announcement is skipped with a reason, and stays on
-- the website where the rule is actually enforced. If the club later wants
-- competitive notices in Discord, the mechanism that would be correct is a
-- role-mentioned post derived from the link table — a different feature that
-- needs the club to say what it wants first.
--
-- WHY THE SYNCED_* COLUMNS: the same argument as 00169. Knowing an edit
-- happened means remembering what was sent. Without them the cron would either
-- never edit, or rewrite every message on every tick.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.discord_announcement_posts (
  -- WHY THERE IS NO FOREIGN KEY ON announcement_id.
  --
  -- The obvious `REFERENCES public.announcements(id) ON DELETE CASCADE` is
  -- WRONG here, and quietly so. deleteAnnouncement
  -- (apps/admin/src/lib/actions/announcements.ts)
  -- hard-deletes the row, so the cascade would take this mapping with it — and
  -- the mapping is the ONLY thing that knows which message in Discord
  -- belongs to it. The message would stay up permanently, with nothing
  -- left to find it by.
  --
  -- That inverts the intent exactly. Unpublishing, expiry and narrowing the
  -- audience all take the Discord copy down; an outright delete is the most emphatic retraction the
  -- console offers, and it is the one case that would leave the copy standing.
  --
  -- So this row OUTLIVES its announcements row on purpose. The reader
  -- (apps/player/src/app/api/discord/announcements/route.ts)
  -- treats a mapping whose announcement_id no longer resolves as a retract,
  -- deletes it in Discord, and clears the row afterwards — the same path as
  -- every other retraction.
  announcement_id    uuid NOT NULL,
  guild_id           text NOT NULL,
  channel_id         text NOT NULL,
  discord_message_id text NOT NULL,

  -- What was last successfully posted. Compared against the live row each tick.
  -- The type is in here because it picks the embed's colour: an exec promoting
  -- a notice from info to urgent has changed what members see, and a mapping
  -- that only remembered the words would leave the Discord copy the wrong
  -- colour with nothing to detect it.
  synced_title       text NOT NULL,
  synced_body        text NOT NULL,
  synced_type        text NOT NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Per guild: the same announcement relayed to a test server and the real one
  -- is two messages, not a conflict.
  PRIMARY KEY (announcement_id, guild_id)
);

ALTER TABLE public.discord_announcement_posts ENABLE ROW LEVEL SECURITY;

-- No policies on purpose. Nothing but the service role has any business here,
-- and an absent policy under RLS denies everyone else by default.
REVOKE ALL ON public.discord_announcement_posts FROM PUBLIC;
REVOKE ALL ON public.discord_announcement_posts FROM anon, authenticated;
GRANT ALL  ON public.discord_announcement_posts TO service_role;

-- ---- THE SYNC SCHEDULE -----------------------------------------------------
--
-- Every 5 minutes. Faster than the tournament sweep because an announcement is
-- the thing an exec publishes and then watches for — "urgent: no session
-- tonight" reaching Discord a quarter of an hour later is a different message
-- from the one that was written.
--
-- CRON RATHER THAN THE PUBLISH BUTTON, same argument as 00169: posting inline
-- would lose the relay entirely if the bot happened to be restarting, and the
-- exec would see nothing wrong because the publish itself succeeded.

SELECT cron.unschedule('discord-announcements')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-announcements');

SELECT cron.schedule(
  'discord-announcements',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'discord_bot_url') || '/announcements',
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
-- to relay" indefinitely while psql saw the table perfectly.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- OWNER STEPS — none of this is run by the migration.
--
-- ---- 1. NAME THE CHANNEL ---------------------------------------------------
--
-- NOTHING IS RELAYED UNTIL THIS IS SET, deliberately: a relay that guessed a
-- channel would be a relay posting club business somewhere nobody chose.
--
--   INSERT INTO discord_settings (key, value)
--   VALUES ('announcement_channel_id', '<channel id>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- Right-click the channel in Discord -> Copy Channel ID (Developer Mode on).
-- The bot needs View Channel and Send Messages there; it edits and deletes
-- only its OWN messages, which needs no further permission.
--
-- ---- 2. NO PERMISSION TO GRANT, AND NOBODY IS MENTIONED --------------------
--
-- Unlike 00169 there is no MANAGE_EVENTS equivalent here. There is also no
-- @here, no @everyone and no role ping in a relayed announcement, on purpose:
-- a channel post is opt-in by whoever follows the channel, and a feature that
-- could mass-ping the server on every publish is one bad afternoon away from
-- people muting the channel that carries the club's notices.
--
-- send_push is NOT reused as a quiet flag. It governs web push, the admin
-- console presents it as such, and borrowing it here would give the checkbox a
-- second meaning nothing in the UI mentions.
--
-- ---- 3. THE 72-HOUR LOOKBACK, AND WHY A FRESH RELAY IS NOT A FLOOD ---------
--
-- The route relays nothing published more than 72 hours ago. Two reasons, both
-- of them about the FIRST run rather than the steady state:
--
--   - Switching this on with no lookback would post every announcement in the
--     club's history into the channel at once.
--   - This table is an IDEMPOTENCY RECORD, and the nightly prod -> staging
--     snapshot copies it (see docs/ops/discord-bot-bringup.md). After a
--     refresh, staging holds prod's rows and believes prod's posts were its
--     own. The lookback is what stops the inverse too: a staging database
--     wiped and re-seeded does not replay a week of prod announcements into
--     the test server.
--
-- 72 hours rather than 24 so a bot down over a weekend delays the relay
-- instead of dropping it.
--
-- ---- 4. IF SOMEBODY DELETES A RELAYED MESSAGE IN DISCORD -------------------
--
-- It is not re-posted. Same call as a hand-deleted scheduled event and a
-- removed self-role: a human undoing the bot's work in Discord is a decision,
-- not drift. To make the relay post it again, forget the mapping:
--
--   DELETE FROM discord_announcement_posts WHERE announcement_id = '<id>';
--
-- An EDIT aimed at that deleted message answers 404, and the bot records the
-- edit anyway rather than retrying it — otherwise a corrected announcement
-- would PATCH a dead id every five minutes for as long as it existed. It shows
-- up in the run result as `stale` and in the log as one warning.
--
-- ---- 4b. THE ROWS THAT NEVER CLEAR -----------------------------------------
--
-- A row is removed when its message is taken down: unpublished, expired,
-- narrowed to one division, or the announcement deleted outright. An
-- announcement that stays published, addressed to everyone and unexpired keeps
-- its row indefinitely — which is correct, since its message is still up.
--
-- The route reads at most 500 of them per tick (MAX_MAPPED), because the
-- follow-up read resolves those ids through PostgREST and production caps a
-- read at PGRST_DB_MAX_ROWS = 1000. Staying under the ceiling is what stops a
-- truncated read looking like "every announcement was deleted" to the sweep
-- that retracts orphans. At roughly a hundred announcements a year the cap is
-- years away; if it is ever reached the route logs it and reports
-- `mapping_cap_reached`, and the fix is to expire or delete old announcements
-- rather than to raise the number.
--
-- ---- 5. REGISTERING COMMANDS -----------------------------------------------
--
-- This feature adds no slash command, so nothing to register.
-- ============================================================================
