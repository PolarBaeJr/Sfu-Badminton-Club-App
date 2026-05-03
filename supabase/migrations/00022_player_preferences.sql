-- ============================================================================
-- 00022_player_preferences.sql
-- Normalized per-player preferences. Replaces the per-player slice of
-- `players.notification_preferences` (JSONB) and the existing privacy flags
-- (`hide_from_leaderboard`, `profile_visibility`, `show_activity_status`)
-- as the source of truth for new code.
--
-- The existing players columns are retained for backward compatibility so
-- already-deployed code paths keep working. Phase 4 wires the settings UI
-- to read/write player_preferences only; a future cleanup phase will drop
-- the legacy columns once no consumer reads them.
--
-- Notification-event triggers (notify_challenge_received, etc.) are
-- intentionally NOT introduced here — notifications are already produced by
-- application server actions (`apps/player/src/lib/actions.ts`) and edge
-- functions. Adding equivalent DB triggers would emit duplicate rows.
-- Notification system enhancements ship in revised Phase 7.
-- ============================================================================

-- ── Table ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.player_preferences (
  player_id UUID PRIMARY KEY REFERENCES public.players(id) ON DELETE CASCADE,

  -- Notification channels (push)
  notify_new_challenge          BOOLEAN NOT NULL DEFAULT TRUE,
  notify_match_result           BOOLEAN NOT NULL DEFAULT TRUE,
  notify_session_reminder       BOOLEAN NOT NULL DEFAULT FALSE,
  notify_weekly_recap_push      BOOLEAN NOT NULL DEFAULT TRUE,
  notify_league_announcements   BOOLEAN NOT NULL DEFAULT TRUE,

  -- Notification channels (email)
  notify_weekly_recap_email     BOOLEAN NOT NULL DEFAULT TRUE,
  notify_season_updates         BOOLEAN NOT NULL DEFAULT TRUE,
  notify_tournaments_events     BOOLEAN NOT NULL DEFAULT FALSE,

  -- Match availability
  available_days        TEXT[] NOT NULL DEFAULT '{Mon,Tue,Wed,Thu,Fri}'::TEXT[],
  available_hours_start TIME   NOT NULL DEFAULT '17:00',
  available_hours_end   TIME   NOT NULL DEFAULT '22:00',
  home_court            TEXT,

  -- Challenge preferences
  auto_accept_challenges BOOLEAN NOT NULL DEFAULT FALSE,
  open_to_doubles        BOOLEAN NOT NULL DEFAULT TRUE,
  cross_skill_matches    BOOLEAN NOT NULL DEFAULT TRUE,

  -- Match logging
  default_match_type    TEXT NOT NULL DEFAULT 'singles'
    CHECK (default_match_type IN ('singles', 'doubles')),
  default_score_format  TEXT NOT NULL DEFAULT 'bo3_21'
    CHECK (default_score_format IN ('bo3_21', 'bo3_15', 'bo1_21')),
  submission_reminders  BOOLEAN NOT NULL DEFAULT TRUE,

  -- Privacy
  show_on_leaderboard   BOOLEAN NOT NULL DEFAULT TRUE,
  show_win_loss_record  BOOLEAN NOT NULL DEFAULT TRUE,
  show_match_history    BOOLEAN NOT NULL DEFAULT TRUE,
  discoverable          BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (available_hours_end > available_hours_start)
);

COMMENT ON TABLE  public.player_preferences IS
  'Normalized per-player preferences. Source of truth for new settings UI; replaces players.notification_preferences (JSONB) and the privacy boolean trio over time.';
COMMENT ON COLUMN public.player_preferences.show_on_leaderboard IS
  'Inverse of legacy players.hide_from_leaderboard. New code reads this column.';
COMMENT ON COLUMN public.player_preferences.discoverable IS
  'Whether this player surfaces in player search and challenge suggestions.';

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Partial index for discovery/suggestion queries.
CREATE INDEX IF NOT EXISTS player_preferences_discoverable_idx
  ON public.player_preferences (player_id)
  WHERE discoverable = TRUE;

-- Partial index for leaderboard rendering — common query is "all players who
-- consent to leaderboard visibility".
CREATE INDEX IF NOT EXISTS player_preferences_show_on_leaderboard_idx
  ON public.player_preferences (player_id)
  WHERE show_on_leaderboard = TRUE;

-- ── updated_at trigger (reuses the helper from 00004_triggers.sql) ──────────
DROP TRIGGER IF EXISTS set_updated_at ON public.player_preferences;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.player_preferences
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- ── Backfill rows for every existing player ─────────────────────────────────
-- Initialize show_on_leaderboard from the inverse of the legacy column so
-- nobody's existing privacy posture changes after the migration.
INSERT INTO public.player_preferences (player_id, show_on_leaderboard)
SELECT id, NOT COALESCE(hide_from_leaderboard, FALSE)
FROM public.players
ON CONFLICT (player_id) DO NOTHING;

-- ── Auto-create preferences row when a new player joins ─────────────────────
CREATE OR REPLACE FUNCTION public.create_default_player_preferences()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.player_preferences (player_id)
  VALUES (NEW.id)
  ON CONFLICT (player_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS players_create_preferences ON public.players;
CREATE TRIGGER players_create_preferences
  AFTER INSERT ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.create_default_player_preferences();

-- ============================================================================
-- RLS — players manage only their own row; admins have full access
-- ============================================================================
ALTER TABLE public.player_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS player_preferences_select  ON public.player_preferences;
DROP POLICY IF EXISTS player_preferences_insert  ON public.player_preferences;
DROP POLICY IF EXISTS player_preferences_update  ON public.player_preferences;
DROP POLICY IF EXISTS player_preferences_admin   ON public.player_preferences;

CREATE POLICY player_preferences_select ON public.player_preferences
  FOR SELECT TO authenticated
  USING (player_id = public.get_player_id(auth.uid()));

CREATE POLICY player_preferences_insert ON public.player_preferences
  FOR INSERT TO authenticated
  WITH CHECK (player_id = public.get_player_id(auth.uid()));

CREATE POLICY player_preferences_update ON public.player_preferences
  FOR UPDATE TO authenticated
  USING      (player_id = public.get_player_id(auth.uid()))
  WITH CHECK (player_id = public.get_player_id(auth.uid()));

CREATE POLICY player_preferences_admin ON public.player_preferences
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()));
