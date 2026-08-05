-- ============================================================
-- 00046_event_stages_and_typed_format.sql — pool then bracket, typed formats
-- ============================================================
-- Two things a real club day needs that the model could not express.
--
-- 1. STAGES. An event is either a round robin or a single-elimination bracket,
--    and never both. The way tournaments are actually run is pool play first —
--    short games, everyone plays — then the top finishers go into a bracket.
--    That is two events with a dependency between them, so the dependency is
--    what gets stored: an event can be seeded FROM another event's standings.
--
--    Deliberately NOT a new "stages" table with ordered rows. Events already
--    carry status, format, participants, brackets and fee tiers; a parallel
--    stage entity would duplicate all of it and leave two things to keep in
--    step. A self-referencing FK says the same thing with nothing new to own.
--
-- 2. TYPED MATCH FORMAT. match_format is a CHECK-constrained enum of four
--    presets, and those presets are just (games, points) pairs — "Best of 3 to
--    21" is 3 and 21. Pool play at 1 game to 15 was already expressible; 1 game
--    to 9, or best of 5 to 15, was not, and the enum has to grow a value every
--    time someone wants a shape nobody anticipated.
--
--    The columns are NULLABLE and the enum stays. Null means "use match_format"
--    so every existing event keeps its current meaning untouched, and the enum
--    remains the fallback the rest of the code already coalesces through — the
--    same approach 00031 took for challenges.
-- ============================================================

ALTER TABLE tournament_events
  ADD COLUMN IF NOT EXISTS games_per_match INTEGER,
  ADD COLUMN IF NOT EXISTS points_per_game INTEGER;

-- Bounds rather than an enum: 5 points is the shortest thing anyone would call
-- a game and 30 is the cap the scoring rules already top out at, so a value
-- outside that range is a typo, not a format. Games are odd-only — an even
-- best-of cannot be decided.
ALTER TABLE tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_custom_format_sane;
ALTER TABLE tournament_events
  ADD CONSTRAINT tournament_events_custom_format_sane CHECK (
    (games_per_match IS NULL OR (games_per_match BETWEEN 1 AND 7 AND games_per_match % 2 = 1))
    AND (points_per_game IS NULL OR (points_per_game BETWEEN 5 AND 30))
  );

COMMENT ON COLUMN tournament_events.games_per_match IS
  'Custom best-of, odd only. NULL means fall back to match_format. Mirrors the challenge custom-format approach from 00031.';
COMMENT ON COLUMN tournament_events.points_per_game IS
  'Custom target score per game. NULL means fall back to match_format.';

-- ------------------------------------------------------------
-- Stage linkage
-- ------------------------------------------------------------
ALTER TABLE tournament_events
  ADD COLUMN IF NOT EXISTS seeded_from_event_id UUID
    REFERENCES tournament_events(id) ON DELETE SET NULL;

-- How to rank the source event's finishers when seeding this one.
-- 'wins' is the default because that is what a pool table is read by; 'points'
-- suits a format where margins matter more than results.
ALTER TABLE tournament_events
  ADD COLUMN IF NOT EXISTS seed_by TEXT;
ALTER TABLE tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_seed_by_valid;
ALTER TABLE tournament_events
  ADD CONSTRAINT tournament_events_seed_by_valid
    CHECK (seed_by IS NULL OR seed_by IN ('wins', 'points'));

-- An event cannot seed from itself — that is a cycle with one node, and it
-- would deadlock bracket generation waiting on standings it produces.
ALTER TABLE tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_no_self_seed;
ALTER TABLE tournament_events
  ADD CONSTRAINT tournament_events_no_self_seed
    CHECK (seeded_from_event_id IS NULL OR seeded_from_event_id <> id);

COMMENT ON COLUMN tournament_events.seeded_from_event_id IS
  'Pool stage this event draws its field from. When set, bracket generation seeds from that event''s standings instead of Elo, and refuses until the pool is complete.';
COMMENT ON COLUMN tournament_events.seed_by IS
  'wins | points — how to rank the source standings. NULL behaves as wins.';

CREATE INDEX IF NOT EXISTS idx_tournament_events_seeded_from
  ON tournament_events(seeded_from_event_id)
  WHERE seeded_from_event_id IS NOT NULL;
