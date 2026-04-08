-- ============================================================
-- 00017_security_hardening.sql
-- Additional defense-in-depth from the CLAUDE-SECURITY.md audit:
--   * Immutable audit_logs (no UPDATE/DELETE by anyone except via service role)
--   * Unique (match_id, player_id) on match_participants (H4 — prevents a
--     submitter from inserting the same player twice in one match)
--   * search_path pinned on SECURITY DEFINER functions (M2 — defeats
--     schema-hijack via malicious search_path)
-- ============================================================

-- ---------- AUDIT LOG IMMUTABILITY (C2 / M5) ----------

-- Block UPDATE and DELETE for any role that goes through RLS. Service role
-- bypasses RLS so migrations/maintenance still work when strictly needed.
DROP POLICY IF EXISTS audit_update_denied ON audit_logs;
CREATE POLICY audit_update_denied ON audit_logs FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS audit_delete_denied ON audit_logs;
CREATE POLICY audit_delete_denied ON audit_logs FOR DELETE TO authenticated
  USING (false);

-- Belt-and-suspenders: a trigger so even a SECURITY DEFINER function with a
-- leaky search_path can't silently mutate audit history.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

-- ---------- DUPLICATE PARTICIPANT GUARD (H4) ----------

-- A player must appear at most once in a given match. The existing RLS policy
-- only checks the submitter — it doesn't prevent the submitter from inserting
-- themselves (or anyone) twice on different team sides.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'match_participants_match_player_uniq'
  ) THEN
    ALTER TABLE match_participants
      ADD CONSTRAINT match_participants_match_player_uniq
      UNIQUE (match_id, player_id);
  END IF;
END $$;

-- ---------- search_path HARDENING FOR SECURITY DEFINER FUNCTIONS (M2) ----------

-- Pin search_path on every SECURITY DEFINER function in public so a caller
-- can't shadow `players`, `ratings`, etc. with a temp/foreign schema.
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT n.nspname AS schema_name,
           p.proname  AS fn_name,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = public, pg_temp',
      fn.schema_name, fn.fn_name, fn.args
    );
  END LOOP;
END $$;
