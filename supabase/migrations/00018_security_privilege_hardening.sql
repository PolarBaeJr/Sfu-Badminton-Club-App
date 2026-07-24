-- ============================================================
-- 00018 — Security / privilege-escalation hardening
-- ============================================================
-- Closes critical holes found in the full-codebase audit (bug-audit.md).
-- All exploitable by any authenticated user via the plain PostgREST/supabase-js
-- client (no admin UI needed). Apply BEFORE opening the app to real users.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- S1. Any player could set their own role='admin' (or unsuspend / unban /
-- self-promote to exec) because players_update_own (00005_rls.sql:54) scopes
-- the UPDATE by user_id but not by COLUMN. RLS can't do per-column checks, so
-- guard the privileged columns with a trigger. Admins and the service-role
-- client (admin app; no JWT subject -> auth.uid() IS NULL) are unaffected.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_player_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
  -- service-role (no auth.uid()) and admins may change anything
  IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS guard_player_privileged_columns_trg ON players;
CREATE TRIGGER guard_player_privileged_columns_trg
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION guard_player_privileged_columns();

-- ------------------------------------------------------------
-- S2. event_feedback shipped with RLS DISABLED, so any authenticated user
-- could read every member's attributed private feedback and forge/wipe rows.
-- Enable RLS: author can write/read own; admins read all.
-- ------------------------------------------------------------
ALTER TABLE event_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_feedback_select ON event_feedback;
CREATE POLICY event_feedback_select ON event_feedback FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()) OR is_admin(auth.uid()));

DROP POLICY IF EXISTS event_feedback_insert ON event_feedback;
CREATE POLICY event_feedback_insert ON event_feedback FOR INSERT TO authenticated
  WITH CHECK (player_id = get_player_id(auth.uid()));

DROP POLICY IF EXISTS event_feedback_update_own ON event_feedback;
CREATE POLICY event_feedback_update_own ON event_feedback FOR UPDATE TO authenticated
  USING (player_id = get_player_id(auth.uid()))
  WITH CHECK (player_id = get_player_id(auth.uid()));

DROP POLICY IF EXISTS event_feedback_admin ON event_feedback;
CREATE POLICY event_feedback_admin ON event_feedback FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ------------------------------------------------------------
-- M7. season_final_ratings shipped with RLS DISABLED, so any authenticated
-- user could tamper with archived per-season Elo history. Elo is public
-- (read), but writes must be admin/service-role only.
-- ------------------------------------------------------------
ALTER TABLE season_final_ratings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sfr_select ON season_final_ratings;
CREATE POLICY sfr_select ON season_final_ratings FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS sfr_admin ON season_final_ratings;
CREATE POLICY sfr_admin ON season_final_ratings FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ------------------------------------------------------------
-- S3/S4/S5. Admin-only privileged RPCs were left with the default
-- EXECUTE TO PUBLIC (or granted to `authenticated`) and have no in-body
-- is_admin check, so any authenticated user could call them directly:
--   reverse_match_result   -> void any match, reverse everyone's Elo
--   activate_season        -> reset the entire ladder
--   apply_walkover_result  -> forge walkover penalties, auto-suspend a victim
-- They are only ever invoked by the admin service-role client, so restrict
-- execute to service_role.
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION reverse_match_result(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION reverse_match_result(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION activate_season(uuid, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION activate_season(uuid, text, numeric) TO service_role;

REVOKE EXECUTE ON FUNCTION apply_walkover_result(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION apply_walkover_result(uuid, uuid, text) TO service_role;
