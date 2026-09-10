-- ============================================================
-- RETIRE THE SUMMER 2026 TEST SEASON
--
-- DELIBERATELY NOT IN supabase/migrations/. Nothing here is applied by any
-- automated step. It is run by hand, by the club owner, after reading it,
-- it rewrites three real members' ratings, and the numbers on either side are
-- a human check rather than an assertion in a script.
--
-- WHY
--   Summer 2026 (15af1db0) is a test season. The owner's words, 2026-09-09:
--   "that season is the test season it never existed". It holds one test
--   tournament still showing as `active`, which is why a brand-new Fall 2026
--   season renders a live tournament on the player app.
--
-- WHAT MOVED THE RATINGS, and what did NOT
--   Three `rated_challenge` matches did. The test TOURNAMENT did not.
--   The accounting closes with nothing left over, which is the check:
--     sum(ratings.singles_matches_played) = 6, doubles = 0
--     match_participants                  = 6 rows  (3 singles matches x 2)
--   The tournament carries an `elo_snapshot` on 3 of its 9 tournament_matches,
--   and a snapshot is NOT an application. Those never touched `ratings`.
--
-- ORDER (sections 1 and 2 are independent; run 0 first either way)
--   0. SECTION 0: read-only. Confirms every premise below still holds.
--   1. SECTION 1: close out the tournament. Events first, then the parent.
--   2. SECTION 2: put the three moved ratings back to the ladder floor.
--   3. SECTION 3: OPTIONAL. Unrate the season's matches. Read its caveat;
--                  it does less than it sounds like it does.
--   4. SECTION 4: read-only. Verify.
--
-- Sections 1-3 are each one transaction and each is safe to re-run: every
-- write sets an absolute value, so a second run is a no-op.
--
-- NOT DONE HERE, ON PURPOSE
--   No DELETE. Removing the season would cascade through tournament_event
--   `9273a60d-b441-4439-b83a-9183f1729fcc`, which was draw-locked deliberately
--   on 2026-08-05, and through both of prod's only two club_fees rows. If the
--   test data must actually be gone rather than archived, that is a separate
--   script written against a fresh dump, not an addendum to this one.
-- ============================================================


-- ============================================================
-- SECTION 0: READ ONLY. Run this first and read the output.
-- ============================================================

\echo '--- 0a. the two seasons. Summer 2026 must be active_flag = false ---'
SELECT id, name, start_date, end_date, active_flag
  FROM public.seasons
 ORDER BY start_date;

\echo '--- 0b. the test tournament and its events. Expect status active + one live event ---'
SELECT t.id AS tournament_id, t.status AS tournament_status,
       e.id AS event_id, e.event_type, e.status AS event_status
  FROM public.tournaments t
  LEFT JOIN public.tournament_events e ON e.tournament_id = t.id
 WHERE t.id = 'fbcef4ca-cff2-44e6-9021-7b882d8ec03f'
 ORDER BY e.event_type;

\echo '--- 0c. rating movement is fully accounted for. Expect 6 and 6 ---'
SELECT (SELECT sum(singles_matches_played) FROM public.ratings) AS sum_singles_played,
       (SELECT sum(doubles_matches_played) FROM public.ratings) AS sum_doubles_played,
       (SELECT count(*) FROM public.match_participants)         AS participant_rows;

\echo '--- 0d. the three rows SECTION 2 will rewrite. skill_tier must be NULL on all three ---'
\echo '---     (a NULL tier is why the floor is 400 and not 800/1200) ---'
SELECT r.player_id, p.full_name, p.skill_tier,
       r.singles_elo, r.doubles_elo,
       r.singles_matches_played, r.doubles_matches_played
  FROM public.ratings r
  JOIN public.players p ON p.id = r.player_id
 WHERE r.player_id IN (
   'ee871221-4fa7-4083-a156-a0d0e9a3d4aa',
   'ba250ca7-a097-4a3a-a499-715380eccadf',
   'c0bced90-4a39-4e8b-b1b5-ae8a75bdb517'
 )
 ORDER BY r.singles_elo DESC;

\echo '--- 0e. every OTHER rating row, which must be left alone. Expect 400/800/1200 seeds only ---'
SELECT p.full_name, p.skill_tier, r.singles_elo, r.doubles_elo
  FROM public.ratings r
  JOIN public.players p ON p.id = r.player_id
 WHERE r.player_id NOT IN (
   'ee871221-4fa7-4083-a156-a0d0e9a3d4aa',
   'ba250ca7-a097-4a3a-a499-715380eccadf',
   'c0bced90-4a39-4e8b-b1b5-ae8a75bdb517'
 )
 ORDER BY r.singles_elo DESC, p.full_name;

\echo '--- 0f. the ladder floor, read from settings rather than assumed ---'
SELECT value -> 'default_elo' AS default_elo,
       value -> 'tier_beginner_elo' AS tier_beginner,
       value -> 'tier_intermediate_elo' AS tier_intermediate,
       value -> 'tier_advanced_elo' AS tier_advanced
  FROM public.platform_settings
 WHERE key = 'rating_defaults';


-- ============================================================
-- SECTION 1: close out the test tournament.
--
-- EVENTS FIRST, then the parent. Not cosmetic ordering: the reverse leaves a
-- window where a `completed` tournament sits over a `live` event, which is the
-- exact state the comment at actions/tournaments.ts:299-302 was written about
-- ("Closing the parent row over the top of a live event is what left events
-- showing as 'Live' on a completed tournament").
--
-- `archived`, NOT `completed`. Completed publishes the tournament as a real
-- result with standings, and 5 of its 9 entrants have no `final_position`.
-- Archived is the "it is over, do not show it" state, which is what test data
-- wants. There is no 'closed' member of the tournament_status enum. The four
-- values are draft, active, completed, archived.
--
-- WHY NOT THE CONSOLE: completeTournamentWithEvents runs
-- loadEventCompletionBlockers first and will refuse, correctly, because the
-- womens_singles event has 7 matches with only 4 played. Doing it in SQL is
-- deliberately going around a guard that is right about real tournaments and
-- wrong about this one.
--
-- SAFE: no trigger on either table recomputes anything. The only trigger is
-- set_updated_at. And discord_tournament_events has 0 rows on prod, so nothing
-- can announce or cancel a Discord event off the back of this.
-- ============================================================

BEGIN;

-- The draw-locked live event. Setting it completed does NOT unlock the draw and
-- must not be followed by an unlock: it was locked deliberately on 2026-08-05.
UPDATE public.tournament_events
   SET status = 'completed'
 WHERE id = '9273a60d-b441-4439-b83a-9183f1729fcc';
-- Expect: UPDATE 1
-- (The other two events, 554f9fa9… and 96dc2ef6…, are already completed.)

-- Only now the parent, with the live event already closed underneath it.
UPDATE public.tournaments
   SET status = 'archived'
 WHERE id = 'fbcef4ca-cff2-44e6-9021-7b882d8ec03f';
-- Expect: UPDATE 1

COMMIT;


-- ============================================================
-- SECTION 2: put the three moved ratings back on the ladder floor.
--
-- 400 rather than a tier seed because all three carry skill_tier = NULL: they
-- were never tier-seeded, so there is no higher band to return them to. The
-- five members sitting at 800/800 and 1200/1200 ARE tier seeds and this
-- statement must not touch them, which is why it names three ids rather than
-- filtering on a rating value.
--
-- WHY NOT activate_season('full'): it rewrites EVERY row in `ratings` to
-- default_elo (00068:99-106), flattening those 800/1200 seeds, and nothing
-- re-seeds them: the tier is applied once at onboarding and
-- onboarding_completed is never set twice. It would also snapshot the current
-- inflated values into season_final_ratings on the way past. Wrong instrument
-- for three rows.
--
-- DURABLE: no Elo replay path exists. The only recompute functions on prod are
-- recompute_head_to_head_pair, recompute_partnership_pair and
-- recompute_player_stats, and none of the three writes `ratings` (checked
-- against pg_proc.prosrc, 2026-09-09). Nothing will put these numbers back.
--
-- This also clears Aditya's doubles_elo of 1500, which is UNEXPLAINED: it sits
-- on 0 doubles matches, is not a tier seed, and audit_logs holds no manual
-- rating edit anywhere (the only rating entries are 7 self_rating_seeded rows).
-- 1500 is the stale MAX_ELO code constant, which is suggestive, not proof.
-- ============================================================

BEGIN;

UPDATE public.ratings
   SET singles_elo             = 400,
       doubles_elo             = 400,
       singles_provisional     = TRUE,
       doubles_provisional     = TRUE,
       singles_matches_played  = 0,
       doubles_matches_played  = 0,
       updated_at              = NOW()
 WHERE player_id IN (
   'ee871221-4fa7-4083-a156-a0d0e9a3d4aa',  -- Aditya Kulkarni   1423 / 1500
   'ba250ca7-a097-4a3a-a499-715380eccadf',  -- Matthew Cheng     1235 / 400
   'c0bced90-4a39-4e8b-b1b5-ae8a75bdb517'   -- wui KI Cheng      1217 / 400
 );
-- Expect: UPDATE 3

COMMIT;


-- ============================================================
-- SECTION 3: OPTIONAL. Unrate the test season's matches.
--
-- READ THIS BEFORE RUNNING IT. It does less than the name suggests.
--
-- WHAT IT DOES: drops the three matches out of anything that filters on
-- rated_flag: rated match lists and the rated-challenge history.
--
-- WHAT IT DOES NOT DO: it does not remove them from head-to-head records,
-- partnership records or player stats. All three recompute functions derive
-- from the match rows existing at all and ignore rated_flag entirely (checked
-- against pg_proc.prosrc, 2026-09-09). So the three results stay visible as
-- history whether this runs or not. Only a DELETE would change that, and this
-- script deliberately does not delete. See the header.
--
-- It is therefore a labelling fix, not a cleanup. Run it if you want the test
-- results to stop counting as rated play; skip it if you would rather leave the
-- season's history untouched now that its ratings are reset.
-- ============================================================

BEGIN;

UPDATE public.matches
   SET rated_flag = FALSE
 WHERE season_id = '15af1db0-ac97-499d-b583-98082a921368';
-- Expect: UPDATE 3

COMMIT;


-- ============================================================
-- SECTION 4: READ ONLY. Verify.
-- ============================================================

\echo '--- 4a. tournament archived, no event left live ---'
SELECT t.status AS tournament_status,
       e.event_type, e.status AS event_status
  FROM public.tournaments t
  LEFT JOIN public.tournament_events e ON e.tournament_id = t.id
 WHERE t.id = 'fbcef4ca-cff2-44e6-9021-7b882d8ec03f'
 ORDER BY e.event_type;

\echo '--- 4b. no active tournament remains anywhere. Expect 0 rows ---'
SELECT id, name, status FROM public.tournaments WHERE status = 'active';

\echo '--- 4c. every rating is a seed again. Expect only 400 / 800 / 1200 ---'
SELECT r.singles_elo, r.doubles_elo, count(*) AS players
  FROM public.ratings r
 GROUP BY 1, 2
 ORDER BY 1 DESC, 2 DESC;

\echo '--- 4d. nothing off-seed left. Expect 0 rows ---'
SELECT p.full_name, r.singles_elo, r.doubles_elo
  FROM public.ratings r
  JOIN public.players p ON p.id = r.player_id
 WHERE r.singles_elo NOT IN (400, 800, 1200)
    OR r.doubles_elo NOT IN (400, 800, 1200);

\echo '--- 4e. match counters cleared. Expect 0 and 0 ---'
SELECT sum(singles_matches_played) AS sum_singles,
       sum(doubles_matches_played) AS sum_doubles
  FROM public.ratings;
