-- ============================================================
-- 00057 — the admin console requires good standing
--
-- admin_access_level() answered "what level does this person
-- hold" and nothing else. No ban check, no status check, no
-- active_flag check. So:
--
--   * a BANNED exec kept the console in full. banPlayer writes
--     only players.is_banned, which nothing here read. They lost
--     the members' app and kept the admin app — where
--     reinstatePlayer is exec-level with no check that the
--     target is not the caller, so they could unban themselves
--     and the audit row would name them as the actor.
--   * a SUSPENDED or PENDING_APPROVAL account did the same.
--   * an INACTIVE account did the same.
--
-- The player app's requirePlayer() has rejected all of these
-- since it was written. This is the same rule; it should have
-- been in both places from the start. The matching check now
-- also lives in getAuthenticatedAtLeast(), because the
-- middleware asks this function while server actions ask the
-- TypeScript gate — one rule, and it must not be written twice
-- with different answers again.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_access_level(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ok BOOLEAN;
BEGIN
  -- Standing gate, evaluated once. A row failing this holds no level at all,
  -- rather than holding one the caller has to remember to re-check.
  SELECT EXISTS (
    SELECT 1 FROM players
     WHERE user_id = p_user_id
       AND COALESCE(is_banned, FALSE) = FALSE
       AND status NOT IN ('suspended', 'pending_approval')
       AND COALESCE(active_flag, TRUE) = TRUE
  ) INTO v_ok;

  IF NOT v_ok THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND role = 'admin') THEN
    RETURN 'admin';
  ELSIF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND is_exec = TRUE) THEN
    RETURN 'exec';
  ELSIF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND is_trainer = TRUE) THEN
    RETURN 'trainer';
  ELSE
    RETURN NULL;
  END IF;
END;
$function$;
