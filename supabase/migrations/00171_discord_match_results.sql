-- 00171: relay confirmed match results to a Discord channel.
--
-- WHAT GOES OUT: who played, the score, who won. Nothing else.
--
-- NO ELO. Not an oversight and not a phase-one shortcut — a decision. The score
-- and the winner are facts about a game other members watched happen. A rating
-- delta is a judgment about a person, and the club already ships an opt-out
-- (players.hide_from_leaderboard) that exists precisely so that judgment is not
-- put on display. Members read their own numbers from /my-stats, which answers
-- ephemerally, to the person they are about. The route does not even SELECT
-- match_participants.rating_delta or .post_rating, so there is no column for a
-- later edit to leak by accident.
--
-- ============================================================================
-- WHY THERE IS NO ORPHAN SWEEP HERE, UNLIKE 00169 AND 00170
-- ============================================================================
--
-- Both earlier relays carry a sweep: a mapping whose source row no longer
-- resolves is treated as a delete-from-the-website and retracted. That machinery
-- is load-bearing there because both sources really are hard-deleted
-- (deleteAnnouncement removes the row outright).
--
-- A CONFIRMED MATCH IS NEVER HARD-DELETED. The only .delete() on public.matches
-- in the whole codebase is discardIncompleteMatch
-- (apps/admin/src/lib/actions/matches.ts), and it is scoped
-- `.eq('result_status', expectedStatus)` where expectedStatus is 'incomplete' or
-- 'pending_confirmation' — never 'confirmed'. Every actual retraction is an
-- UPDATE:
--
--   voidMatch             -> result_status = 'voided'
--   convertMatchToCasual  -> rated_flag=false, event_type='casual',
--                            result_status='pending_confirmation'
--   dispute_match_result  -> result_status = 'disputed'
--
-- and every one of those bumps matches.updated_at, which is what the route's
-- window is keyed on. So a match that needs taking down always re-enters the
-- window under its own steam, and "absent from the window" can only ever mean
-- "not touched lately" — i.e. unchanged. There is nothing for a sweep to do,
-- and a sweep would be actively dangerous: it would read absence as deletion
-- and start retracting live results.
--
-- The same asymmetry removes the liveness guard 00170 needed. There, a silently
-- empty read (missing SELECT grant, stale PostgREST cache) meant "everything was
-- deleted" and wiped the channel. Here a silently empty read means "nothing was
-- touched", the route does nothing at all, and the posts stay up. The failure
-- direction is already the safe one, so no guard is warranted — and a guard
-- whose rationale does not apply is worse than none, because the next reader
-- trusts it.
--
-- IF SOMEBODY LATER ADDS AN ADMIN "DELETE MATCH" ACTION that can reach a
-- confirmed row, this whole argument collapses and the relay needs a sweep plus
-- 00170's liveness guard before that action ships. That is the one change to
-- watch for.
--
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.discord_match_posts (
  -- NO FOREIGN KEY on match_id, and here the reason is CONSISTENCY, not danger.
  --
  -- In 00169 and 00170 a cascade would have been an outright bug: it would take
  -- the mapping with the source row and strand the Discord copy with nothing
  -- left to find it by. On this table a `REFERENCES public.matches(id) ON
  -- DELETE CASCADE` would actually be harmless, because per the header no
  -- confirmed match is ever deleted and so the cascade could never fire on a
  -- mapped row.
  --
  -- It is left off anyway so all three discord_*_posts tables read the same way
  -- and are reasoned about the same way. A single table in the set behaving
  -- differently is a trap for whoever reads them next, and the FK would be
  -- buying nothing: the route already tolerates a match_id that does not
  -- resolve (it leaves the row alone rather than guessing).
  match_id           uuid NOT NULL,
  guild_id           text NOT NULL,
  channel_id         text NOT NULL,
  discord_message_id text NOT NULL,

  -- What was last successfully posted, compared against the live match each
  -- tick so a corrected score edits the existing message instead of posting a
  -- second one. The rendered line is stored rather than the raw columns because
  -- the roster is part of what can change: a doubles match whose participants
  -- were fixed afterwards has the same score_summary and a different message.
  synced_summary     text NOT NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- Per guild: the same match relayed to a test server and the real one is two
  -- messages, not a conflict.
  PRIMARY KEY (match_id, guild_id)
);

-- The route's hot path is "mappings for this guild", and the primary key leads
-- with match_id, so it cannot serve that.
CREATE INDEX IF NOT EXISTS discord_match_posts_guild_idx
  ON public.discord_match_posts (guild_id);

ALTER TABLE public.discord_match_posts ENABLE ROW LEVEL SECURITY;

-- No policies on purpose. Nothing but the service role has any business here,
-- and an absent policy under RLS denies everyone else by default.
REVOKE ALL ON public.discord_match_posts FROM PUBLIC;
REVOKE ALL ON public.discord_match_posts FROM anon, authenticated;
GRANT ALL  ON public.discord_match_posts TO service_role;

-- ---- THE SYNC SCHEDULE -----------------------------------------------------
--
-- Every 10 minutes: slower than announcements, because nobody is waiting on a
-- result the way they wait on "no session tonight", and faster than the
-- tournament sweep, because results land in bursts on a club night and a
-- half-hour lag would make the channel read as a digest rather than a feed.

SELECT cron.unschedule('discord-match-results')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-match-results');

SELECT cron.schedule(
  'discord-match-results',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'discord_bot_url') || '/match-results',
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
-- OWNER NOTES
-- ============================================================================
--
-- ---- 1. NOTHING IS RELAYED UNTIL A CHANNEL IS SET -------------------------
--
-- The relay is off by default, and stays off, until this row exists:
--
--   INSERT INTO discord_settings (key, value)
--   VALUES ('match_results_channel_id', '<the channel id>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--
-- Pick the channel deliberately. Every member of the server sees this, which is
-- a wider audience than the website's /feed — that one is behind a login, and
-- `matches_select ... TO authenticated USING (TRUE)` is what makes it club-wide.
-- Same reasoning that made the announcement relay carry only
-- target_audience = 'all'.
--
-- ---- 2. WHICH MATCHES GO OUT ----------------------------------------------
--
-- All four conditions, or the match is not posted:
--
--   result_status = 'confirmed'   pending, disputed, voided and walkover never
--                                 go out. A walkover in particular names who
--                                 forfeited, which is not channel material.
--   winner_side IS NOT NULL       there is no result to report without one.
--   played_at IS NOT NULL         unplayed rows are not results.
--   event_type on the allowlist   see below.
--
-- The allowlist lives in the route (RELAYABLE_EVENT_TYPES) and is currently
-- rated_challenge + admin_entered: the matches somebody deliberately set up or
-- an exec deliberately recorded. 'casual' is excluded — a club night of doubles
-- rotations would turn the channel into a firehose — and so is 'trial'.
--
-- 'tournament' is on the enum and is NOT on the allowlist, because as of this
-- migration NOTHING WRITES IT. Tournament results live in tournament_matches
-- and never become public.matches rows; grep confirms no insert anywhere sets
-- event_type = 'tournament'. Adding it to the allowlist today would relay
-- exactly nothing. If tournament results are ever mirrored into matches, note
-- that a 64-draw is ~63 messages over a weekend and decide on that basis rather
-- than flipping the constant.
--
-- ---- 3. hide_from_leaderboard IS A PRE-PUBLICATION FILTER, NOT A TAKEDOWN --
--
-- If ANY participant has players.hide_from_leaderboard set, the match is not
-- posted at all. Not "posted with that name redacted" — a two-player match with
-- one name removed identifies the opt-out by elimination, which is worse than
-- posting nothing.
--
-- BUT READ THIS PART. That check runs when the match is CONSIDERED, and it
-- cannot run again afterwards. The flag lives on players; flipping it does not
-- touch matches.updated_at, so the match never re-enters the route's window and
-- there is nothing to trigger a retraction. A member who opts out today does
-- NOT have last month's posted results pulled down.
--
-- That is a deliberate choice over the alternative (re-reading every mapped
-- match's participants on every tick, forever), and the remedy for the rare
-- case is manual and already supported: DELETE THE MESSAGE IN DISCORD BY HAND.
-- The mapping row survives, the route only ever posts a match that has no
-- mapping, and so it is never re-posted. Hand-deletion is permanent here by
-- design.
--
-- ---- 4. TAKING THE WHOLE RELAY BACK DOWN ----------------------------------
--
-- Clearing match_results_channel_id stops new posts but leaves the existing
-- ones up — the route needs a channel to know where to delete from. To retract
-- what is already out there, delete the messages in Discord (a channel-wide
-- purge is fine) and then:
--
--   DELETE FROM discord_match_posts;
--
-- in that order. The other order would re-post everything still inside the
-- window on the next tick.
--
-- ---- 5. IF THE CHANNEL LOOKS STUCK ----------------------------------------
--
-- Unlike 00170 this route has no refuse-to-act guard, because its failure mode
-- is inaction rather than a wipe. So a stuck channel is the symptom of a broken
-- read, and it is silent. Check, in order:
--
--   * the SELECT grant, by reading pg_class.relacl — NOT
--     information_schema.role_table_grants, which reports grants that do not
--     exist and has cost this project a false all-clear before;
--   * the PostgREST schema cache: NOTIFY pgrst, 'reload schema';
--   * the bot log, which names every skipped match and why.
-- ============================================================================
