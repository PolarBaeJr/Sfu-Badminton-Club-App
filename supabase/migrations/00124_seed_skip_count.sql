-- ============================================================
-- 00124_seed_skip_count.sql — how many top seeds must skip the first round
-- ============================================================
-- "just give us a option to setup a seed amount skip". An exec sets a number N
-- on a knockout event and the top N seeds skip round one — they enter at round
-- two with a bye.
--
-- ------------------------------------------------------------
-- THIS COLUMN DOES NOT MOVE A SINGLE BYE. READ THIS BEFORE "FIXING" ANYTHING.
-- ------------------------------------------------------------
--
-- The obvious reading of the column name is that the generator consults it and
-- places N byes. It does not, it cannot, and a future reader who "restores"
-- that behaviour will break the draw. The reason is arithmetic, and it is worth
-- writing out once, here, where it cannot drift away from the code:
--
--   1. A bracket holds B slots and B is a power of two. A field of E entrants
--      leaves B - E slots empty, and an empty slot facing a real entrant IS a
--      bye. Byes are therefore not created, they are left over.
--
--   2. getStandardSeedPositions pairs draw-rank r against rank B + 1 - r in
--      round one (a bracket of 8 is [1,8,4,5,2,7,3,6]), and the generator seats
--      `entries` — already sorted best-first — by rank, so the EMPTY ranks are
--      always the tail E+1..B. Rank r therefore holds a bye exactly when
--      B + 1 - r > E, i.e. when r <= B - E. The byes already go to the top
--      B - E seeds, in seed order, and always have. drawWithinTiers shuffles
--      entrants within an index range rather than permuting rank-slots
--      precisely so that this stays true through a redraw.
--
--   3. A round-one match with BOTH slots empty is not a match — it would sit
--      pending forever with nobody in it — so a legal draw needs
--      B - E <= B / 2, i.e. B <= 2E.
--
--   4. Combine: B must be a power of two in [E, 2E]. For a field that is not
--      itself a power of two there is EXACTLY ONE such number, nextPowerOf2(E).
--      For a field that is a power of two there are two, and the second (B = 2E)
--      makes every single round-one match a bye — a phantom round in which
--      nobody plays. That is not a draw.
--
-- So the number of byes is a function of the field size alone. Nobody chooses
-- it. 100 entrants in a 128 draw is 28 byes for the top 28 seeds whether or not
-- anybody asked, and a field of 16 cannot give ANY seed a bye — 14 players
-- producing 7 winners plus 2 skippers is 9 entrants for an 8-slot round two,
-- which is why the honest version of "the top 2 skip a 16-strong field" is a
-- qualifying draw, and a qualifying draw is exactly what the club asked us not
-- to build.
--
-- WHAT THIS COLUMN IS, THEN: the promise, recorded, so the generator can refuse
-- to break it. N is a FLOOR — "at least the top N seeds must skip round one".
-- Generation computes the byes the field forces and refuses if there are fewer
-- than N, naming the number the field can actually deliver. It never refuses a
-- field that forces MORE than N: the surplus goes to seeds N+1, N+2, ... in
-- seed order, which is the standard convention and is what already happens.
--
-- WHY A FLOOR AND NOT AN EXACT COUNT. This is set when the event is created, at
-- which point nobody has entered and E is unknown. "Exactly N" would refuse
-- every field whose forced byes are not precisely N — which is nearly all of
-- them — so the exec would be betting on the final headcount landing on one
-- specific value. A floor degrades: it only ever refuses when the promise
-- genuinely cannot be kept.
--
-- ------------------------------------------------------------
-- NOT NULL DEFAULT 0, WHERE group_count IS NULLABLE
-- ------------------------------------------------------------
--
-- 00106 made group_count nullable because NULL and 1 mean different things
-- there in intent even if not in effect ("I did not think about groups" versus
-- "one pool, deliberately"). Here they do not: zero seeds skipping and no
-- opinion about seeds skipping are the same event, played the same way. So the
-- column is NOT NULL DEFAULT 0 and every reader is spared a coalesce, and the
-- default is exactly today's behaviour — the generator's floor check is `skip >
-- byes`, which 0 can never trip.
--
-- ------------------------------------------------------------
-- THE BOUNDS
-- ------------------------------------------------------------
--
-- The REAL ceiling is nextPowerOf2(E) - E and it depends on the field, which
-- this row cannot see and which does not exist yet when the number is set. Same
-- position 00106 was in with qualifiers_per_group, and the same answer: the
-- CHECK bounds it against the ceiling the schema can know, and the generator
-- refuses the rest on the day, when E is real.
--
-- 64 is that schema-level ceiling. Reaching it needs a 192-strong field in a
-- 256 draw (256 - 192 = 64); a club event is an order of magnitude smaller, so
-- anything above it is a typo rather than an intention.
--
-- A ROUND ROBIN HAS NO FIRST ROUND TO SKIP, so a row-level CHECK pins it —
-- exactly as tournament_events_groups_are_round_robin pins the mirror-image
-- rule for groups. pool_to_bracket is allowed: its knockout half is a bracket
-- like any other, drawn from the pool's finishing order, and its qualifiers can
-- be a number that leaves byes just as a registration field can.

ALTER TABLE tournament_events
  ADD COLUMN IF NOT EXISTS seed_skip_count INTEGER NOT NULL DEFAULT 0;

-- Named, and dropped first, so re-running this migration on a database that
-- already has the column is a no-op rather than a duplicate-constraint error.
ALTER TABLE tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_seed_skip_count_sane;
ALTER TABLE tournament_events
  ADD CONSTRAINT tournament_events_seed_skip_count_sane CHECK (
    seed_skip_count BETWEEN 0 AND 64
  );

ALTER TABLE tournament_events
  DROP CONSTRAINT IF EXISTS tournament_events_seed_skip_needs_a_bracket;
ALTER TABLE tournament_events
  ADD CONSTRAINT tournament_events_seed_skip_needs_a_bracket CHECK (
    seed_skip_count = 0 OR format <> 'round_robin'
  );

COMMENT ON COLUMN tournament_events.seed_skip_count IS
  'How many of the top seeds must skip the first round of this event''s knockout, entering at round two with a bye. A FLOOR, not a placement instruction: the number of byes in a bracket is fixed by the field size (bracket size is nextPowerOf2(entrants), the empty slots are the tail, and the standard seeding positions hand them to the top seeds in seed order), so this column never moves a bye. It is the promise the exec made, recorded so generateSingleEliminationBracket can refuse to build a draw that gives fewer than this many seeds a bye — with the number the field CAN deliver, nextPowerOf2(entrants) - entrants, in the refusal. 0 (the default and the pre-00124 behaviour) means no promise and nothing is checked. Must be 0 on format = round_robin, which has no bracket. Frozen once the event has matches, by the same updateTournamentEvent gate that freezes the match format.';

-- ============================================================
-- If an ALTER above failed, these show what it found
-- ============================================================
-- Rows that would violate the bounds check:
-- SELECT id, format, seed_skip_count
--   FROM tournament_events
--  WHERE seed_skip_count < 0 OR seed_skip_count > 64;
--
-- Rows that would violate the round-robin check:
-- SELECT id, format, seed_skip_count
--   FROM tournament_events
--  WHERE seed_skip_count <> 0 AND format = 'round_robin';
--
-- Both must be empty on a database that has only ever run the application:
-- the column is new, so every existing row takes the default of 0.
