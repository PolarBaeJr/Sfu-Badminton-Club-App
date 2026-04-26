-- ============================================================
-- 00018_matches_update_column_guard.sql
--
-- Close the remaining gap from the 2026-04-08 vibe-security audit:
-- matches_update (00005 / 00016) allows any match participant to UPDATE
-- the matches row. The only legitimate participant-side write is the
-- dispute flow (apps/player/src/lib/actions.ts :: disputeMatchResult),
-- which flips result_status -> 'disputed'. A malicious participant could
-- otherwise flip status, winner_side, score_summary, submitted_by, etc.
--
-- Strategy: keep the permissive RLS USING/WITH CHECK so the dispute path
-- still works, but add a BEFORE UPDATE trigger that only lets participants
-- (who are not the submitter/admin/service_role) change result_status,
-- and only to 'disputed'. All other column mutations by a non-privileged
-- participant are rejected.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_matches_update_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_player UUID;
  is_submitter  BOOLEAN;
  is_priv       BOOLEAN;
BEGIN
  -- Service role bypasses RLS entirely and is trusted (server actions).
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  caller_player := get_player_id(auth.uid());
  is_priv       := is_admin(auth.uid());
  is_submitter  := (OLD.submitted_by IS NOT NULL AND OLD.submitted_by = caller_player);

  IF is_priv OR is_submitter THEN
    -- Submitter/admin may update the row, but must not reassign ownership.
    IF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by AND NOT is_priv THEN
      RAISE EXCEPTION 'cannot reassign match submitter';
    END IF;
    RETURN NEW;
  END IF;

  -- Non-privileged path: caller must be a participant, and may only
  -- transition result_status to 'disputed'. Everything else is frozen.
  IF NOT EXISTS (
    SELECT 1 FROM match_participants
    WHERE match_id = OLD.id AND player_id = caller_player
  ) THEN
    RAISE EXCEPTION 'not a match participant';
  END IF;

  IF NEW.result_status IS DISTINCT FROM OLD.result_status
     AND NEW.result_status <> 'disputed' THEN
    RAISE EXCEPTION 'participants may only dispute a match result';
  END IF;

  -- Reject changes to any other user-meaningful column.
  IF NEW.submitted_by      IS DISTINCT FROM OLD.submitted_by      OR
     NEW.winner_side       IS DISTINCT FROM OLD.winner_side       OR
     NEW.score_summary     IS DISTINCT FROM OLD.score_summary     OR
     NEW.match_type        IS DISTINCT FROM OLD.match_type        OR
     NEW.format            IS DISTINCT FROM OLD.format            OR
     NEW.played_at         IS DISTINCT FROM OLD.played_at         OR
     NEW.forfeit_player_id IS DISTINCT FROM OLD.forfeit_player_id THEN
    RAISE EXCEPTION 'participants may only update result_status';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matches_update_scope ON matches;
CREATE TRIGGER matches_update_scope
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION enforce_matches_update_scope();
