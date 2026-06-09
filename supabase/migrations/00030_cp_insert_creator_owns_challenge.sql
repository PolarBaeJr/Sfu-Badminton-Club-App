-- 00030_cp_insert_creator_owns_challenge.sql
-- 00016 tightened cp_insert to self-only (player_id = self OR is_admin), which silently blocks
-- createChallenge's opponent/partner rows for any NON-admin creator. It went unnoticed because only
-- admins (who bypass via the is_admin clause) had created challenges pre-launch — every real,
-- non-admin user would hit a hard failure on their first challenge.
--
-- Fix the policy rather than service-role-bypassing the insert: a challenge's CREATOR may insert
-- participants for that challenge is a clean ownership predicate, and it is MORE restrictive than a
-- service-role bypass (which disables RLS entirely on that insert — write participants for any
-- challenge). actions.ts:177 stays auth-bound.
--
-- Safe: challenges_select is USING(TRUE), so the EXISTS subquery resolves under caller RLS;
-- get_player_id is STABLE SECURITY DEFINER; and the challenge row is committed before the
-- participant insert, so the EXISTS sees it.

DROP POLICY IF EXISTS cp_insert ON challenge_participants;
CREATE POLICY cp_insert ON challenge_participants FOR INSERT TO authenticated
  WITH CHECK (
    player_id = get_player_id(auth.uid())                      -- own row (existing self clause)
    OR is_admin(auth.uid())                                    -- existing admin clause
    OR EXISTS (                                                -- NEW: creator inserting for own challenge
      SELECT 1 FROM challenges c
      WHERE c.id = challenge_id
        AND c.created_by = get_player_id(auth.uid())
    )
  );
