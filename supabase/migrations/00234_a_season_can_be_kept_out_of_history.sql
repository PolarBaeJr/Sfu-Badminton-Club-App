-- ============================================================
-- 00234 A SEASON CAN BE KEPT OUT OF HISTORY
--
-- WHAT IS ADDED: one column, `seasons.hidden_flag`, plus the one row that
-- needs it set today.
--
-- WHY IT EXISTS. The leaderboard is gaining a past-season view: pick a
-- finished season and read its final standings out of `season_final_ratings`.
-- That archive is written at rollover by activate_season() and nothing has
-- ever read it back publicly, so nobody has had to ask whether every row in it
-- is fit to publish. One is not.
--
-- Summer 2026 (15af1db0-ac97-499d-b583-98082a921368) was a TEST season. It was
-- retired on prod on 2026-09-10, which reset the LIVE `ratings` table back to
-- seed values. It did not touch `season_final_ratings`, because at the time
-- nothing read that table and the omission cost nothing. The archive therefore
-- still holds the ratings the test challenges moved. Publishing a "final
-- standings" table for a season the club says never happened, populated with
-- numbers that were deliberately reset everywhere else, is the single worst
-- thing the new view could do on its first day.
--
-- WHY A FLAG AND NOT A DELETE. Deleting the archive rows would also work and
-- was the other candidate. A flag was chosen because the rows are the only
-- surviving record that the test season was played at all, and a DELETE is not
-- reversible if that record is ever wanted for an audit. It also generalises:
-- the next season that should not be published is a one-row UPDATE rather than
-- another irreversible cleanup. The cost is that every reader has to honour the
-- flag, which is the usual cost of soft deletion and is bounded here because
-- the set of readers is small and named below.
--
-- WHAT THE FLAG DOES AND DOES NOT MEAN. It is a PUBLICATION decision about
-- club history and nothing else:
--
--   * It hides the season from the season pickers and from any past-season
--     view, on the player app's leaderboard and on /my-stats.
--   * It does NOT deactivate the season, end it, or change a fee. `active_flag`
--     remains the one answer to "which season is now".
--   * It does NOT hide the season from the ADMIN console. An exec who cannot
--     see a hidden season cannot unhide it, and a flag with no way back is a
--     trap. The console lists every season and shows the flag's state.
--   * It does NOT filter `sessions`, `fees` or any financial report. Those
--     reference a season as a foreign key for accounting, and money that
--     changed hands is not unpublished by a display flag. Anything that
--     filtered them on this column would quietly lose real rows.
--
-- WHO CAN SET IT. No new capability string. The admin action reuses
-- `seasons.end.write`, the key that already governs closing a season off, so
-- this file touches none of the three permission-vocabulary CHECKs that 00232
-- last moved. A distinct `seasons.hide.write` was considered and rejected:
-- the population that closes a season is exactly the population that should
-- decide whether it is published, and a fourth key for a rare toggle is
-- vocabulary nobody would remember to grant.
--
-- NO GRANT CHANGES. `seasons` had every privilege revoked from PUBLIC and anon
-- by 00128:228, and a new column inherits the table's grants rather than
-- carrying its own. The player app reads this table through the service role,
-- which is unaffected. Nothing here opens a path that was closed.
-- ============================================================

BEGIN;

-- ---- 1. THE COLUMN --------------------------------------------------------
--
-- NOT NULL DEFAULT false, so every existing season stays published and the
-- column can be read with `NOT hidden_flag` without a null case. Applying this
-- before the code ships changes nothing that anyone can see: no reader looks at
-- the column yet, and the only row set below is one no current surface renders.

ALTER TABLE public.seasons
  ADD COLUMN IF NOT EXISTS hidden_flag boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.seasons.hidden_flag IS
  'Keeps a season out of the PLAYER-facing season pickers and past-season views (leaderboard history, /my-stats history) without ending it, deactivating it, or deleting its season_final_ratings archive. Never filter sessions, fees or financial reports on this column: it is a publication decision, not an accounting one. The admin console deliberately still lists hidden seasons, because nothing else could unhide them.';

-- ---- 2. THE ONE ROW THAT NEEDS IT TODAY -----------------------------------
--
-- Addressed by id rather than by name or by date range. `seasons_term_year_unique`
-- means a future club could legitimately hold a real "Summer 2026" on another
-- prod, and matching on the name would hide it. The id is the retired test
-- season on THIS deployment and nowhere else; on any database that does not
-- have it, this UPDATE touches zero rows and the migration still succeeds.

UPDATE public.seasons
   SET hidden_flag = true
 WHERE id = '15af1db0-ac97-499d-b583-98082a921368';

COMMIT;
