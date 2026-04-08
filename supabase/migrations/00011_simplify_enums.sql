-- ============================================================
-- 00011_simplify_enums.sql
--
-- Simplify player_status and user_role enums to match updated
-- TypeScript types in packages/shared/src/types/database.ts:
--
--   PlayerStatus: 'competitive' | 'recreational' | 'pending_approval' | 'suspended'
--   UserRole:     'player' | 'admin'
--   TournamentStatus: 'draft' | 'active' | 'completed' | 'archived'
-- ============================================================

BEGIN;

-- ============================================================
-- STEP 1: Recreate player_status with simplified values
-- ============================================================
DROP TRIGGER IF EXISTS init_player_records ON players;

DROP POLICY IF EXISTS players_select ON players;
DROP POLICY IF EXISTS players_update_own ON players;
DROP POLICY IF EXISTS players_admin ON players;

ALTER TABLE players ALTER COLUMN status DROP DEFAULT;

ALTER TYPE player_status RENAME TO player_status_old;

CREATE TYPE player_status AS ENUM ('competitive', 'recreational', 'pending_approval', 'suspended');

ALTER TABLE players
  ALTER COLUMN status TYPE player_status
  USING CASE
    WHEN status::text IN ('eligible_competitive', 'competitive_associate') THEN 'competitive'::player_status
    WHEN status::text IN ('alumni_external', 'inactive')                   THEN 'suspended'::player_status
    ELSE status::text::player_status
  END;

ALTER TABLE players ALTER COLUMN status SET DEFAULT 'pending_approval';

DROP TYPE player_status_old;

CREATE POLICY players_select ON players FOR SELECT TO authenticated
  USING (status != 'pending_approval' OR user_id = auth.uid() OR is_admin(auth.uid()));

CREATE POLICY players_update_own ON players FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY players_admin ON players FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

CREATE TRIGGER init_player_records
  AFTER UPDATE OF status ON players
  FOR EACH ROW
  EXECUTE FUNCTION trigger_init_player_records();

-- ============================================================
-- STEP 2: Recreate user_role with simplified values
-- ============================================================
ALTER TABLE players ALTER COLUMN role DROP DEFAULT;

ALTER TYPE user_role RENAME TO user_role_old;

CREATE TYPE user_role AS ENUM ('player', 'admin');

ALTER TABLE players
  ALTER COLUMN role TYPE user_role
  USING CASE
    WHEN role::text IN ('moderator', 'coach_executive') THEN 'player'::user_role
    ELSE role::text::user_role
  END;

ALTER TABLE players ALTER COLUMN role SET DEFAULT 'player';

DROP TYPE user_role_old;

-- ============================================================
-- STEP 3: Set admin for the platform owner
-- ============================================================
UPDATE players
SET role = 'admin'
WHERE email = 'virajveer@gmail.com';

-- ============================================================
-- STEP 4: Add 'archived' to tournament_status enum
-- ============================================================
ALTER TYPE tournament_status ADD VALUE IF NOT EXISTS 'archived';

COMMIT;
