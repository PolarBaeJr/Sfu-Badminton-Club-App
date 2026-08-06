-- ============================================================
-- 00056 — SECURITY: close self-INSERT privilege escalation
--
-- Any stranger with a working email address could make
-- themselves a club exec with one HTTP request. Verified live on
-- 2026-08-06; five facts composed into it, and each looked
-- harmless on its own:
--
--   1. players_self_insert's WITH CHECK constrained only
--      user_id, status and role. is_exec, is_trainer,
--      fee_exempt and membership_type were unconstrained.
--   2. `authenticated` held column-level INSERT on every one of
--      those columns.
--   3. guard_player_privileged_columns_trg is BEFORE UPDATE.
--      There was NO BEFORE INSERT trigger on players, so the
--      guard everyone reasons about simply did not run on the
--      insert path.
--   4. admin_access_level() tests `is_exec = TRUE` with no
--      status, ban or approval predicate.
--   5. Sign-up is open — signInWithOtp with no
--      shouldCreateUser:false and no domain restriction — and 17
--      auth users already exist with no players row.
--
--   Attack: sign in with any address, do NOT onboard (the
--   onboarding RPC would create the row for you and
--   players.user_id is UNIQUE), then
--   POST /rest/v1/players {..., "is_exec": true}
--   with the anon key and your own JWT. Then open /admin. The
--   passkey gate grants a grace period at zero credentials, so
--   there is nothing else to pass.
--
-- Fixed in three layers on purpose. This bug exists precisely
-- because each layer assumed another one covered it.
-- ============================================================

-- ---- Layer 1: remove the grant entirely --------------------
-- Column-level REVOKE is a NO-OP against a table-level grant — Postgres treats
-- the table grant as covering every column, and the dry run proved it (all six
-- privileged columns still listed afterwards). The table grant has to go.
--
-- Safe to remove outright: NOTHING in either app inserts into players with a
-- user-scoped client (grepped for insert/upsert on that table across both apps
-- and packages — zero hits). Sign-up and admin-created players both go through
-- create_player_with_rating(), which is SECURITY DEFINER and therefore runs as
-- the owner, unaffected by these grants.
REVOKE INSERT ON players FROM authenticated;
REVOKE INSERT ON players FROM anon;

-- ---- Layer 2: the policy states the invariant --------------
-- Belt to layer 1's braces: if a future migration re-grants a column, the
-- policy still refuses. Written as "must be the safe value" rather than
-- "must be absent" so a client cannot smuggle one through by sending it
-- explicitly set to the default.
DROP POLICY IF EXISTS players_self_insert ON players;
CREATE POLICY players_self_insert ON players
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending_approval'
    AND role = 'player'
    AND COALESCE(is_exec, FALSE) = FALSE
    AND COALESCE(is_trainer, FALSE) = FALSE
    AND COALESCE(fee_exempt, FALSE) = FALSE
    AND COALESCE(is_banned, FALSE) = FALSE
  );

-- ---- Layer 3: the trigger covers INSERT too ----------------
-- The guard is redefined wholesale, so every column it already protected is
-- carried over verbatim below — omitting one silently drops its protection,
-- which this file's own history warns about twice.
--
-- On INSERT there is no OLD row, so the test becomes "did you supply a
-- non-default value for a privileged column" rather than "did you change one".
CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A self-created row may only ever be an ordinary, unapproved member.
    IF COALESCE(NEW.is_exec, FALSE)
       OR COALESCE(NEW.is_trainer, FALSE)
       OR COALESCE(NEW.fee_exempt, FALSE)
       OR COALESCE(NEW.is_banned, FALSE)
       OR NEW.role IS DISTINCT FROM 'player'
       OR NEW.status IS DISTINCT FROM 'pending_approval' THEN
      RAISE EXCEPTION 'Not authorized to create a privileged player row';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_player_privileged_insert_trg ON players;
CREATE TRIGGER guard_player_privileged_insert_trg
  BEFORE INSERT ON players
  FOR EACH ROW EXECUTE FUNCTION guard_player_privileged_columns();
