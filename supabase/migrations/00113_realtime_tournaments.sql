-- ============================================================
-- 00113_realtime_tournaments.sql — publish the four tables a tournament's
-- progress actually lives in, so a draw moves while people are watching it
-- ============================================================
-- WHY
-- ---
-- Four screens subscribe to postgres_changes on these tables:
--
--   apps/player/src/app/tournaments/live-tournament.tsx
--     <- apps/player/src/app/tournaments/[id]/page.tsx
--     <- apps/player/src/app/tournaments/[id]/events/[eventId]/page.tsx
--   apps/admin/src/app/tournaments/live-tournament.tsx
--     <- apps/admin/src/app/tournaments/[id]/page.tsx
--     <- apps/admin/src/app/tournaments/[id]/events/[eventId]/page.tsx
--
-- A tournament is the one thing this club does where a screen is watched by
-- somebody who is not the person typing. `revalidateEventPaths()` at the end of
-- every action covers the exec at the scoring table and nobody else: the twenty
-- entrants refreshing the bracket on their phones to see whether their next
-- match is ready, the second exec running the other half of the draw from a
-- laptop, and the player-facing standings on a screen by the courts all sat on
-- whatever they rendered when they loaded.
--
-- *** NOTHING HAPPENS UNTIL THIS FILE IS RUN. ***
--
-- A subscription to a table that is not a member of `supabase_realtime`
-- SUCCEEDS and then never fires: .subscribe() resolves, the callback simply
-- never runs, nothing errors anywhere. That is not hypothetical — it is what
-- 00036 was written to fix after the leaderboard and the announcements badge
-- shipped "live" and were silently static for months, and 00112 is the third
-- entry against the same rule. Until this is applied all four screens behave
-- exactly as they did before: correct on load, correct after the viewer's own
-- write, stale otherwise.
--
-- WHAT DECIDED THE LIST: not what the pages READ, which is a much longer list
-- taking in `tournaments`, `players`, `seasons`, `event_feedback`,
-- `tournament_fee_tiers` and `platform_settings`, but what the PROGRESS write
-- paths MUTATE. enterMatchResult (apps/admin/src/lib/tournament-actions/
-- results.ts) and the draw/finalize paths (brackets.ts, finalize.ts) between
-- them write exactly these four tables plus `ratings` (already published since
-- 00036), `reliability_metrics`, `notifications` and `tournament_audit_log` —
-- and the last three are not read by any of the four screens above.
--
-- SAFE TO PUBLISH, TABLE BY TABLE
-- -------------------------------
-- Publishing a table streams its rows to every subscribed client, filtered by
-- RLS, so the question each time is "does this hand out something a query would
-- not". All four answer no for the same structural reason and each has its own
-- wrinkle worth writing down.
--
--   tournament_events. RLS enabled (00005:39). Final SELECT policy is
--     tournament_events_select, `FOR SELECT TO authenticated USING (true)`
--     (00022:102) — 00022 dropped 00005's "Public read tournament_events",
--     which had no TO clause and therefore reached `anon`, and replaced it with
--     an authenticated-only one. Every signed-in member can already read every
--     row. The cleanest of the four: nineteen columns of format, seeding and
--     status, and not one of them free text. This is also the only table here
--     carrying `tournament_id`, which is what lets one listener cover a whole
--     tournament's events including one that does not exist yet.
--
--   tournament_matches. RLS enabled (00005:42), final SELECT policy
--     tournament_matches_select, `FOR SELECT TO authenticated USING (true)`
--     (00022:117), same 00022 anon fix. The draw itself: rounds, bracket
--     positions, scores, walkovers, and the winner_to_match_id wiring that
--     advancement rewrites.
--
--     IT DOES CARRY FREE TEXT, unlike session_attendance in 00112, and saying
--     "no name is in it" here would be a lie: `notes`, `walkover_reason` and
--     the `elo_snapshot` JSONB (player ids with before/after ratings) all
--     stream verbatim. That is not a new exposure — the SELECT policy above is
--     USING (true) and 00032's column-level GRANT surgery was done to `players`
--     and to nothing else, so any signed-in member can already ask PostgREST
--     for those columns directly. It is a reason the callbacks must stay
--     refresh-only, which they are.
--
--   tournament_participants. RLS enabled (00005:40), final SELECT policy
--     tournament_participants_select, `FOR SELECT TO authenticated USING
--     (true)` (00022:107). Where a singles event's standings actually live:
--     `status`, `seed_number`, `points`, `final_position`, `elo_change`. Same
--     free-text `notes` caveat as above, same answer. Carries `event_id` and
--     `player_id`, so it can be scoped either way.
--
--   tournament_pairs. RLS enabled (00005:41), final SELECT policy
--     tournament_pairs_select, `FOR SELECT TO authenticated USING (true)`
--     (00022:112). The doubles half of the same thing — a doubles event has no
--     participant rows at all, so publishing only the singles table would make
--     exactly half the club's events live and leave nobody able to tell which
--     half they were looking at. `pair_name` is member-chosen free text and
--     often a real name; same reasoning as `notes`, and again the reason the
--     rendering decision stays on the server.
--
-- NO NAME REACHES A CLIENT THROUGH THIS ANYWAY. All four tables carry ids; the
-- brackets and entry lists show names because the SERVER joins `players` when
-- it re-renders. Every callback calls router.refresh() rather than merging the
-- socket payload into local state, so the console's capability gates
-- (tournaments.results.write, tournaments.manage.*, the fee badges) are all
-- re-evaluated server-side on the viewer's own credentials and a live update
-- cannot surface what a static render withheld.
--
-- CONSIDERED AND LEFT OUT
-- -----------------------
-- The house rule from 00036 stands and this is the fourth entry against it:
-- publish only what the UI actually listens to.
--
--   * players — must NEVER be published, and the usual one-line warning
--     understates it. 00032 did not change the players_select RLS policy at
--     all; it REVOKED table-level SELECT and re-granted a column whitelist.
--     Postgres logical replication does not honor column-level grants, so
--     publishing that table would stream `email` and `phone` to every
--     subscriber whose row filter passes — the columns 00032 exists to
--     withhold, handed back through a channel that never consults the grant.
--   * tournaments — read by all six tournament screens, but nothing a RESULT
--     does touches it. Its status is moved by an exec pressing a button, and
--     that exec is the one person revalidatePath already covers. Publishing it
--     would wake every tournament screen in the club for an event that changes
--     a chip.
--   * matches and match_games — the obvious candidates and both wrong here.
--     Tournament scoring writes neither: enterMatchResult writes
--     tournament_matches and calls apply_tournament_match_rating, and the
--     `matches` table is the club-play and challenge ledger. match_games is
--     additionally unfilterable for this purpose — its only foreign key is
--     match_id, so scoping a subscription to one tournament is not expressible
--     and the alternative is every game score in the club on every screen.
--   * tournament_audit_log — its SELECT policy has no TO clause and is gated on
--     is_admin(), and its `details` JSONB is unbounded. Nothing renders it live.
--   * tournament_checkin_tokens — never. 00045 gives it zero policies and
--     revokes all access from anon and authenticated on purpose: holding the
--     token IS the proof of standing at the door.
--   * reliability_metrics, notifications, tournament_fee_tiers — written or
--     read somewhere nearby, but not by any of the four screens above.
--
-- NO COLUMN LISTS, AND NOT BY CHOICE. A publication column list must contain
-- every replica-identity column; replica identity here is left at the default,
-- the primary key `id`, which is not a column anyone would want in the list.
-- So `notes` and friends cannot be stripped at the publication. Default replica
-- identity is still the right setting: the callbacks only need to know that
-- something changed, and REPLICA IDENTITY FULL would stream every deleted row's
-- entire contents to every subscriber to fix a gap described below that none of
-- these surfaces actually depends on.
--
-- FOUR SEPARATE GUARDED STATEMENTS, one per table, rather than one ADD TABLE
-- with four names or a loop over an array. Two reasons, both practical. A
-- single four-name ADD is all-or-nothing: if a later hand-run has already added
-- one of them the whole statement raises "relation is already member of
-- publication" and the other three never land. And a loop would have to build
-- the statement with EXECUTE format(...), which the publication guard tests
-- (apps/{player,admin}/src/lib/__tests__/realtime-publication.test.ts) read as
-- text and cannot see through — the guard would conclude these tables are
-- unpublished and fail, which is the correct behaviour for a test that cannot
-- tell. Written out, it can.
--
-- IDEMPOTENT, like 00096 and 00112 and unlike 00036's bare ADD: a migration
-- that cannot be piped in twice is a migration nobody dares re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'tournament_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_events;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'tournament_matches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_matches;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'tournament_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_participants;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'tournament_pairs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_pairs;
  END IF;
END
$$;

-- WHAT THESE SUBSCRIPTIONS WILL NOT DELIVER, and why the gap is survivable.
--
-- Under default replica identity a DELETE's WAL tuple carries only the primary
-- key, so `event_id` and `tournament_id` are not in it and a subscription
-- filtered on either is never routed the event. Every listener here is
-- filtered, so every DELETE against these four tables is invisible to everyone
-- except the exec who caused it. There are exactly four of them:
--
--   1. deletePhaseMatches (brackets.ts) clears an event's matches before a
--      draw is regenerated. Self-healing, and this is the one that matters:
--      the DELETEs are lost but the INSERTs that immediately follow are NOT —
--      an INSERT's tuple is the new row and carries `event_id` — so the
--      refresh fires and the re-render simply no longer contains the old
--      matches. A rebuilt draw reaches every watcher.
--
--   2. removeParticipantFromEvent and 3. the pair equivalent (participants.ts)
--      both refuse unless the event is still at `registration` or `checkin`,
--      and 4. deleteTournamentEvent (events.ts) refuses unless the event is at
--      `registration`. So all three real gaps are confined to BEFORE a draw
--      exists, which is the answer to the obvious worry: no bracket, score or
--      standing can be affected by a row disappearing, because by the time
--      there is a draw to watch, nothing on these tables can be deleted.
--
--      What IS affected is an entry list during registration and check-in: a
--      removed entrant stays on another exec's screen until they navigate or
--      reload. A withdrawal after the draw is an UPDATE to status='withdrawn',
--      not a delete, and is delivered normally. The alternatives are both
--      worse than the gap — REPLICA IDENTITY FULL streams every deleted row's
--      full contents to every subscriber, and dropping the filters wakes every
--      tournament screen in the club for every other tournament's traffic.
--
-- WORTH KNOWING BEFORE THIS IS RUN ON STAGING, and still true as of 00112:
-- staging's supabase_realtime publication is EMPTY — 00036 has never been
-- applied there — so these four tables will be the only published ones on that
-- database while `ratings` and `announcements` stay silent. That matters more
-- for this change than for 00112's, because the my-stats and feed listeners
-- shipping alongside it depend on `ratings` and nothing else. Reapplying 00036
-- is 00036's job, not this file's, and production has all four of its tables,
-- verified against pg_publication_tables.
