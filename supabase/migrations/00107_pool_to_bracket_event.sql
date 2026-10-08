-- ============================================================
-- 00107_pool_to_bracket_event.sql — one event that plays a pool, then a knockout
-- ============================================================
-- THE FORMAT THE CLUB ACTUALLY RUNS. 00046 built pool-then-bracket as TWO
-- events linked by seeded_from_event_id, and 00106 added groups inside the pool
-- half. That path works, is deployed, and is NOT touched here. What it costs is
-- exactly the thing the club owner complained about: two rows in the tournament
-- list for one afternoon, two entry lists, and — the part he named — a SECOND
-- CHECK-IN for people who are standing on the court having just finished the
-- pool. "seeding shouldn't require a new checkin".
--
-- So this adds a THIRD format in which both phases live in ONE event row. The
-- entrants are the same tournament_participants / tournament_pairs rows
-- throughout: qualifying is re-seeding rows that are already there, not copying
-- them into another event. Nothing is promoted, nothing is duplicated, nobody
-- checks in twice.
--
-- ------------------------------------------------------------
-- 1. WHY THIS ONE *IS* A NEW format VALUE, WHEN 00106'S WAS NOT
-- ------------------------------------------------------------
--
-- 00106 argued at length for NOT adding a format value, and that argument was
-- right for what it was doing: a group stage IS a round robin — same generator,
-- same standings, same points rule — merely partitioned, so every
-- `format === 'round_robin'` branch in the console kept taking the correct arm.
--
-- None of that holds here. A pool-then-knockout event needs the round-robin
-- generator AND the knockout generator, the round-robin standings AND the
-- bracket placement rule, and a status path with two "draw made / draw running"
-- pairs in it rather than one. There is no existing value it can wear without
-- lying to half the branches that read it. Every branch has therefore been
-- enumerated and given an explicit arm — see the audit in the branch that
-- carries this migration.
--
-- ------------------------------------------------------------
-- 2. THE PHASE DISCRIMINATOR, AND WHY THE INDEX USES COALESCE
-- ------------------------------------------------------------
--
-- 00081 put a UNIQUE index on
--     (event_id, round_number, bracket_position) WHERE NOT is_third_place
-- to stop two racing generators leaving a fragmented draw. With a pool AND a
-- bracket inside ONE event, pool round 1 position 0 and knockout round 1
-- position 0 are different matches with identical keys — so the second
-- generation would die of a unique violation PART-WAY THROUGH, after some
-- matches were already inserted, on the day. That is the failure this migration
-- exists to prevent, and it is not avoidable by renumbering: offsetting the
-- knockout's rounds past the pool's would make round_number stop meaning
-- "round", and every reader that groups by it — the event page, the round-robin
-- tab, the bracket's own round labels — would have to learn the offset.
--
-- So the matches carry which PHASE they belong to, and the index accounts for
-- it. `phase` is nullable and NULL means "this event has only one phase", which
-- is every row that exists today and every row any single_elimination or
-- round_robin event will ever write. No backfill, no rewrite, no change of
-- meaning for a single existing match.
--
-- THE INDEX CANNOT SIMPLY LIST phase AS A FOURTH COLUMN. In a Postgres UNIQUE
-- index NULLs are DISTINCT from each other, so
--     UNIQUE (event_id, phase, round_number, bracket_position)
-- would stop constraining every row whose phase is NULL — which is all of them.
-- The guard 00081 added would be silently deleted by the migration that claims
-- to extend it. COALESCE(phase, '') collapses the NULLs to one non-null value,
-- so existing rows are constrained exactly as they are today and the two phases
-- of a new event are constrained separately. COALESCE on text is IMMUTABLE, so
-- it is indexable.
--
-- (`tournament_matches_one_third_place_per_event` from 00080 is
--  UNIQUE (event_id) WHERE is_third_place and needs no change: a pool-to-bracket
--  event still has exactly one bracket phase, so still at most one playoff.)
--
-- ------------------------------------------------------------
-- 3. THE STATUS MACHINE — TWO NEW STATES, AND NO EXISTING ONE REDEFINED
-- ------------------------------------------------------------
--
-- Today: registration -> checkin -> bracket_generated -> live -> completed,
-- and setEventStatus's table is deliberately forward-only.
--
-- This format needs the pool to be generated, played and finished BEFORE a
-- bracket exists, and then needs "draw made" and "draw running" a second time
-- for the knockout. Reusing bracket_generated/live for the pool half would put
-- the same two states twice in one path — the machine stops being a forward-only
-- DAG, "live" stops answering "which phase is running", and every existing
-- reader of `live` (the player app's "under way", the redraw control, the result
-- guards) would silently start covering the pool as well.
--
-- So the pool half gets its OWN two states and the knockout half keeps the
-- existing ones with their existing meanings:
--
--   registration -> checkin -> pool_generated -> pool_live
--                -> bracket_generated -> live -> completed
--
--   pool_generated  the pool fixtures exist and nothing has started
--   pool_live       the pool is being played
--   bracket_generated  the KNOCKOUT draw exists — unchanged meaning
--   live               the KNOCKOUT is running — unchanged meaning
--
-- Two is the minimum: one new state cannot express both "pool drawn, not
-- started" and "pool running" without reusing a knockout state for a pool.
-- Neither new value can appear on a single_elimination or round_robin event —
-- nothing writes them there — so those two formats' machines are untouched.
--
-- ------------------------------------------------------------
-- 4. SAFE ON A LIVE TABLE
-- ------------------------------------------------------------
-- One nullable ADD COLUMN with no DEFAULT (catalogue-only in PG 11+), two CHECK
-- widenings (a widened CHECK is satisfied by every row that satisfied the old
-- one, so validation finds nothing to reject), and an index swap on
-- tournament_matches. The index is dropped and recreated rather than added
-- alongside, because leaving the old one would keep refusing the very rows this
-- migration exists to allow.
--
-- THE INDEX SWAP IS THE ONE STATEMENT WITH A WINDOW IN IT. Between the DROP and
-- the CREATE there is no uniqueness guard on draw positions. It is a
-- sub-second window inside one transaction on a table with a few thousand rows,
-- and the CREATE is not CONCURRENTLY precisely so it stays inside that
-- transaction — a failure rolls back to the old index rather than leaving the
-- table unguarded. Do not split this file across transactions.
--
-- 00108 follows this one and adds the per-round match shape. It keys off the
-- same `phase` column added here.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- The format
-- ------------------------------------------------------------

ALTER TABLE public.tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_format_check;
ALTER TABLE public.tournament_events
  ADD CONSTRAINT tournament_events_format_check
  CHECK (format IN ('single_elimination', 'round_robin', 'pool_to_bracket'));

COMMENT ON COLUMN public.tournament_events.format IS
  'single_elimination: one knockout draw. round_robin: everybody plays everybody, optionally split into groups (00106). pool_to_bracket (00107): BOTH, in this one event — a round robin (optionally grouped) is played first, then the qualifiers are re-seeded into a knockout without leaving the event. The matches of the two halves are told apart by tournament_matches.phase.';

-- ------------------------------------------------------------
-- The two extra statuses
-- ------------------------------------------------------------

ALTER TABLE public.tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_status_check;
ALTER TABLE public.tournament_events
  ADD CONSTRAINT tournament_events_status_check
  CHECK (status IN (
    'registration', 'checkin',
    'pool_generated', 'pool_live',
    'bracket_generated', 'live', 'completed'
  ));

COMMENT ON COLUMN public.tournament_events.status IS
  'registration -> checkin -> bracket_generated -> live -> completed for single_elimination and round_robin, unchanged. A pool_to_bracket event inserts its pool half in the middle: registration -> checkin -> pool_generated -> pool_live -> bracket_generated -> live -> completed. pool_generated and pool_live are written only on that format; bracket_generated and live keep their exact existing meanings (the KNOCKOUT is drawn / running).';

-- ------------------------------------------------------------
-- Groups compose with the new format
-- ------------------------------------------------------------
--
-- 00106 refused a group count on anything but a round robin because a knockout
-- cannot be partitioned. A pool_to_bracket event's POOL half is a round robin,
-- so it can be — and it is the case the format is most worth having for: four
-- groups of six, then the top two of each into a bracket, in one event.
ALTER TABLE public.tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_groups_are_round_robin;
ALTER TABLE public.tournament_events
  ADD CONSTRAINT tournament_events_groups_are_round_robin CHECK (
    group_count IS NULL OR group_count <= 1
    OR format IN ('round_robin', 'pool_to_bracket')
  );

COMMENT ON COLUMN public.tournament_events.qualifiers_per_group IS
  'How many of each group advance to the knockout. On a round_robin this is read by the SEPARATE knockout event that seeds from it (00046/00106). On a pool_to_bracket event it is read by this event''s own bracket phase, and a flat pool (group_count NULL or 1) is exactly one group — so the same column reads as "how many qualify" with no second column to disagree with it. NULL behaves as 2 for a group stage; the application defaults a flat pool_to_bracket pool to 4.';

-- ------------------------------------------------------------
-- Which phase a match belongs to
-- ------------------------------------------------------------

ALTER TABLE public.tournament_matches
  ADD COLUMN IF NOT EXISTS phase TEXT;

-- Separate guarded statement, same reason 00080 gives: ADD COLUMN IF NOT EXISTS
-- does not re-apply an inline CHECK on a replay where the column already exists.
ALTER TABLE public.tournament_matches
  DROP CONSTRAINT IF EXISTS tournament_matches_phase_check;
ALTER TABLE public.tournament_matches
  ADD CONSTRAINT tournament_matches_phase_check
  CHECK (phase IS NULL OR phase IN ('pool', 'bracket'));

COMMENT ON COLUMN public.tournament_matches.phase IS
  'Which half of a pool_to_bracket event this match belongs to. NULL on every match of a single_elimination or round_robin event — those have one phase, so naming it would add a value nothing reads. Never NULL inside a pool_to_bracket event: the generators always write it. The third-place playoff is a bracket-phase match.';

-- Partial: this index exists for the phase-filtered reads a pool_to_bracket
-- event makes (tally the pool, place the bracket, delete one half and rebuild
-- it), and every row that exists today has a NULL here.
CREATE INDEX IF NOT EXISTS idx_tournament_matches_phase
  ON public.tournament_matches (event_id, phase)
  WHERE phase IS NOT NULL;

-- ------------------------------------------------------------
-- One match per position in a draw — now per PHASE
-- ------------------------------------------------------------
--
-- See note 2 above for why this is COALESCE(phase, '') and not a bare `phase`
-- column in the index. Existing rows all have phase NULL, so for them this is
-- byte-for-byte the same constraint 00081 created: if 00081's index applies to
-- production today, this one applies to production today.
DROP INDEX IF EXISTS public.tournament_matches_draw_position_idx;
CREATE UNIQUE INDEX tournament_matches_draw_position_idx
  ON public.tournament_matches (event_id, COALESCE(phase, ''), round_number, bracket_position)
  WHERE NOT is_third_place;

COMMIT;

-- ============================================================
-- If a statement above failed, these show what it found
-- ============================================================
-- Any event already carrying a value the widened CHECKs would not accept:
-- SELECT id, format, status FROM tournament_events
--  WHERE format NOT IN ('single_elimination','round_robin','pool_to_bracket')
--     OR status NOT IN ('registration','checkin','pool_generated','pool_live',
--                       'bracket_generated','live','completed');
--
-- Duplicate draw positions, which is the only thing that can fail the CREATE
-- UNIQUE INDEX (and would equally have failed 00081's):
-- SELECT event_id, COALESCE(phase,'') AS phase, round_number, bracket_position, count(*)
--   FROM tournament_matches
--  WHERE NOT is_third_place
--  GROUP BY 1, 2, 3, 4
-- HAVING count(*) > 1;
