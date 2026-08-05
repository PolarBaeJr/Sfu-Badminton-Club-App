-- ============================================================
-- 00045_tournament_checkin_tokens.sql — QR check-in for tournaments
-- ============================================================
-- Sessions have had QR check-in since 00024: an admin generates a token, the
-- QR is rendered server-side, and a member scans it at the door. Tournaments
-- never got it — a player had to navigate to each EVENT's check-in page and
-- press a button, once per event they had entered. Someone in Men's Singles
-- and Mixed Doubles checked in twice, on two different screens, while standing
-- at a desk with a queue behind them.
--
-- The token is per TOURNAMENT, not per event. One code at the door covers the
-- whole day, and it is what makes "scan once, check in to everything you're
-- entered in" expressible at all — a per-event token would just move the same
-- repetition onto the printer.
--
-- Deliberately a separate table rather than columns on `tournaments`, matching
-- 00024. tournaments is read by the public tournament list and by anon through
-- SECURITY DEFINER helpers; a token column there is one careless `select('*')`
-- away from being published. A table with RLS on and no policies cannot leak
-- through PostgREST at all.
-- ============================================================

CREATE TABLE IF NOT EXISTS tournament_checkin_tokens (
  tournament_id UUID PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ
);

COMMENT ON TABLE tournament_checkin_tokens IS
  'One opaque token per tournament, backing the check-in QR. Rotating it invalidates any QR already printed or shared. Read and written only through a service-role client — RLS is on with no policies, so PostgREST exposes nothing.';

-- ============================================================
-- RLS
-- ============================================================
-- Zero policies on purpose, same as session_checkin_tokens. RLS enabled with
-- no policies denies every anon and authenticated path: a member must not be
-- able to read the token for a tournament they are not attending, because
-- holding the token IS the proof of being at the door. Both sides use a
-- service-role client — the admin app to generate and rotate, the player app
-- to resolve a scanned token back to a tournament.
ALTER TABLE tournament_checkin_tokens ENABLE ROW LEVEL SECURITY;

-- Belt and braces: PostgREST exposes any table the roles hold grants on, so
-- drop the grants as well as relying on the empty policy set.
REVOKE ALL ON tournament_checkin_tokens FROM anon, authenticated;
