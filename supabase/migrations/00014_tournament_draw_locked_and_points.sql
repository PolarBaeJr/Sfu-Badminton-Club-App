-- Add draw_locked to tournament_events and points to tournament_participants/pairs.
-- These columns were originally added directly to 00009_tournament_system.sql after
-- that migration had already been applied to existing databases, so this migration
-- brings those databases in sync. Idempotent via IF NOT EXISTS.

ALTER TABLE tournament_events
  ADD COLUMN IF NOT EXISTS draw_locked BOOLEAN DEFAULT false;

ALTER TABLE tournament_participants
  ADD COLUMN IF NOT EXISTS points INT DEFAULT 0;

ALTER TABLE tournament_pairs
  ADD COLUMN IF NOT EXISTS points INT DEFAULT 0;
