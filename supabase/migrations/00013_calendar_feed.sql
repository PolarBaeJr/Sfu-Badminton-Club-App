-- ============================================================
-- 00013_calendar_feed.sql — per-player ICS subscription feed
--
-- Adds calendar_feed_tokens: one secret token per player backing
-- the player app's /api/calendar/[token] ICS feed. Calendar
-- clients can't authenticate, so the unguessable token in the
-- URL is the credential. Players can reset their token from
-- Settings to revoke any previously shared feed links.
-- ============================================================

CREATE TABLE calendar_feed_tokens (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE calendar_feed_tokens ENABLE ROW LEVEL SECURITY;

-- Owners can read their own token. All writes go through the player
-- app's service-role client (bypasses RLS), so there are deliberately no
-- INSERT/UPDATE/DELETE policies.
CREATE POLICY cft_select ON calendar_feed_tokens FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()));
