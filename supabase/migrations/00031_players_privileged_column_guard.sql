-- ============================================================
-- 00031_players_privileged_column_guard.sql
--
-- Close C1 from the 2026-06-09 security audit: players_update_own
-- (00005) is USING/WITH CHECK (user_id = auth.uid()) with no column
-- restriction, so any authenticated player could PATCH their own row
-- to role='admin' (opening every is_admin() policy), self-approve via
-- status, un-suspend themselves, or clear deleted_at.
--
-- A WITH CHECK column guard is not expressible in Postgres RLS, so —
-- mirroring 00018's matches guard — a BEFORE UPDATE trigger compares
-- OLD vs NEW and rejects non-privileged changes to the authz- and
-- moderation-bearing columns. players_update_own stays intact so
-- profile edits (avatar_url, display_name, notification_preferences,
-- onboarding fields, last_active_at, …) keep working.
--
-- Guarded columns, from the full players schema (00001 + 00021 + 00023):
--   role             — drives is_admin()/is_admin_or_coach() (authz)
--   status           — approval / suspension / competitive eligibility
--   deleted_at       — soft-delete marker (legit self-delete path runs
--                      via the service-role client and bypasses below)
--   eligibility_flag — competitive eligibility (moderation)
--   active_flag      — admin activity moderation
-- Reviewed and deliberately NOT guarded: user_id (pinned to self by
-- players_update_own WITH CHECK), profile_visibility /
-- hide_from_leaderboard / show_activity_status (user privacy prefs),
-- email / phone / sfu_student_id / skill_level / format_preference /
-- goal / full_name / display_name / bio / avatar_url /
-- onboarding_completed / notification_preferences (self-service profile
-- and onboarding data), timestamps (cosmetic).
--
-- INSERT needs no guard: there is no players INSERT policy for
-- non-admin authenticated users (onboarding inserts via service role).
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_players_update_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Service role bypasses RLS entirely and is trusted (server actions,
  -- including the deleteAccount soft-delete which sets deleted_at).
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Direct DB connections (migrations, psql maintenance) carry no JWT;
  -- any such role already bypasses or supersedes RLS.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.role             IS DISTINCT FROM OLD.role             OR
     NEW.status           IS DISTINCT FROM OLD.status           OR
     NEW.deleted_at       IS DISTINCT FROM OLD.deleted_at       OR
     NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag OR
     NEW.active_flag      IS DISTINCT FROM OLD.active_flag      THEN
    RAISE EXCEPTION 'players may not change privileged columns (role, status, deleted_at, eligibility_flag, active_flag)';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS players_update_scope ON players;
CREATE TRIGGER players_update_scope
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION enforce_players_update_scope();
