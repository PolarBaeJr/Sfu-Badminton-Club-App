-- ============================================================================
-- 00023_players_deleted_at.sql
-- Adds players.deleted_at for the Phase 4.5 self-delete anonymization
-- pattern. The auth.users row is hard-deleted via the admin API; the
-- players row is soft-deleted (display_name → 'Deleted Player', PII
-- nulled, deleted_at = NOW()) so opponent match history stays intact.
--
-- Existing leaderboard / search / challenge code does not yet exclude
-- soft-deleted players. Phase 5+ will add `deleted_at IS NULL` filters
-- where they matter; for now the column is just NULL for everyone.
-- ============================================================================

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.players.deleted_at IS
  'Set when a player self-deletes their account. Row stays so foreign-key references in matches/challenges/ratings hold; display name and PII are anonymized in the same UPDATE.';

-- Partial index — every active-player query (leaderboard, search,
-- challenge suggestions, etc.) will filter WHERE deleted_at IS NULL once
-- migrated.
CREATE INDEX IF NOT EXISTS players_active_idx
  ON public.players(id)
  WHERE deleted_at IS NULL;
