-- ============================================================
-- 00019_security_hardening.sql
--
-- 1. Pin search_path on every SECURITY DEFINER function so a
--    malicious role cannot hijack unqualified object references
--    via a crafted search_path (CVE-2018-1058 class issue).
--
--    Targets are the SECURITY DEFINER functions from 00003 and
--    00004 that are still SECURITY DEFINER today. Excluded:
--    - apply_match_result(uuid, uuid), reverse_match_result(uuid)
--      and update_head_to_head(uuid): re-created in 00008 with the
--      same signature WITHOUT SECURITY DEFINER, so the definer
--      versions no longer exist.
--    - calculate_elo_update numeric overload: dropped in 00017.
--    - increment_challenges_issued(uuid): 00012 already pins its
--      own search_path.
--
-- 2. Restrict tournament_audit_log reads to admins. The admin app
--    uses the service role (bypasses RLS); nothing player-facing
--    reads this table.
-- ============================================================

BEGIN;

-- ---- 00003_functions.sql definers ----
ALTER FUNCTION is_admin(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION is_admin_or_coach(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION get_player_id(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION apply_walkover_result(uuid, uuid, text) SET search_path = public, pg_temp;
ALTER FUNCTION validate_challenge_creation(uuid, uuid, match_type_enum, uuid, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION check_session_caps(uuid, uuid, match_type_enum) SET search_path = public, pg_temp;
ALTER FUNCTION check_repeat_opponent_caps(uuid, uuid, match_type_enum) SET search_path = public, pg_temp;
ALTER FUNCTION check_doubles_repeat_caps(uuid[], uuid[]) SET search_path = public, pg_temp;
ALTER FUNCTION calculate_season_compression(numeric) SET search_path = public, pg_temp;
ALTER FUNCTION capture_season_snapshot(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION update_partnership_stats(uuid) SET search_path = public, pg_temp;

-- ---- 00004_triggers.sql definers ----
ALTER FUNCTION trigger_init_player_records() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_match_confirmed() SET search_path = public, pg_temp;
ALTER FUNCTION trigger_check_noshow_threshold() SET search_path = public, pg_temp;

-- ---- tournament_audit_log: admin-only reads ----
DROP POLICY IF EXISTS "Public read tournament_audit_log" ON tournament_audit_log;
CREATE POLICY "Admin read tournament_audit_log" ON tournament_audit_log
  FOR SELECT USING (is_admin(auth.uid()));

COMMIT;
