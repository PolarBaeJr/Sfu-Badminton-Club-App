-- ============================================================
-- 00017_dedupe_elo_functions.sql
-- Migration 00003 created `calculate_elo_update(integer, integer, integer,
-- numeric, numeric, numeric, numeric)` (with `p_actual` and an override).
-- Migration 00008 created a different overload `calculate_elo_update(integer,
-- integer, integer, numeric, numeric, boolean)` (with `p_won`) and rewrote
-- `apply_match_result` to call that overload.
--
-- Both overloads coexist in the live DB. The boolean variant from 00008 is the
-- canonical one (and the only one called from `apply_match_result`); the numeric
-- variant from 00003 is dead code and risks confusion if anyone calls
-- `calculate_elo_update` with positional NUMERICs.
--
-- Drop the dead numeric overload. Use IF EXISTS so the migration is idempotent
-- and tolerates fresh installs that may eventually skip 00003's overload.
-- ============================================================

DROP FUNCTION IF EXISTS calculate_elo_update(
  integer, integer, integer, numeric, numeric, numeric, numeric
);
