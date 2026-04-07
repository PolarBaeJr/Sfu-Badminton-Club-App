-- ============================================================
-- 00016_rls_with_check_hardening.sql
-- Defense-in-depth: tighten WITH CHECK clauses on RLS policies
-- that previously relied solely on application-layer validation.
-- ============================================================

-- CHALLENGES: ensure update cannot reassign creator to another player
DROP POLICY IF EXISTS challenges_update_own ON challenges;
CREATE POLICY challenges_update_own ON challenges FOR UPDATE TO authenticated
  USING (created_by = get_player_id(auth.uid()))
  WITH CHECK (created_by = get_player_id(auth.uid()));

-- CHALLENGE PARTICIPANTS: caller must be inserting/modifying their own row
DROP POLICY IF EXISTS cp_insert ON challenge_participants;
CREATE POLICY cp_insert ON challenge_participants FOR INSERT TO authenticated
  WITH CHECK (
    player_id = get_player_id(auth.uid()) OR is_admin(auth.uid())
  );

DROP POLICY IF EXISTS cp_update_own ON challenge_participants;
CREATE POLICY cp_update_own ON challenge_participants FOR UPDATE TO authenticated
  USING (player_id = get_player_id(auth.uid()))
  WITH CHECK (player_id = get_player_id(auth.uid()));

-- MATCHES: only the submitter (or admin) can insert; participants/admin can update
DROP POLICY IF EXISTS matches_insert ON matches;
CREATE POLICY matches_insert ON matches FOR INSERT TO authenticated
  WITH CHECK (
    submitted_by = get_player_id(auth.uid()) OR is_admin(auth.uid())
  );

DROP POLICY IF EXISTS matches_update ON matches;
CREATE POLICY matches_update ON matches FOR UPDATE TO authenticated
  USING (
    submitted_by = get_player_id(auth.uid()) OR
    id IN (SELECT match_id FROM match_participants WHERE player_id = get_player_id(auth.uid())) OR
    is_admin(auth.uid())
  )
  WITH CHECK (
    submitted_by = get_player_id(auth.uid()) OR
    id IN (SELECT match_id FROM match_participants WHERE player_id = get_player_id(auth.uid())) OR
    is_admin(auth.uid())
  );

-- MATCH PARTICIPANTS: must reference an existing match the caller submitted, or admin
DROP POLICY IF EXISTS mp_insert ON match_participants;
CREATE POLICY mp_insert ON match_participants FOR INSERT TO authenticated
  WITH CHECK (
    is_admin(auth.uid()) OR
    match_id IN (SELECT id FROM matches WHERE submitted_by = get_player_id(auth.uid()))
  );

-- MATCH GAMES: same constraint as match_participants
DROP POLICY IF EXISTS mg_insert ON match_games;
CREATE POLICY mg_insert ON match_games FOR INSERT TO authenticated
  WITH CHECK (
    is_admin(auth.uid()) OR
    match_id IN (SELECT id FROM matches WHERE submitted_by = get_player_id(auth.uid()))
  );

-- NOTIFICATIONS: cannot reassign a notification to another player
DROP POLICY IF EXISTS notifications_update ON notifications;
CREATE POLICY notifications_update ON notifications FOR UPDATE TO authenticated
  USING (player_id = get_player_id(auth.uid()))
  WITH CHECK (player_id = get_player_id(auth.uid()));

-- VARSITY NOTES: update must keep coach/admin authorship
DROP POLICY IF EXISTS vn_update ON varsity_notes;
CREATE POLICY vn_update ON varsity_notes FOR UPDATE TO authenticated
  USING (is_admin_or_coach(auth.uid()))
  WITH CHECK (is_admin_or_coach(auth.uid()));

-- AUDIT LOGS: only admins or service role can write (server actions use service role)
DROP POLICY IF EXISTS audit_insert ON audit_logs;
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO authenticated
  WITH CHECK (is_admin(auth.uid()));
