-- Two guards the database was relying on the application to enforce.
--
-- A deep review found that several "check then write" sequences in the console
-- have nothing underneath them: two people doing the same thing at the same
-- second both pass the check and both write. The application fixes for those
-- races are worth doing, but they are app-layer and can be got wrong again. A
-- unique index cannot be got wrong — the second writer is refused by Postgres
-- whatever the code believes.
--
-- Both are ADDITIVE and both are already satisfied on production as of
-- 2026-08-08 (1 active season, 0 duplicate draw positions), so they apply
-- without touching a single row. If either CREATE fails, it has found real
-- duplicate data; the SELECTs at the bottom of this file show you what.

-- ============================================================
-- 1. At most one active season
-- ============================================================
--
-- activate_season sets every active_flag false and then sets one true, with no
-- lock. Under READ COMMITTED two concurrent activations can each miss the
-- other's newly-activated row and both commit, leaving two seasons active. The
-- damage is not cosmetic: the active-season lookups use .single()/.maybeSingle(),
-- which then ERROR, and most callers treat that error as "no active season" —
-- so new sessions, tournaments and matches start being stamped season_id = NULL
-- and never appear in a season total again. A full reset running twice from two
-- different snapshots is the worse version.
--
-- Partial, so any number of INACTIVE seasons is still fine.
CREATE UNIQUE INDEX IF NOT EXISTS seasons_single_active_idx
  ON seasons (active_flag)
  WHERE active_flag;

-- ============================================================
-- 2. One match per position in a draw
-- ============================================================
--
-- Bracket generation deletes the existing matches and inserts a freshly built
-- tree over several statements, guarded only by a prior read. Two generators
-- racing can interleave their deletes and inserts and leave either two complete
-- draws in one event or one fragmented hybrid — a bracket that cannot be
-- finalised and cannot be reasoned about.
--
-- is_third_place is excluded because the playoff deliberately shares its
-- round_number with the final; 00080 already has its own partial unique index
-- for that row.
CREATE UNIQUE INDEX IF NOT EXISTS tournament_matches_draw_position_idx
  ON tournament_matches (event_id, round_number, bracket_position)
  WHERE NOT is_third_place;

-- ============================================================
-- If a CREATE above failed, these show what it found
-- ============================================================
-- SELECT id, name, active_flag FROM seasons WHERE active_flag;
--
-- SELECT event_id, round_number, bracket_position, count(*)
--   FROM tournament_matches
--  WHERE NOT is_third_place
--  GROUP BY 1, 2, 3
-- HAVING count(*) > 1;
