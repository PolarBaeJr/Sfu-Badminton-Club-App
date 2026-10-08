-- ============================================================================
-- 00222 — A queue for messages the console asks Discord to post
--
-- /say already lets an exec speak as the club, and it lives in Discord: you
-- have to be in the server, with Manage Server, on a device with the app open.
-- The club's officers do their work in the admin console, and every time they
-- wanted to put a line in the channel they had to leave it. This is the same
-- command, from the same place they write announcements.
--
-- WHY A TABLE AND NOT AN HTTP CALL. The console holds no Discord token, and it
-- must not: the bot is a small service whose entire justification is that the
-- token lives in exactly one place with nothing else in it (apps/bot has zero
-- production dependencies for the same reason). Giving admin a DISCORD_BOT_TOKEN
-- would double the number of processes that can speak as the club, and both of
-- them are internet-facing web apps.
--
-- So the console writes a row and the bot posts it, which is the split the
-- whole Discord integration already uses: THE APP DECIDES, THE BOT POSTS. This
-- row is the decision.
--
-- WHY IT IS NOT INSTANT, AND WHY THAT IS WRITTEN DOWN IN THE UI. The bot picks
-- these up on the existing announcements tick (pg_cron, every five minutes —
-- 00170). No new cron job, no new owner step. The cost is that Send means
-- "within five minutes", which reads as broken unless the screen says so, so
-- the console shows the row's state — queued, sent, or the error Discord gave —
-- rather than a toast that claims more than it knows.
--
-- WHY THE CLAIM COLUMNS. The bot runs at N replicas and the tick is delivered
-- to whichever one the proxy picks, so two overlapping ticks can be two
-- different processes. `claimed_at` is taken by an UPDATE ... RETURNING, which
-- is atomic per row: a second claimant blocks on the row lock and then re-reads
-- the predicate against the committed value, finds it claimed, and takes
-- nothing.
--
-- A CLAIM EXPIRES, and the direction of that trade is deliberate. A row claimed
-- and never resolved — the bot died mid-post — becomes claimable again after
-- ten minutes, which means a message that WAS posted but whose write-back
-- failed can be posted twice. That is the same choice the announcement relay
-- makes and for the same reason: a duplicate somebody mentions is better than a
-- club notice that silently never went out. `attempts` bounds it at three, so a
-- message Discord keeps refusing stops rather than looping forever.
--
-- WHAT IT CANNOT DO. Nothing here can put a role, a channel or a permission
-- anywhere. It is one message into one channel, and the two things that decide
-- how loudly it lands — whether mentions notify, and which channel — are both
-- recorded on the row next to the person who asked for it.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.discord_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  guild_id    text NOT NULL,
  -- Not a foreign key to anything: a channel id comes off Discord and this
  -- database has no table of channels. The format check is the whole
  -- validation, and it is the same one 00167 puts on a role id.
  channel_id  text NOT NULL CHECK (channel_id ~ '^[0-9]{5,25}$'),

  -- ---- the message ------------------------------------------------------
  --
  -- EXACTLY ONE OF THE TWO SHAPES, enforced below. A plain message is /say —
  -- it reads as though a person typed it. An embed is what the announcement
  -- relay posts, and it exists here so the club can send something that looks
  -- like a notice without it being an announcement on the website.
  content      text,

  embed_title  text,
  embed_body   text,
  -- Mirrors announcement_type (00001:595) because it picks the colour, and the
  -- console previews it with the relay's own code. Not the enum itself: an
  -- outbox message is not an announcement, and borrowing the type would tie a
  -- free-text feature to a schema change made for a different one.
  embed_type   text CHECK (embed_type IN ('info', 'warning', 'urgent', 'event')),

  -- FALSE MEANS SILENCE, and the default is the safe one. With it off, an
  -- @everyone typed into the text still READS as a mention and notifies
  -- nobody — the same allowed_mentions posture /say has. A ping nobody asked
  -- for has already buzzed every phone in the server and cannot be taken back.
  ping         boolean NOT NULL DEFAULT false,

  -- ---- who asked --------------------------------------------------------
  --
  -- SET NULL rather than CASCADE: the record of what the club said in its own
  -- channel must outlive the departure of whoever said it. The audit row
  -- written when this is queued carries the name.
  requested_by uuid REFERENCES public.players(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- ---- what happened ----------------------------------------------------
  claimed_at         timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  sent_at            timestamptz,
  discord_message_id text,
  failed_at          timestamptz,
  -- Discord's own words, shown back to the person who pressed Send. Bounded,
  -- because an unbounded string from another service ends up on a page.
  last_error         text CHECK (last_error IS NULL OR length(last_error) <= 500),

  -- One shape or the other, never both and never neither.
  CONSTRAINT discord_outbox_one_shape CHECK (
    (content IS NOT NULL AND length(btrim(content)) > 0
       AND embed_title IS NULL AND embed_body IS NULL AND embed_type IS NULL)
    OR
    (content IS NULL AND embed_title IS NOT NULL AND length(btrim(embed_title)) > 0)
  ),

  -- Discord's limits, refused here rather than by a 400 after the words are
  -- gone. 2000 for a message, 256/4096 for an embed's title and description.
  CONSTRAINT discord_outbox_within_discord_limits CHECK (
    (content IS NULL OR length(content) <= 2000)
    AND (embed_title IS NULL OR length(embed_title) <= 256)
    AND (embed_body IS NULL OR length(embed_body) <= 4096)
  )
);

-- The bot's read: unsent, unclaimed (or a claim that has gone stale), still
-- within its attempt budget, oldest first. Partial, because the sent rows are
-- the ones that accumulate and none of them are ever read this way.
CREATE INDEX IF NOT EXISTS discord_outbox_pending_idx
  ON public.discord_outbox (created_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

-- The console's read: what this club has sent lately, newest first.
CREATE INDEX IF NOT EXISTS discord_outbox_recent_idx
  ON public.discord_outbox (created_at DESC);

COMMENT ON TABLE public.discord_outbox IS
  'Messages the admin console has asked the bot to post in Discord. Written by '
  'the console through the service-role client, drained by the bot on the '
  'announcements tick. See 00222.';

-- Same posture as every other Discord table (00167, 00170): RLS on with no
-- policies, and service_role only. The console reaches this through
-- createAdminClient(), which IS service role, so there is no policy to write —
-- and a table `authenticated` can insert into is a table any logged-in member
-- could use to speak as the club.
ALTER TABLE public.discord_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.discord_outbox FROM PUBLIC;
REVOKE ALL ON public.discord_outbox FROM anon, authenticated;
GRANT ALL  ON public.discord_outbox TO service_role;

COMMIT;

-- WITHOUT THIS THE TABLE IS INVISIBLE TO EVERY READ THAT MATTERS. PostgREST
-- caches the schema, and a brand new table it has not seen comes back as an
-- EMPTY LIST with no error at all — so the console would show "nothing queued"
-- forever and the bot would drain nothing, with neither of them reporting a
-- fault. Superuser psql proves nothing here: it bypasses the cache entirely.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- NOTHING IS OWNER-RUN AFTER THIS.
--
-- The channel comes from the console (it defaults to the announcement channel
-- already in discord_settings), the bot drains it on a tick that already
-- exists, and no new pg_cron job is needed.
--
-- To confirm the table is reachable THROUGH POSTGREST rather than just through
-- psql — which is the failure this migration's NOTIFY exists to prevent:
--
--   select count(*) from discord_outbox;   -- psql: proves the table exists
--
-- ...and then, from the console, the Discord panel on /announcements. If it
-- lists a message you queued, PostgREST has the table. If it stays empty with
-- no error, the schema cache has not reloaded.
-- ============================================================================
