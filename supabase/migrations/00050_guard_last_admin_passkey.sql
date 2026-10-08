-- ============================================================
-- 00050_guard_last_admin_passkey.sql — never allow zero admins
-- who can actually get in
--
-- Every door into the admin console (Google, magic link, and now
-- passkey sign-in) funnels through the same admin-or-exec check.
-- Nothing anywhere counts what is left before taking a door away,
-- so all of these silently produce a console nobody can reach:
--
--   * demoting the last admin
--   * deleting the last admin's last passkey
--   * deleting that admin's row outright
--
-- Recovery from any of them is a manual UPDATE against the
-- production database, which is exactly the situation this repo
-- keeps trying not to be in.
--
-- Enforced with triggers rather than in the server actions
-- because both passkey delete paths (admin settings and
-- apps/player/src/lib/actions/passkeys.ts) use the SERVICE ROLE
-- and bypass RLS entirely. A check in application code is a
-- suggestion; this is the guarantee.
--
-- State when written: 2 admins, 4 execs, 2 passkeys total, and
-- exactly ONE admin holding a passkey. The invariant is live but
-- has no margin, so it is worth holding from here.
-- ============================================================

-- Counts admins who hold at least one passkey, optionally pretending a
-- credential or a player is already gone. SECURITY DEFINER so it sees every
-- row regardless of who triggered the write.
CREATE OR REPLACE FUNCTION admins_with_passkeys(
  p_excluding_credential UUID DEFAULT NULL,
  p_excluding_player UUID DEFAULT NULL
)
RETURNS INTEGER AS $$
  SELECT COUNT(DISTINCT p.id)::INTEGER
  FROM players p
  JOIN passkey_credentials pc ON pc.player_id = p.id
  WHERE p.role = 'admin'
    AND (p_excluding_credential IS NULL OR pc.id <> p_excluding_credential)
    AND (p_excluding_player IS NULL OR p.id <> p_excluding_player);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION admins_with_passkeys(UUID, UUID) IS
  'Number of role=admin players holding at least one passkey, optionally excluding a credential or player about to be removed.';

-- ============================================================
-- Removing a passkey
-- ============================================================

CREATE OR REPLACE FUNCTION guard_last_admin_passkey_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Only the last credential of the last passkey-holding admin is protected.
  -- Enrol the replacement first and this never fires, which is the order you
  -- want anyway when moving to a new phone.
  IF admins_with_passkeys(p_excluding_credential => OLD.id) = 0
     AND EXISTS (SELECT 1 FROM players WHERE id = OLD.player_id AND role = 'admin')
  THEN
    RAISE EXCEPTION 'This is the only passkey belonging to an admin. Enrol another passkey first, or the admin console becomes unreachable.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_guard_last_admin_passkey ON passkey_credentials;
CREATE TRIGGER trg_guard_last_admin_passkey
  BEFORE DELETE ON passkey_credentials
  FOR EACH ROW EXECUTE FUNCTION guard_last_admin_passkey_delete();

-- ============================================================
-- Demoting, or deleting, that admin
-- ============================================================

CREATE OR REPLACE FUNCTION guard_last_admin_role()
RETURNS TRIGGER AS $$
BEGIN
  -- Demotion. Unchanged roles fall straight through, so ordinary profile
  -- updates on an admin are unaffected.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.role = 'admin' AND NEW.role IS DISTINCT FROM 'admin'
       AND admins_with_passkeys(p_excluding_player => OLD.id) = 0
    THEN
      RAISE EXCEPTION 'This is the only admin with a passkey. Give another admin a passkey before demoting this one.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Deletion. The cascade to passkey_credentials would otherwise trip the
  -- delete guard above with a message about credentials, which is a confusing
  -- way to be told you are removing your own last way in.
  IF OLD.role = 'admin' AND admins_with_passkeys(p_excluding_player => OLD.id) = 0 THEN
    RAISE EXCEPTION 'This is the only admin with a passkey. Give another admin a passkey before deleting this account.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_guard_last_admin_role ON players;
CREATE TRIGGER trg_guard_last_admin_role
  BEFORE UPDATE OR DELETE ON players
  FOR EACH ROW EXECUTE FUNCTION guard_last_admin_role();

-- Deliberately NOT guarded: is_exec. Execs reach the console too, but the
-- request was for an admin account specifically, and role=admin is the
-- stricter invariant — holding it means the console stays reachable no matter
-- what happens to the exec list.
