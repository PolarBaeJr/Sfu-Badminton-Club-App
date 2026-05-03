-- ============================================================================
-- 00025_notifications_enhance.sql
-- Notification system enhancements per the Phase 7 revised plan.
--   • Adds notifications.read_at (timestamptz) and .action_url (text).
--     Backfills read_at = created_at for already-read rows so legacy data
--     doesn't show as "read but never read" forever.
--   • Adds 7 net-new notification_type enum values for the surfaces Phase 7
--     light up: session lifecycle, win streaks, weekly recaps, league /
--     season announcements. Existing 21 values (16 base + 5 tournament) stay.
-- ============================================================================

-- ── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS read_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS action_url TEXT;

COMMENT ON COLUMN public.notifications.read_at IS
  'When this notification was first marked read. NULL while still unread. Backfilled to created_at on rows that were already read at migration time.';
COMMENT ON COLUMN public.notifications.action_url IS
  'Optional in-app destination for tap. When NULL the client derives a route from type + metadata via getNotificationHref().';

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Already-read rows get read_at = created_at as a stand-in. We don't have
-- the actual read timestamp, but this preserves "read happened" without
-- claiming it happened at NOW().
UPDATE public.notifications
   SET read_at = created_at
 WHERE read_flag = TRUE
   AND read_at IS NULL;

-- ── Enum additions ─────────────────────────────────────────────────────────
-- Postgres requires ALTER TYPE ADD VALUE statements to be outside a
-- transaction; supabase migrations files run each statement in its own
-- implicit transaction so this is fine. IF NOT EXISTS makes the migration
-- safely re-runnable.
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'session_starting';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'session_full';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'win_streak';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'weekly_recap';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'league_announcement';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'season_starting';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'season_ending';
