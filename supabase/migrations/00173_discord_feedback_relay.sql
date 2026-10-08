-- 00173: give a report a title and a screenshot, and relay both kinds of
-- feedback into a Discord channel the execs read.
--
-- Three things, and they are one feature:
--
--   1. feedback_reports gains `title` and `image_url`. /bug and /feedback stop
--      being a single free-text option and become a MODAL with two boxes, plus
--      an optional screenshot picked in the command itself.
--   2. discord_feedback_posts, the mapping table, so a relayed report is posted
--      once and an edited survey response edits its own message.
--   3. a pg_cron job driving the relay, off by default like the other three.
--
-- ============================================================================
-- WHY THE SCREENSHOT URL IS STORED EVEN THOUGH IT EXPIRES
-- ============================================================================
--
-- image_url is a Discord CDN url, and since 2023 those are SIGNED: they carry
-- ?ex=&is=&hm= and stop resolving roughly a day after the attachment was
-- uploaded. So the column is NOT an archive, and reading it a week later is
-- expected to 404.
--
-- It is stored anyway because it is the handle the relay needs. The relay runs
-- within minutes, fetches the bytes while the signature is still good, and
-- re-uploads them as a real attachment on the message it posts in the exec
-- channel. THAT copy is permanent — a Discord message attachment lives as long
-- as the message. After the relay has run, the durable copy of the screenshot
-- is the Discord post, not this column, and discord_feedback_posts is what
-- points at it.
--
-- The consequence to know: if the relay never runs (channel unset, bot down for
-- longer than a day), the screenshot is gone and only the words survive. The
-- report itself is never at risk — it is a row the moment it is filed, and the
-- image is best-effort on top.
--
-- ============================================================================
-- THE PRIVACY LINE, AND WHY THERE ARE TWO CHANNEL SETTINGS
-- ============================================================================
--
-- Two sources feed this relay and they carry DIFFERENT PROMISES.
--
--   feedback_reports   filed from Discord with /bug and /feedback. The bot's
--                      reply says "the execs read these". Nothing has promised
--                      the reporter anything about who else does.
--
--   event_feedback     the star rating and comment on a tournament page. That
--                      form tells the member, in so many words, that only the
--                      exec team sees it. It is a survey response, it is named,
--                      and members write things there they would not post.
--
-- Relaying the second one into a channel the whole server can read would break
-- a promise the app makes on screen. The defence is that the two have SEPARATE
-- settings keys — feedback_channel_id and event_feedback_channel_id — and
-- neither is inferred from the other. Setting the second one is a deliberate
-- act by somebody who has been asked to think about whether that channel is
-- exec-only. Pointing both at the same private channel is the expected
-- configuration; what is prevented is INHERITING survey relay from a decision
-- made about bug reports.
--
-- The player app's form copy was changed in this same commit to say the
-- comment is shared with the exec team in Discord, so the promise on screen and
-- the behaviour here agree.
--
-- ============================================================================

-- ---- 1. TITLE AND SCREENSHOT ------------------------------------------------

-- NULLABLE, and it has to be: 00172's rows predate the modal, and a report
-- filed by anything other than the modal (the app-side `source = 'app'` path
-- that does not exist yet) has no natural title. Rendering falls back to the
-- kind when it is absent.
ALTER TABLE public.feedback_reports
  ADD COLUMN IF NOT EXISTS title text;

-- 120 rather than Discord's own 45-character modal label limit, because the
-- cap here has to survive a writer that is not the modal. Same three-layer
-- reasoning as `body`: the client refuses first, the route trims second, this
-- holds regardless.
--
-- Dropped and re-added rather than guarded, because Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS and a DO block would be the only other way to
-- make this re-runnable. The drop is safe on a re-run: the constraint it names
-- can only have been created by this line.
ALTER TABLE public.feedback_reports
  DROP CONSTRAINT IF EXISTS feedback_reports_title_length;

ALTER TABLE public.feedback_reports
  ADD CONSTRAINT feedback_reports_title_length
  CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120);

-- See the header: expiring by design, and only useful to the relay.
ALTER TABLE public.feedback_reports
  ADD COLUMN IF NOT EXISTS image_url text;

COMMENT ON COLUMN public.feedback_reports.image_url IS
  'Discord CDN url of a screenshot filed with the report. SIGNED AND EXPIRING '
  '(~24h). The relay re-uploads the bytes into the exec channel while it is '
  'still valid; after that the durable copy is the Discord message, not this.';

-- ---- 2. THE MAPPING ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.discord_feedback_posts (
  -- WHICH TABLE source_id points into. Two sources share one mapping table
  -- because they share one channel, one cron job and one renderer; splitting
  -- them would be two of everything to distinguish rows that never interact.
  --
  -- No foreign key on source_id, and it CANNOT have one — it points at two
  -- different tables depending on `source`. That is the usual argument for not
  -- doing this at all, and it is outweighed here by the alternative being a
  -- second copy of the whole relay. The route tolerates a source_id that does
  -- not resolve; see the sweep note below for what it does with one.
  source     text NOT NULL CHECK (source IN ('report', 'event_feedback')),
  source_id  uuid NOT NULL,

  guild_id           text NOT NULL,
  channel_id         text NOT NULL,
  discord_message_id text NOT NULL,

  -- What was last successfully posted. Compared against the live row each tick
  -- so an edited survey response edits its message instead of posting a second
  -- one. The RENDERED text rather than the raw columns, because the rating and
  -- the comment can both change and the message is the thing being compared.
  --
  -- For a report this never changes — nothing edits feedback_reports — so the
  -- comparison is trivially equal and the row is only ever an idempotency
  -- record. That asymmetry is fine; one column serving both beats two.
  synced_summary     text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Per guild, like every other discord_*_posts table: the same report relayed
  -- to a test server and the real one is two messages, not a conflict.
  PRIMARY KEY (source, source_id, guild_id)
);

-- The route's hot path is "everything mapped for this guild", which the primary
-- key cannot serve because it leads with source.
CREATE INDEX IF NOT EXISTS discord_feedback_posts_guild_idx
  ON public.discord_feedback_posts (guild_id);

ALTER TABLE public.discord_feedback_posts ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: nothing but the service role has any business here,
-- and an absent policy under RLS denies everyone else by default.
REVOKE ALL ON public.discord_feedback_posts FROM PUBLIC;
REVOKE ALL ON public.discord_feedback_posts FROM anon, authenticated;
GRANT ALL  ON public.discord_feedback_posts TO service_role;

-- ---- 3. THE SYNC SCHEDULE ---------------------------------------------------
--
-- Every 10 minutes. This is an inbox, not a feed: nobody is standing in the
-- channel waiting for a bug report the way they wait on "no session tonight".
-- Ten also matches the match relay, so the two land on the same tick boundary
-- and one slow Discord minute delays both rather than staggering them.

SELECT cron.unschedule('discord-feedback')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-feedback');

SELECT cron.schedule(
  'discord-feedback',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'discord_bot_url') || '/feedback',
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
-- LIST rather than an error — so without this the new columns read as null and
-- the new table reads as empty, indefinitely, while psql sees both perfectly.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- OWNER NOTES
-- ============================================================================
--
-- ---- 1. NOTHING IS RELAYED UNTIL A CHANNEL IS SET --------------------------
--
-- Two keys, independently. Neither implies the other; see the header.
--
--   -- /bug and /feedback filed in Discord:
--   INSERT INTO discord_settings (key, value)
--   VALUES ('feedback_channel_id', '<the channel id>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
--   -- tournament survey comments from the website:
--   INSERT INTO discord_settings (key, value)
--   VALUES ('event_feedback_channel_id', '<the channel id>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- BOTH CHANNELS MUST BE EXEC-ONLY. A bug report names its reporter; a survey
-- comment names its author and is answered under a promise of privacy. Neither
-- is channel material for the whole server. Check the channel's permissions
-- before setting either key, not after.
--
-- ---- 2. WHAT GOES OUT, AND WHAT DOES NOT -----------------------------------
--
--   report            title, body, kind, the reporter (as a mention if linked,
--                     otherwise their Discord id), the screenshot if there was
--                     one and the relay reached it in time.
--   event_feedback    tournament name, the star rating, the comment, and the
--                     player's name.
--
-- A survey response with NO COMMENT is not relayed at all. A bare rating is a
-- number for the stats page, not something for a human to read, and relaying
-- them would bury the ones with words in them.
--
-- ---- 3. THE SWEEP, AND WHY ONLY ONE SOURCE HAS ONE -------------------------
--
-- event_feedback IS HARD-DELETED. Not directly — nothing deletes it on its own
-- — but deleteTournament (apps/admin/src/lib/actions/tournaments.ts) removes
-- the tournament row outright and event_feedback cascades with it. A tournament
-- deleted from the console must take its feedback posts down too, so this
-- source carries the same orphan sweep as 00169 and 00170, including 00170's
-- liveness guard: a mapping whose row is absent is retracted ONLY on positive
-- evidence that event_feedback reads at all. Empty is not that evidence, and
-- treating it as such would wipe the channel on a stale schema cache.
--
-- feedback_reports HAS NO SWEEP, because nothing deletes from it. player_id is
-- ON DELETE SET NULL by 00172's own design, so even losing the reporter leaves
-- the row. If a delete path is ever added, this relay needs a sweep before it
-- ships — the same warning 00171 carries about a future "delete match" action.
--
-- ---- 4. RETRACTION IS AN EDIT, NOT A DELETE --------------------------------
--
-- A member cannot delete a survey response; they can only edit it, including
-- down to an empty comment. An emptied comment is a retraction and the relay
-- treats it as one: the message is deleted and the mapping cleared, so writing
-- it again re-posts. There is no such path for a report — /bug files and is
-- done — and taking one of those down is a manual delete in Discord. The
-- mapping row survives that, and the relay only ever posts what has no mapping,
-- so a hand deletion is permanent. Same as the match relay, same reason.
--
-- ---- 5. TAKING THE WHOLE RELAY BACK DOWN -----------------------------------
--
-- Clearing the channel keys stops new posts but leaves the existing ones up —
-- the route needs a channel to know where to delete from. To retract what is
-- already out there, delete the messages in Discord and then:
--
--   DELETE FROM discord_feedback_posts;
--
-- in that order. The other order re-posts everything still inside the window on
-- the next tick.
-- ============================================================================
