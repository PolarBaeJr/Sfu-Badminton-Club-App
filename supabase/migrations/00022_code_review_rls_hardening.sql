-- ============================================================
-- 00022 - RLS / trigger hardening from the repository code review
-- ============================================================
-- Four independent fixes, all idempotent:
--   1. Extend the player privileged-column guard to waiver_reset_at and
--      deletion_requested_at (a member could clear an admin-forced waiver
--      re-signature via a normal profile UPDATE).
--   2. (see note below) matches_update column scoping is NOT fixed here — the
--      naive guard breaks confirm_match_result(); it needs a dedicated change.
--   3. Scope avatar storage writes to the owning player — the self-host fix in
--      00017 checked only bucket_id, so any authenticated user could overwrite
--      or delete another member's avatar.
--   4. Restrict the four tournament SELECT policies to authenticated; they
--      were FOR SELECT USING (true) with no role, exposing participant
--      player_ids to anon.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Privileged-column guard: add waiver/deletion columns
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
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     -- Clearing waiver_reset_at would defeat an admin forcing a re-signature;
     -- deletion_requested_at drives the deletion/restore gate.
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 2. (deliberately not addressed here) matches_update column scoping
-- ------------------------------------------------------------
-- The review also flagged that participants can PATCH matches.winner_side /
-- score_summary / result_status directly. That IS a real gap, but the obvious
-- BEFORE UPDATE guard breaks the legitimate path: confirm_match_result()
-- (00003_functions.sql:325) sets result_status='confirmed' from a SECURITY
-- DEFINER function where auth.uid() is still the (non-admin) participant, so a
-- naive trigger rejects real confirmations. Fixing it properly means gating on
-- a transaction-local flag set by the trusted RPCs (and reworking the dispute
-- UPDATE in actions/matches.ts). Left for a dedicated change with test
-- coverage rather than shipped blind against live data.

-- ------------------------------------------------------------
-- 3. Scope avatar storage writes to the owning player
-- ------------------------------------------------------------
-- Avatars are uploaded as object name "avatars/<player_id>.<ext>" (see
-- AvatarUpload.tsx) — the player id is the FILE NAME stem, not a folder. Match
-- on that stem so a member can only overwrite/delete their own avatar.
DROP POLICY IF EXISTS avatars_auth_update ON storage.objects;
CREATE POLICY avatars_auth_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND split_part(storage.filename(name), '.', 1) = get_player_id(auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'avatars'
    AND split_part(storage.filename(name), '.', 1) = get_player_id(auth.uid())::text
  );

DROP POLICY IF EXISTS avatars_auth_delete ON storage.objects;
CREATE POLICY avatars_auth_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'avatars'
    AND split_part(storage.filename(name), '.', 1) = get_player_id(auth.uid())::text
  );

-- Uploads are scoped the same way. Note the app uses upsert, which needs both
-- INSERT and UPDATE to pass.
DROP POLICY IF EXISTS "avatars_auth_insert" ON storage.objects;
CREATE POLICY "avatars_auth_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars'
    AND split_part(storage.filename(name), '.', 1) = get_player_id(auth.uid())::text
  );

-- ------------------------------------------------------------
-- 4. Tournament reads: authenticated only (were USING (true), no role)
-- ------------------------------------------------------------
-- The existing policies are named "Public read <table>" (00005_rls.sql:426-429).
-- They must be DROPPED by that exact name: policies are OR'd, so merely adding
-- an authenticated-scoped policy alongside them would leave anon access intact.
DROP POLICY IF EXISTS "Public read tournament_events" ON tournament_events;
DROP POLICY IF EXISTS tournament_events_select ON tournament_events;
CREATE POLICY tournament_events_select ON tournament_events
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Public read tournament_participants" ON tournament_participants;
DROP POLICY IF EXISTS tournament_participants_select ON tournament_participants;
CREATE POLICY tournament_participants_select ON tournament_participants
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Public read tournament_pairs" ON tournament_pairs;
DROP POLICY IF EXISTS tournament_pairs_select ON tournament_pairs;
CREATE POLICY tournament_pairs_select ON tournament_pairs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Public read tournament_matches" ON tournament_matches;
DROP POLICY IF EXISTS tournament_matches_select ON tournament_matches;
CREATE POLICY tournament_matches_select ON tournament_matches
  FOR SELECT TO authenticated USING (true);
