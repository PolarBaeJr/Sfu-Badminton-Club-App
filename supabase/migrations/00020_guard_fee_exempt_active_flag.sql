-- ============================================================
-- 00020 - Extend the player privileged-column guard (audit fees #1)
-- ============================================================
-- 00018's guard_player_privileged_columns blocked role/status/is_banned/
-- is_exec/eligibility_flag but MISSED fee_exempt (a player could self-set
-- fee_exempt=true and owe $0, silently dropping off the admin fee-collection
-- list) and active_flag. Add both. Idempotent CREATE OR REPLACE.
-- ============================================================
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
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
