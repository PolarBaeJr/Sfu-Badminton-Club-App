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
-- STEP 1: Migrate player statuses
-- ============================================================
-- 'eligible_competitive' and 'competitive_associate' both map to 'competitive'
-- since the distinction between SFU-eligible and associate members is no longer
-- tracked at the status level.
UPDATE players
SET status = 'competitive'
WHERE status IN ('eligible_competitive', 'competitive_associate');

-- 'alumni_external' and 'inactive' both map to 'suspended' since these
-- players should not have active access. Admins can reactivate individually.
UPDATE players
SET status = 'suspended'
WHERE status IN ('alumni_external', 'inactive');

-- ============================================================
-- STEP 2: Migrate user roles
-- ============================================================
-- 'moderator' and 'coach_executive' are collapsed into 'player'.
-- The platform now uses a two-role model: player and admin only.
UPDATE players
SET role = 'player'
WHERE role IN ('moderator', 'coach_executive');

-- ============================================================
-- STEP 3: Set admin for the platform owner
-- ============================================================
UPDATE players
SET role = 'admin'
WHERE email = 'virajveer@gmail.com';

-- ============================================================
-- STEP 4: Add 'archived' to tournament_status enum
-- ============================================================
-- The admin UI now supports archiving tournaments (Active -> Archived).
-- IF NOT EXISTS prevents failure if this value was already added.
ALTER TYPE tournament_status ADD VALUE IF NOT EXISTS 'archived';

COMMIT;
