-- ============================================================================
-- WIPE THE SUMMER 2026 TEST DATA FROM PRODUCTION
--
-- Owner-run. Read every section before running any of it.
--
-- WHAT THIS IS FOR
-- Summer 2026 was retired on 2026-09-10 (retire-summer-2026-test-season.sql):
-- the tournament was archived, the three inflated ratings were re-seeded and
-- every counter on `ratings` was zeroed. That script deliberately deleted
-- nothing, so the rows are all still there and members can still see them:
--
--   - Tournament Pts ladder shows Matthew Cheng on 200 (2 x 100 placement)
--   - Challenges > Archived shows 6 test challenges
--   - A member's PAST RESULTS shows "Test Competition 1" at +95 and +91
--   - "YOU ARE IN - Test Competition 1, FRI 24 JUL, WOMEN'S SINGLES, Seed 3"
--   - my-stats > Recent matches shows the 3 test matches
--
-- All five are the same root cause. This deletes the rows.
--
-- ============================================================================
-- DO NOT USE void_club_match HERE. THIS IS THE EXCEPTION TO THAT RULE.
-- ============================================================================
-- The standing rule is void first, then delete, because
-- `match_participants.rating_delta` is the only record of what to undo and it
-- CASCADEs away with the match.
--
-- That rule does not apply to these three matches, and following it would
-- CORRUPT prod. The 2026-09-10 retirement already zeroed every counter on
-- `ratings`: all 39 rows sit at a clean skill-tier baseline (400/800/1200,
-- 0 matches played, 0 wins, 0 losses, 0 streak), verified again immediately
-- before this script was written. The stored deltas were never taken back out
-- of `ratings` by anything; the counters were simply overwritten with zeroes.
--
-- `void_club_match` wraps `reverse_match_result`, which SUBTRACTS each stored
-- delta. Run against ratings that never received those deltas, it would push
-- clean baselines to 323, 477 and so on. There is nothing to reverse.
--
-- Section 0 re-checks that premise and RAISES if it no longer holds, so the
-- file cannot delete anything against ratings that have moved since. If it
-- aborts, something has been played and the whole premise needs re-deriving.
--
-- ============================================================================
-- THREE DISCORD MESSAGES WILL BE LEFT BEHIND, AND SQL CANNOT REACH THEM
-- ============================================================================
-- `discord_match_posts` has NO foreign key to `matches` (deliberate, 00171),
-- so its rows strand rather than cascade. Section 1 deletes them, but that
-- only removes the database's record of the post: the three messages stay up
-- in Discord channel 1547524991720095766 and have to be deleted by hand.
--
--   1547527062028554241  Matthew Cheng vs Aditya Kulkarni: 21-18
--   1547527063441899631  Matthew Cheng vs wui KI Cheng: 21-20, 21-20, 21-20
--   1547527064238821398  wui KI Cheng vs Matthew Cheng: 21-2, 21-2
--
-- ============================================================================
-- HOW TO RUN
-- ============================================================================
--   ssh pi "docker exec -i supabase-db psql -U postgres -d postgres" < this-file
--
-- Sections 1 to 5 each carry their own BEGIN/COMMIT, so run the file as a
-- whole or paste one section at a time. NEVER with --single-transaction: the
-- explicit COMMITs and the \echo meta-commands both break under it.
--
-- If you paste section by section, do NOT stop before section 5. Section 1
-- destroys the only way to work out who section 5 has to repair.
-- ============================================================================


\set ON_ERROR_STOP on
\pset pager off

\echo ''
\echo '=== SECTION 0: PREMISES. Every one of these must hold. ==='

-- (a) Ratings are clean. Expect: 39 rows, and 0 in every other column.
--     A non-zero anywhere means void_club_match reasoning above is stale.
SELECT count(*) AS rating_rows,
       count(*) FILTER (WHERE singles_matches_played <> 0
                           OR doubles_matches_played <> 0) AS any_played,
       count(*) FILTER (WHERE singles_wins   <> 0 OR singles_losses <> 0
                           OR doubles_wins   <> 0 OR doubles_losses <> 0) AS any_record,
       count(*) FILTER (WHERE current_singles_streak <> 0
                           OR current_doubles_streak <> 0) AS any_streak
FROM ratings;

-- (b) Nothing outside Summer 2026 is in scope. Expect exactly one row:
--     15af1db0 / 3 matches. A Fall 2026 row here means real play has started
--     and the WHERE clauses below need narrowing to the three named ids.
SELECT season_id, count(*) AS matches FROM matches GROUP BY 1;

-- (c) The only tournament on prod is the test one. Expect exactly one row.
SELECT id, name, status FROM tournaments;

-- (d) No live money. Expect 0: club_ledger is what makes a fee irreversible.
SELECT count(*) AS ledger_rows FROM club_ledger;

-- (e) THE GATE. Everything above prints; only this one stops the file.
--     ON_ERROR_STOP catches errors, and a SELECT returning inconvenient
--     numbers is not an error, so without this block psql would print (a)
--     and then commit section 1 regardless of what it said. The ratings
--     premise is the single thing the whole script rests on, so it raises.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ratings
     WHERE singles_matches_played  <> 0 OR doubles_matches_played  <> 0
        OR singles_wins            <> 0 OR singles_losses          <> 0
        OR doubles_wins            <> 0 OR doubles_losses          <> 0
        OR current_singles_streak  <> 0 OR current_doubles_streak  <> 0
  ) THEN
    RAISE EXCEPTION
      'ABORT: ratings counters are not all zero. The void-vs-delete premise '
      'in this script is stale - real play has happened since 2026-09-10. '
      'Re-derive before running any section.';
  END IF;
END $$;


\echo ''
\echo '=== SECTION 1: the three rated challenge matches ==='
BEGIN;

-- First, because it has no FK and would otherwise be left pointing at nothing.
-- The Discord messages themselves survive this; see the header.
DELETE FROM discord_match_posts
 WHERE match_id IN ('8cc1af8c-694c-4493-983f-6d6bac109c73',
                    'fbab74ef-d11f-4a92-bda0-30e38d5944d8',
                    'e1931dd0-c09a-4da9-91a1-d4cbda8564bb');

-- CASCADEs match_participants (6), match_games (6), disputes (2),
-- match_admin_notes (0). walkovers.match_id is SET NULL but walkovers is
-- empty, so nothing is stranded there.
DELETE FROM matches
 WHERE id IN ('8cc1af8c-694c-4493-983f-6d6bac109c73',
              'fbab74ef-d11f-4a92-bda0-30e38d5944d8',
              'e1931dd0-c09a-4da9-91a1-d4cbda8564bb');

-- Expect 0, 0, 0, 0.
SELECT (SELECT count(*) FROM matches)             AS matches,
       (SELECT count(*) FROM match_participants)  AS participants,
       (SELECT count(*) FROM match_games)         AS games,
       (SELECT count(*) FROM disputes)            AS disputes;
COMMIT;


\echo ''
\echo '=== SECTION 2: the six test challenges ==='
BEGIN;

-- All six: 3 completed, 1 cancelled, 1 rejected, 1 expired. CASCADEs
-- challenge_participants (14). matches.challenge_id is SET NULL, but section 1
-- already removed every match, so there is nothing left to null out.
DELETE FROM challenges
 WHERE id IN ('0af0461d-492b-4571-a210-32808c1830ba',
              'de4b4b71-08af-47f6-93f6-57a906f83734',
              'eb17fca0-3788-451c-9d12-c29743cd3a24',
              '96a8f724-04cc-4551-8f0a-7df57c2107ea',
              'f0bd4f64-09b2-43cb-afae-70702a3d9b90',
              'a594e405-35a6-4615-b846-ff2cdb6456a1');

-- Expect 0, 0.
SELECT (SELECT count(*) FROM challenges)             AS challenges,
       (SELECT count(*) FROM challenge_participants) AS participants;
COMMIT;


\echo ''
\echo '=== SECTION 3: Test Competition 1 ==='
BEGIN;

-- Bottom-up rather than one cascading DELETE. tournament_matches points at
-- tournament_participants through four FKs with no ON DELETE clause, which in
-- Postgres is NO ACTION: checked at the END of the statement, so a single
-- cascading delete would in fact pass. Doing it explicitly means a mistake
-- fails on the row that is actually wrong instead of somewhere up the tree.
DELETE FROM tournament_matches
 WHERE event_id IN ('554f9fa9-1807-4f4e-b492-fb4b88b132e0',
                    '96dc2ef6-4e99-4234-ae16-7bc861a30576',
                    '9273a60d-b441-4439-b83a-9183f1729fcc');

-- The 9 entries. This is what Image 17's "YOU ARE IN ... Seed 3" reads from,
-- and what the Tournament Pts ladder sums (2 x 100 for Matthew Cheng).
DELETE FROM tournament_participants
 WHERE event_id IN ('554f9fa9-1807-4f4e-b492-fb4b88b132e0',
                    '96dc2ef6-4e99-4234-ae16-7bc861a30576',
                    '9273a60d-b441-4439-b83a-9183f1729fcc');

-- The three events. Takes tournament_bonus_grants (2) with them.
DELETE FROM tournament_events
 WHERE tournament_id = 'fbcef4ca-cff2-44e6-9021-7b882d8ec03f';

-- The tournament. CASCADEs, and all of this is test data:
--   tournament_fee_tiers        2
--   tournament_checkin_tokens   1
--   feedback_reports            1  (tournament_feedback, rating 5, "abc abc")
--   club_fees                   1  (Aditya Kulkarni, tournament, $15.00, NEVER PAID)
-- tournament_audit_log (26 rows) is SET NULL and survives as an orphaned trail.
--
-- THE $15 FEE IS THE ONE THING HERE THAT IS ABOUT MONEY. It has paid_at NULL
-- and club_ledger is empty, so nothing was ever collected or recorded against
-- it and deleting it writes off nothing real. If that is not how the owner
-- wants it handled, stop here and settle the fee first.
DELETE FROM tournaments WHERE id = 'fbcef4ca-cff2-44e6-9021-7b882d8ec03f';

-- Expect 0 everywhere except audit_orphaned, which should read 26.
SELECT (SELECT count(*) FROM tournaments)                AS tournaments,
       (SELECT count(*) FROM tournament_events)          AS events,
       (SELECT count(*) FROM tournament_participants)    AS participants,
       (SELECT count(*) FROM tournament_matches)         AS tmatches,
       (SELECT count(*) FROM tournament_bonus_grants)    AS grants,
       (SELECT count(*) FROM tournament_fee_tiers)       AS tiers,
       (SELECT count(*) FROM tournament_checkin_tokens)  AS tokens,
       (SELECT count(*) FROM feedback_reports WHERE tournament_id IS NOT NULL) AS tfeedback,
       (SELECT count(*) FROM club_fees WHERE tournament_id IS NOT NULL)        AS tfees,
       (SELECT count(*) FROM tournament_audit_log WHERE tournament_id IS NULL) AS audit_orphaned;
COMMIT;


\echo ''
\echo '=== SECTION 4: archived season ratings ==='
\echo '--- Read this section before running it: the 7 Fall 2026 rows are a'
\echo '--- separate problem from the wipe and deleting them is a judgement call.'
BEGIN;

-- (a) The 14 Summer 2026 rows. Straightforwardly test data: this is what a
--     past-season leaderboard for Summer 2026 would draw.
DELETE FROM season_final_ratings
 WHERE season_id = '15af1db0-ac97-499d-b583-98082a921368';

-- (b) The 7 rows stamped against FALL 2026, the season that is ACTIVE RIGHT
--     NOW, all archived 2026-08-07 - three and a half weeks BEFORE Fall 2026
--     started on 2026-09-01. They carry the pre-retirement inflated numbers
--     (wui KI Cheng 1217, Aditya Kulkarni 1423/1500, Matthew Cheng 1235), so
--     they were written by a test run of the season-close path against the
--     wrong season, not by anything real.
--
--     They are NOT a rollover hazard. `activate_season` archives the outgoing
--     season with ON CONFLICT (season_id, player_id) DO UPDATE, and there is a
--     unique constraint backing it, so when Fall 2026 actually closes these 7
--     rows are overwritten with the real closing ratings. Nothing breaks and
--     the past-season ladder shipped in 8a4715be comes out correct.
--
--     What they DO break is skill-tier seeding, today. `apply_skill_tier_seed`
--     refuses to seed any player with `NOT EXISTS (SELECT 1 FROM
--     season_final_ratings WHERE player_id = ...)` - the guard that stops a
--     returning member being re-seeded over their history. These 7 players
--     have a fabricated history, so the guard now permanently blocks a tier
--     seed for Steven Sun, Steven, Wui ki Cheng, wui KI Cheng, Aditya
--     Kulkarni, Matthew Cheng and Gloria Gao. That is the reason to delete
--     them, and it is why this is worth doing now rather than at rollover.
DELETE FROM season_final_ratings
 WHERE season_id = 'd0a3f925-12a4-41f2-8a2f-010821676637'
   AND archived_at = '2026-08-07 21:13:45.352024+00';

-- Expect 0 rows.
SELECT season_id, count(*) FROM season_final_ratings GROUP BY 1;
COMMIT;


\echo ''
\echo '=== SECTION 5: derived stats, which hold NO foreign key to matches ==='
-- These two tables are populated by the result-application path and reference
-- `matches` through no constraint at all, so the FK sweep that found the
-- cascades and the strands could not see them. Nothing above touches them and
-- nothing decrements them. Left alone, prod ends up in exactly the shape the
-- Summer 2026 retirement was caught in once already: a page stating a record
-- beside zero matches played.
--
-- RUN THIS IN THE SAME SITTING AS SECTION 1. Once section 1 commits,
-- `match_participants` is gone and WHICH players were affected can no longer
-- be derived. Recorded here so the work survives that:
--
--   reliability_metrics, non-zero today
--     ba250ca7-a097-4a3a-a499-715380eccadf  Matthew Cheng    4 issued, 3 completed
--     c0bced90-4a39-4e8b-b1b5-ae8a75bdb517  wui KI Cheng     1 issued, 2 completed
--     ee871221-4fa7-4083-a156-a0d0e9a3d4aa  Aditya Kulkarni  1 completed
--     f4d388d5-992b-48e2-880d-9d1bedabfc71  Steven Sun       1 issued, 1 expired
--
--   head_to_head_stats, both rows
--     ba250ca7 vs c0bced90  singles  2 matches, 1-1, 67-102
--     ba250ca7 vs ee871221  singles  1 match,   1-0, 21-18
--
-- partnership_stats is already empty (0 rows): all three matches were singles.
BEGIN;

-- Deleted, not zeroed. `recompute_player_stats(uuid)` (00123) is the supported
-- repair and would work here, but it zeroes the row in place and leaves a
-- 0-match pair behind. Every match on prod is test data, so an EMPTY table is
-- the honest end state, and it is what a pair that never played looks like.
DELETE FROM head_to_head_stats
 WHERE (player_a_id, player_b_id) IN (
         ('ba250ca7-a097-4a3a-a499-715380eccadf', 'c0bced90-4a39-4e8b-b1b5-ae8a75bdb517'),
         ('ba250ca7-a097-4a3a-a499-715380eccadf', 'ee871221-4fa7-4083-a156-a0d0e9a3d4aa')
       );

-- Zeroed, not deleted: a member is expected to have a reliability row, and the
-- other columns are session-derived rather than match-derived. Verified
-- 2026-09-19 that no_shows, late_cancellations, early_withdrawals,
-- walkovers_received, dispute_involvement_count, avg_confirmation_minutes and
-- walkover_flag are zero/false on all 37 rows, so this clears only what the
-- 6 test challenges and 3 test matches put there. NOT touching `no_shows`
-- also keeps the check_noshow_threshold trigger out of it.
UPDATE reliability_metrics
   SET challenges_issued   = 0,
       challenges_accepted = 0,
       challenges_rejected = 0,
       challenges_expired  = 0,
       matches_completed   = 0,
       updated_at          = NOW()
 WHERE challenges_issued <> 0 OR challenges_accepted <> 0
    OR challenges_rejected <> 0 OR challenges_expired <> 0
    OR matches_completed <> 0;

-- Expect 0 and 0.
SELECT (SELECT count(*) FROM head_to_head_stats) AS h2h_rows_left,
       (SELECT count(*) FROM reliability_metrics
         WHERE challenges_issued <> 0 OR challenges_accepted <> 0
            OR challenges_rejected <> 0 OR challenges_expired <> 0
            OR matches_completed <> 0) AS reliability_rows_left;
COMMIT;


\echo ''
\echo '=== DELIBERATELY NOT DELETED ==='
\echo ''
\echo '1. The Summer 2026 season row itself (15af1db0). hidden_flag = true, so'
\echo '   members never see it, and deleting it would SET NULL on club_fees and'
\echo '   sessions that point at it. Owner call, not a cleanup.'
\echo ''
\echo '2. club_fees fd2ca7b3: Aditya Kulkarni, dues, $100.00, paid_at NULL,'
\echo '   season Summer 2026. Not tournament-linked, so nothing above touches'
\echo '   it, and it is a dues record rather than test scaffolding. If Summer'
\echo '   2026 never happened then neither did this charge: owner call.'
\echo ''
\echo '3. feedback_reports 9e14d85e ("somethign else", kind other, no'
\echo '   tournament). Looks like a test submission but is not tied to any of'
\echo '   the above, so it is left alone.'
\echo ''
\echo '4. tournament_audit_log: 26 rows, SET NULL, now orphaned. It is an audit'
\echo '   trail; deleting it is the opposite of what it is for.'
\echo ''
\echo '5. The three Discord messages. See the header - delete by hand.'
\echo ''
