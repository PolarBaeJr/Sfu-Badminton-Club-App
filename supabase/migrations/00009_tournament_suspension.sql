-- ============================================================
-- 00009_tournament_suspension.sql — Tournament suspension
--
-- Adds a suspension marker to tournaments. A suspended
-- tournament (suspended_at non-null) pauses registration,
-- check-in, bracket generation, result entry, and finalization
-- at the server-action layer; suspension_reason is shown to
-- admins and players. Resuming nulls both columns.
-- ============================================================

ALTER TABLE tournaments
  ADD COLUMN suspended_at TIMESTAMPTZ,
  ADD COLUMN suspension_reason TEXT;
