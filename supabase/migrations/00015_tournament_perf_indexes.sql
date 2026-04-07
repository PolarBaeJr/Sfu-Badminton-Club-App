-- Performance indexes for tournament filter hot paths.
--
-- Many tournament server actions filter rows by `event_id` AND `status` (or
-- `final_position`). The single-column event_id indexes already exist, but
-- Postgres still has to scan every row in the matched event to apply the
-- secondary predicate. These composites let the planner satisfy both
-- predicates from the index alone, which matters for finalize / leaderboard
-- / list pages on large events.

-- Singles participants — used by:
--   apps/admin/src/lib/tournament-actions.ts (capacity checks, finalize loops)
--   apps/admin/src/app/tournaments/[id]/page.tsx (per-event count aggregation)
CREATE INDEX IF NOT EXISTS idx_tournament_participants_event_status
  ON tournament_participants(event_id, status);

CREATE INDEX IF NOT EXISTS idx_tournament_participants_event_final_position
  ON tournament_participants(event_id, final_position)
  WHERE final_position IS NOT NULL;

-- Doubles pairs — same access pattern as participants.
CREATE INDEX IF NOT EXISTS idx_tournament_pairs_event_status
  ON tournament_pairs(event_id, status);

CREATE INDEX IF NOT EXISTS idx_tournament_pairs_event_final_position
  ON tournament_pairs(event_id, final_position)
  WHERE final_position IS NOT NULL;

-- Matches — finalize() filters by event_id + status to find unfinished matches,
-- and the bracket UI filters by event_id + round_number (already covered by
-- idx_tournament_matches_round). Add an event+status composite for the rest.
CREATE INDEX IF NOT EXISTS idx_tournament_matches_event_status
  ON tournament_matches(event_id, status);
