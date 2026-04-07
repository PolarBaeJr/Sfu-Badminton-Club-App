-- Elo snapshot captured when a match result is applied, so that undoMatchResult
-- and editMatchResult can perfectly reverse Elo changes (including doubles).
-- Shape: {"players":[{"player_id":"...","discipline":"singles|doubles","before":1234,"after":1245,"delta":11}], ...}
ALTER TABLE tournament_matches
  ADD COLUMN IF NOT EXISTS elo_snapshot JSONB;
