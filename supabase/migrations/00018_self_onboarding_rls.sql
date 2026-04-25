-- ============================================================
-- 00018_self_onboarding_rls.sql
-- Allow authenticated users to insert their own player + initial ratings rows
-- so onboarding can run with the regular (RLS-aware) Supabase client instead
-- of escaping to the service role key.
-- ============================================================

-- A user may insert their own players row, but only with status = 'pending_approval'
-- and only for their own auth.uid(). Admin promotion still goes through admin policies.
CREATE POLICY players_self_insert ON players FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending_approval'
    AND role = 'player'
  );

-- A user may insert their own ratings row (one per player; enforced by UNIQUE on
-- ratings.player_id). The check joins through players to confirm ownership.
CREATE POLICY ratings_self_insert ON ratings FOR INSERT TO authenticated
  WITH CHECK (
    player_id IN (SELECT id FROM players WHERE user_id = auth.uid())
  );
