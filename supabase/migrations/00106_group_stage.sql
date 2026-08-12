-- ============================================================
-- 00106_group_stage.sql — several round-robin groups, then a knockout
-- ============================================================
-- THE FORMAT THE MODEL COULD NOT EXPRESS. 00046 built one pool feeding one
-- bracket: a knockout event carries seeded_from_event_id, and the top
-- max_participants finishers of that single pool become its draw. That is the
-- right shape for eight players. It is the wrong shape for twenty-four, because
-- one pool of twenty-four is 276 matches. Four groups of six is 60.
--
-- So what is missing is not "pools" — it is GROUPS, plural, inside one pool
-- stage. This migration adds exactly that and nothing else.
--
-- ------------------------------------------------------------
-- WHY THIS IS FOUR NULLABLE COLUMNS AND NOT A TABLE
-- ------------------------------------------------------------
--
-- 1. NO CHANGE TO format's CHECK. A group stage IS a round robin — every
--    entrant plays everyone in their group, the standings are a round-robin
--    table, the circle method generates the fixtures. It is the same format
--    partitioned. Adding a third value to
--        format TEXT NOT NULL CHECK (format IN ('single_elimination','round_robin'))
--    would mean every `format === 'round_robin'` branch in the console — the
--    tab list, the header, the generator switch, the finaliser's points rule —
--    silently stops matching for group events, and each of those is a place
--    where the wrong branch is invisible until an event day. The CHECK is left
--    exactly as 00001 wrote it.
--
-- 2. NO GROUPS TABLE, AND NO JOIN TABLE FOR THE KNOCKOUT. A group is a number,
--    not an entity: it has no name of its own, no schedule, no status, nothing
--    that outlives the event. An INT on the entry row says the same thing with
--    nothing new to own, nothing to cascade and no second place for the truth
--    to live. And because the whole group stage stays ONE event,
--    seeded_from_event_id stays SINGULAR and keeps working untouched — there is
--    still exactly one event feeding the bracket. A group stage built as N
--    separate round-robin events would have forced seeded_from_event_id to
--    become a join table, and every reader of it to change with it.
--
-- 3. EVERY COLUMN IS NULLABLE AND NULL MEANS "AS BEFORE". group_count NULL or 1
--    is an ordinary round robin — which is every round-robin event that exists
--    today — and group_number NULL is an entry in no group. Nothing on
--    production changes meaning, and the flat path is not a special case of the
--    group path: it is untouched.
--
-- SAFE TO RUN ON A LIVE TABLE. Four ADD COLUMN ... IF NOT EXISTS of a nullable
-- INT with no DEFAULT — a catalogue-only change in Postgres 11+, no table
-- rewrite, no lock beyond the brief ACCESS EXCLUSIVE the ALTER itself takes.
-- The CHECKs are added over data that satisfies them vacuously (every existing
-- row is NULL), so validation scans find nothing to reject.
-- ============================================================

-- ------------------------------------------------------------
-- The event: how many groups, and how many get out of each
-- ------------------------------------------------------------

ALTER TABLE tournament_events
  ADD COLUMN IF NOT EXISTS group_count INTEGER,
  ADD COLUMN IF NOT EXISTS qualifiers_per_group INTEGER;

-- Bounds rather than an enum, same reasoning as 00046's custom format. One
-- group is not a group stage, it is a round robin, so 1 is allowed and means
-- exactly that. 32 is past any club draw and a number above it is a typo.
ALTER TABLE tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_group_shape_sane;
ALTER TABLE tournament_events
  ADD CONSTRAINT tournament_events_group_shape_sane CHECK (
    (group_count IS NULL OR group_count BETWEEN 1 AND 32)
    AND (qualifiers_per_group IS NULL OR qualifiers_per_group BETWEEN 1 AND 16)
  );

-- A KNOCKOUT CANNOT HAVE GROUPS. The bracket is the bracket; partitioning it
-- would mean something else entirely, and the generator has no code for it. A
-- row-level CHECK can see both columns, so this is enforced here rather than
-- left to the application to remember. group_count = 1 is permitted on any
-- format because it is indistinguishable from NULL in meaning.
ALTER TABLE tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_groups_are_round_robin;
ALTER TABLE tournament_events
  ADD CONSTRAINT tournament_events_groups_are_round_robin CHECK (
    group_count IS NULL OR group_count <= 1 OR format = 'round_robin'
  );

COMMENT ON COLUMN tournament_events.group_count IS
  'How many round-robin groups this event is split into. NULL or 1 is an ordinary flat round robin — the pre-00106 behaviour. 2 or more makes it a group stage: the circle method runs once per group, standings are tallied per group, and a knockout seeded from this event promotes the top qualifiers_per_group of each. Only meaningful on format = round_robin.';
COMMENT ON COLUMN tournament_events.qualifiers_per_group IS
  'How many of each group advance to the knockout that seeds from this event. NULL behaves as 2. Read only when group_count >= 2; the knockout''s own max_participants still caps the field on top of this.';

-- ------------------------------------------------------------
-- The entries: which group each one is in
-- ------------------------------------------------------------
--
-- ON BOTH TABLES, because a doubles group stage groups PAIRS and a singles one
-- groups PARTICIPANTS, exactly as seeding and standings already split. The two
-- columns are deliberately identical so the generator can pick a table and
-- treat the rest the same way it already does for seed_number.

ALTER TABLE tournament_participants
  ADD COLUMN IF NOT EXISTS group_number INTEGER;
ALTER TABLE tournament_pairs
  ADD COLUMN IF NOT EXISTS group_number INTEGER;

-- No upper bound here on purpose: the ceiling is the EVENT's group_count, which
-- this row cannot see. The application refuses an out-of-range group; the
-- database only refuses a number that could never be a group under any setting.
ALTER TABLE tournament_participants
  DROP CONSTRAINT IF EXISTS tournament_participants_group_number_positive;
ALTER TABLE tournament_participants
  ADD CONSTRAINT tournament_participants_group_number_positive
    CHECK (group_number IS NULL OR group_number >= 1);

ALTER TABLE tournament_pairs
  DROP CONSTRAINT IF EXISTS tournament_pairs_group_number_positive;
ALTER TABLE tournament_pairs
  ADD CONSTRAINT tournament_pairs_group_number_positive
    CHECK (group_number IS NULL OR group_number >= 1);

COMMENT ON COLUMN tournament_participants.group_number IS
  'Which group (1-based) this entrant plays in during a group stage. NULL for an ordinary round robin or a knockout. Assigned serpentine by seed so the strong entrants are spread across the groups, and hand-adjustable by an exec until the matches are generated.';
COMMENT ON COLUMN tournament_pairs.group_number IS
  'Which group (1-based) this pair plays in during a group stage. NULL for an ordinary round robin or a knockout. See tournament_participants.group_number.';

-- Partial, because these indexes exist for the group-stage reads only — the
-- standings partition and the per-group fixture generation — and every row that
-- exists today has a NULL here.
CREATE INDEX IF NOT EXISTS idx_tournament_participants_group
  ON tournament_participants(event_id, group_number)
  WHERE group_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tournament_pairs_group
  ON tournament_pairs(event_id, group_number)
  WHERE group_number IS NOT NULL;

-- ============================================================
-- If a CREATE or ALTER above failed, these show what it found
-- ============================================================
-- SELECT id, format, group_count, qualifiers_per_group
--   FROM tournament_events
--  WHERE group_count IS NOT NULL;
--
-- SELECT event_id, group_number, count(*)
--   FROM tournament_participants
--  WHERE group_number IS NOT NULL
--  GROUP BY 1, 2 ORDER BY 1, 2;
