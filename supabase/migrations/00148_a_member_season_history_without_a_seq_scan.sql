-- ============================================================
-- 00148_a_member_season_history_without_a_seq_scan.sql
-- ============================================================
-- SAFE TO APPLY AT ANY TIME. One index, no data touched, no policy, no
-- function. Nothing in the app changes behaviour either way.
--
-- `season_final_ratings` carries two indexes: `_pkey (id)` and
-- `season_final_ratings_season_id_player_id_key (season_id, player_id)`. A
-- query filtering on `player_id` ALONE cannot use the composite, because
-- `season_id` leads it — so "this member's past-season ratings", which is the
-- read the profile and my-stats paths make, is a sequential scan.
--
-- HOW BIG A DEAL THIS IS, HONESTLY: none, today. The table holds 14 rows on
-- production. It grows as members × semesters — 500 × 6 ≈ 3,000 — so this is a
-- cheap thing to have in place before it matters rather than a fix for
-- something anyone is feeling. It is the ONLY index the performance audit
-- proposed, and it deliberately did not propose one for the leaderboard, whose
-- sequential plan is the optimal one and should be left alone.
--
-- ------------------------------------------------------------
-- WHY NOT CONCURRENTLY
-- ------------------------------------------------------------
-- The audit's draft said CREATE INDEX CONCURRENTLY, with a note that it cannot
-- run inside a transaction block. That note is the whole reason it is not used
-- here. CONCURRENTLY exists to avoid holding an ACCESS EXCLUSIVE lock while a
-- large table is scanned; this table has 14 rows, so the lock lasts for
-- microseconds and buys nothing, while the CONCURRENTLY form would make this
-- the one file in the batch that must not be pasted into a transaction — a
-- footgun with no benefit attached. If this table is ever large enough for the
-- lock to matter, build the index CONCURRENTLY by hand at that point.
-- ============================================================

BEGIN;

CREATE INDEX IF NOT EXISTS season_final_ratings_player_idx
  ON public.season_final_ratings (player_id);

COMMENT ON INDEX public.season_final_ratings_player_idx IS
  'Serves the per-player season-history read on the profile / my-stats path. The composite season_final_ratings_season_id_player_id_key cannot serve it because season_id leads.';

COMMIT;

-- ============================================================
-- VERIFY
-- ============================================================
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'season_final_ratings' ORDER BY 1;
--
-- And that the planner actually reaches for it — on 14 rows it will NOT, and
-- that is correct rather than a failure. Postgres prefers a seq scan on a table
-- this small; the index earns its keep at a few hundred rows. If you want to
-- see it chosen today:
--
--   SET enable_seqscan = off;
--   EXPLAIN SELECT * FROM season_final_ratings WHERE player_id = '<some uuid>';
--   RESET enable_seqscan;
