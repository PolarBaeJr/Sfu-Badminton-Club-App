-- 00172: one inbox for bug reports and feedback, filed from Discord.
--
-- /bug and /feedback both land here. One table with a `kind` rather than two
-- tables, because the difference between "the ladder page 500s" and "the ladder
-- should show my last five games" is a label, not a shape: both are a member,
-- some prose, and a state of having-been-dealt-with-or-not. Two tables would
-- have meant two routes, two grants and two triage queries for no gain.
--
-- ---------------------------------------------------------------------------
-- THIS IS NOT event_feedback, WHICH ALREADY EXISTS AND IS UNTOUCHED
-- ---------------------------------------------------------------------------
--
-- The name collision is going to read as an oversight, so: event_feedback
-- (00001) is the post-tournament survey. It is scoped to a tournament by FK, it
-- carries a 1-5 rating, it is UNIQUE (tournament_id, player_id), and two pages
-- plus the player-merge routine (00079, 00163) read and rewrite it. It answers
-- "how was that event". This table answers "here is something I want to tell
-- the club", from anywhere, at any time, as many times as you like.
--
-- The 'tournament_feedback' kind below is therefore NOT a duplicate of it: it
-- is the free-text remark someone types into Discord the evening of an event,
-- with no rating and no event to attach it to.
--
-- WHICH IS WHY THERE IS NO tournament_id COLUMN. A slash command gives the
-- reporter no way to name a tournament — that would need an autocomplete option
-- backed by a lookup route — so a tournament_id here could never be populated
-- at insert time. A column nothing can ever fill is worse than no column: it
-- reads as data that is merely missing. The body says which event.
--
-- ---------------------------------------------------------------------------
-- NOTHING READS THIS TABLE YET
-- ---------------------------------------------------------------------------
--
-- There is no admin page. Reports land here and are read by hand:
--
--   SELECT created_at, kind, body FROM feedback_reports
--    WHERE status = 'open' ORDER BY created_at DESC;
--
-- Surfacing them in the admin app is the obvious next step and is not built. If
-- nobody runs that query, this is a black hole and the first person to notice
-- will be a member asking why their bug report went nowhere.
--
-- ---------------------------------------------------------------------------
-- A MERGE DOES NOT CARRY THESE ROWS
-- ---------------------------------------------------------------------------
--
-- merge_players (00079, 00163) reassigns player_id across an ENUMERATED list of
-- tables, and feedback_reports is not on it. So when a duplicate account is
-- merged away, its reports keep pointing at the removed row, the ON DELETE SET
-- NULL below fires, and the body survives while the attribution does not: the
-- report reads as anonymous even though the member is still in the club.
--
-- That is a graceful degradation and deliberately not fixed here — adding a
-- table to the merge enumeration is a change to a SECURITY DEFINER function
-- that rewrites history, and it is not worth that for prose nothing reads yet.
-- If it ever matters, the fix is one UPDATE in merge_players alongside the
-- others. discord_user_id is untouched by a merge either way, so a hand
-- attribution is always still possible.

CREATE TABLE IF NOT EXISTS public.feedback_reports (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- 'other' is deliberate: without it, anything that is not squarely a bug or a
  -- feature request gets filed as whichever is closer and the kind stops
  -- meaning anything.
  kind       text NOT NULL
             CHECK (kind IN ('bug', 'feedback', 'tournament_feedback', 'other')),

  -- Capped HERE and not only in the route. The route's cap depends on Discord's
  -- option limit and on the route staying the only writer; this one holds no
  -- matter who inserts. 4000 is far above anything typed into a slash command
  -- and far below anything that would bloat the table.
  body       text NOT NULL
             CHECK (length(body) BETWEEN 1 AND 4000),

  -- NULLABLE, AND ON DELETE SET NULL, for two different reasons.
  --
  -- Nullable: a member who has not run /link can still file a bug, and refusing
  -- them would silence exactly the people most likely to hit an onboarding bug.
  --
  -- SET NULL rather than CASCADE: the report outlives the account. A bug is
  -- still a bug after the person who found it leaves the club, and CASCADE
  -- would quietly delete the evidence along with the reporter.
  player_id  uuid REFERENCES public.players(id) ON DELETE SET NULL,

  -- Kept even when player_id is set, because it is the only handle on an
  -- unlinked reporter and the only way to reply to them. It is a Discord
  -- snowflake, stored as text like every other id in the discord_* tables.
  discord_user_id text,
  guild_id        text,

  source     text NOT NULL DEFAULT 'discord'
             CHECK (source IN ('discord', 'app')),

  -- Writable from day one, because triage is a psql session for now.
  status     text NOT NULL DEFAULT 'open'
             CHECK (status IN ('open', 'triaged', 'resolved', 'wont_fix')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The triage query's index: open reports, newest first.
CREATE INDEX IF NOT EXISTS feedback_reports_open_idx
  ON public.feedback_reports (created_at DESC)
  WHERE status = 'open';

-- "Everything this member ever filed", for a reply or a merge.
CREATE INDEX IF NOT EXISTS feedback_reports_player_idx
  ON public.feedback_reports (player_id)
  WHERE player_id IS NOT NULL;

-- SERVICE ROLE ONLY. The one writer is the Discord route, which authenticates
-- with the service secret and uses the service-role key. No anon or
-- authenticated access at all: a member reading this table would be reading
-- every other member's complaints, several of which will be about them.
--
-- When the admin page is built it goes through a server action on the service
-- role, like the rest of the admin app — not by loosening these grants.
ALTER TABLE public.feedback_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feedback_reports FROM PUBLIC;
REVOKE ALL ON public.feedback_reports FROM anon, authenticated;
GRANT ALL  ON public.feedback_reports TO service_role;

-- RLS is on with no policies, which denies everything to anon and authenticated
-- even if a grant is added by mistake later. service_role bypasses RLS, so the
-- route is unaffected. Belt and braces, on a table of private complaints.

NOTIFY pgrst, 'reload schema';
