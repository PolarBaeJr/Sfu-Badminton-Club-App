-- ============================================================
-- Varsity trainer: a third console access level
-- ============================================================
-- The club owner asked for "a new role called 'varsity trainer' (it only have
-- players and varsity notes)" — someone who coaches the varsity squad, needs to
-- find a player, and writes coaching notes against them. Nothing else.
--
-- WHY A BOOLEAN AND NOT A user_role LABEL
-- ---------------------------------------
-- `role` is a two-label enum (player | admin) that answers "is this person an
-- administrator of the platform". Club standing has never lived there —
-- `is_exec` is a separate boolean precisely because an exec is not an admin and
-- the two compose freely. A trainer is the same shape of thing: a job in the
-- club, orthogonal to whether you administer the software. Someone can be a
-- trainer AND an exec AND an admin without contradiction, which an enum label
-- on a single-valued column cannot express at all.
--
-- Three further reasons the enum was the wrong tool:
--   * `role = 'varsity_trainer'` would make the person no longer `role =
--     'player'`, and player-facing code reads `role` for ordinary membership.
--   * Adding an enum label is irreversible in Postgres without rewriting every
--     table that uses the type — a one-way door for a club job title.
--   * The privilege guard, RLS and the passkey guards all already know how to
--     protect a boolean marker on players; is_trainer joins them by name.
--
-- The levels are strictly ordered — admin > exec > trainer — because a trainer's
-- powers are a subset of an exec's. admin_access_level() therefore returns the
-- HIGHEST level a person holds, so a trainer who is also an exec is simply an
-- exec.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS is_trainer BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN players.is_trainer IS
  'Varsity trainer: may open the admin console to read the player roster and write varsity notes, and nothing else. Independent of role and is_exec — a trainer may also be an exec or an admin, in which case the higher level wins (see admin_access_level).';

-- ============================================================
-- admin_access_level: now three levels
-- ============================================================
-- Same contract as before: the highest level the user holds, or NULL for
-- someone with no console access at all. Only the new bottom rung is added, so
-- every existing caller keeps the answer it used to get.
--
-- The returned literal 'trainer' is byte-identical to the AccessLevel union
-- member in apps/admin/src/lib/permissions.ts. A mismatch would resolve to null
-- in the middleware and lock trainers out with no error surfaced anywhere.
--
-- SECURITY DEFINER and the search_path are carried over deliberately: the
-- middleware calls this RPC as `authenticated`, and without DEFINER the lookup
-- would hit RLS and return NULL for everyone — a silent, total console lockout.
CREATE OR REPLACE FUNCTION admin_access_level(p_user_id UUID)
RETURNS TEXT AS $$
BEGIN
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- guard_player_privileged_columns: protect the new marker
-- ============================================================
-- Reproduced from the LIVE definition (read 2026-08-05) with is_trainer added.
-- This function is CREATE OR REPLACE'd wholesale every time it changes, so
-- omitting a column silently DROPS its protection — that has already bitten this
-- repo once (see the membership_type note below, carried from 00040). Every
-- column listed here was listed before; only is_trainer is new.
--
-- What it protects: a member updating their OWN players row with their OWN JWT.
-- It does NOT protect against the admin app's server actions, which write
-- through the service-role client where auth.uid() is NULL and the first branch
-- returns early. That boundary lives in
-- apps/admin/src/lib/player-field-access.ts, which also lists is_trainer.
CREATE OR REPLACE FUNCTION guard_player_privileged_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN
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
     -- Carried from 00040. This function is redefined wholesale, so omitting a
     -- column silently DROPS its protection — and 00040 lives on a different
     -- branch, so the two changes only meet here. Leaving membership_type out
     -- would have let a member set themselves to 'internal' with a plain
     -- profile update and walk into an internal-only event.
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     -- New in 00042: publishing an image to the public exec page is an admin
     -- action, not a self-service profile edit.
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     -- New in 00054: is_trainer opens the admin console. Exactly the same
     -- reasoning as is_exec beside it — nobody self-promotes with a profile save.
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- Interaction with 00050 (last-admin passkey guard): none
-- ============================================================
-- guard_last_admin_role() fires BEFORE UPDATE OR DELETE on players, but its
-- UPDATE branch only raises when OLD.role = 'admin' AND NEW.role IS DISTINCT
-- FROM 'admin'. Setting is_trainer leaves role untouched, so the branch falls
-- straight through. Its DELETE branch and guard_last_admin_passkey_delete() both
-- key on role = 'admin' alone and are likewise indifferent to is_trainer. A
-- trainer is not an admin and can never satisfy admins_with_passkeys(), so the
-- "at least one admin with an admin-enrolled passkey" invariant is untouched in
-- both directions. Asserted in the dry-run.
