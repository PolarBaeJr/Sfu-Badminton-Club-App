-- ============================================================
-- 00012_reliability_helpers.sql
--
-- Atomic increment helper for reliability metrics to avoid
-- read-modify-write race conditions in createChallenge.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION increment_challenges_issued(p_player_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO reliability_metrics (player_id, challenges_issued)
  VALUES (p_player_id, 1)
  ON CONFLICT (player_id)
  DO UPDATE SET
    challenges_issued = reliability_metrics.challenges_issued + 1,
    updated_at = NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION increment_challenges_issued(UUID) TO authenticated;

COMMIT;
