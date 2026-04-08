-- ============================================================
-- 00011_simplify_enums.sql
--
-- Simplify player_status and user_role enums to match updated
-- TypeScript types in packages/shared/src/types/database.ts:
--
--   PlayerStatus: 'competitive' | 'recreational' | 'pending_approval' | 'suspended'
--   UserRole:     'player' | 'admin'
--   TournamentStatus: 'draft' | 'active' | 'completed' | 'archived'
--
-- This migration:
--   1. Consolidates obsolete player statuses into the simplified set
--   2. Consolidates obsolete roles into the simplified set
--   3. Sets the admin role for the platform owner
--   4. Adds 'archived' to the tournament_status enum
-- ============================================================

BEGIN;

-- ============================================================
-- STEP 1: Simplify player_status enum
-- ============================================================
-- Add new value first, then migrate data, then recreate enum
-- without the obsolete values.

ALTER TYPE player_status ADD VALUE IF NOT EXISTS 'competitive';

COMMIT;

-- ALTER TYPE inside a transaction cannot be followed immediately by
-- usage of the new value in the same transaction in older PG versions,
-- so we re-open a transaction after committing the ADD VALUE.

BEGIN;

-- 'eligible_competitive' and 'competitive_associate' both map to 'competitive'
UPDATE players
SET status = 'competitive'
WHERE status IN ('eligible_competitive', 'competitive_associate');

-- 'alumni_external' and 'inactive' both map to 'suspended'
UPDATE players
SET status = 'suspended'
WHERE status IN ('alumni_external', 'inactive');

-- Recreate player_status with only the simplified values
ALTER TYPE player_status RENAME TO player_status_old;
CREATE TYPE player_status AS ENUM ('competitive', 'recreational', 'pending_approval', 'suspended');
ALTER TABLE players
  ALTER COLUMN status TYPE player_status USING status::text::player_status;
DROP TYPE player_status_old;

-- ============================================================
-- STEP 2: Simplify user_role enum
-- ============================================================
-- 'moderator' and 'coach_executive' are collapsed into 'player'.
UPDATE players
SET role = 'player'
WHERE role IN ('moderator', 'coach_executive');

-- Recreate user_role with only player and admin
ALTER TYPE user_role RENAME TO user_role_old;
CREATE TYPE user_role AS ENUM ('player', 'admin');
ALTER TABLE players
  ALTER COLUMN role TYPE user_role USING role::text::user_role;
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
