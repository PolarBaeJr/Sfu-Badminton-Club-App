-- ============================================================
-- 00108_per_round_match_shape.sql — a draw whose rounds are played to
-- different lengths
-- ============================================================
-- HOW THE CLUB ACTUALLY PLAYS, in the owner's words: "we play round robin 11s
-- then play single elim first round 11s, quarter 15s semis 21s finals and third
-- place games best to 3 21s". Short games while there are many bodies and few
-- courts, longer as the field narrows, full best-of-3 for the final.
--
-- There was no way to express it. match_format / games_per_match /
-- points_per_game live on tournament_events and NOWHERE else, so every match in
-- a draw is played to one shape. tournament_matches has round_number,
-- round_name and bracket_position and no format column at all.
--
-- ------------------------------------------------------------
-- 1. THREE NULLABLE COLUMNS, FALLING BACK TO THE EVENT
-- ------------------------------------------------------------
--
-- 00046's precedent exactly: nullable columns where NULL means "as before". The
-- resolution chain becomes
--
--     match.<col>  ->  event.<col>  ->  the enum preset
--
-- with the event remaining the last resort, so every event and every match that
-- exists today keeps its exact current meaning: all three columns are NULL on
-- every existing row, so every existing match resolves to precisely the event
-- shape it resolves to now.
--
-- PER FIELD, NOT ALL-OR-NOTHING, because that is already how the layer below
-- behaves — getRulesFor (packages/shared) takes points_per_game ?? preset.target
-- and games_per_match ?? preset.bestOf independently, and effective_target /
-- effective_best_of in 00031 do the same in SQL. A fourth composition rule at
-- this level would be a second way for the two engines to disagree.
--
-- ------------------------------------------------------------
-- 2. WHY NOT A PLAN ON THE EVENT
-- ------------------------------------------------------------
--
-- The obvious alternative is a jsonb `round_formats` on tournament_events —
-- {"1":"11","2":"15",...} — read when a score is judged. It was rejected for
-- the reason 00080 gives for not storing "this event has a third-place match":
-- a stored summary can disagree with the rows it summarises, and this module's
-- whole defect history is exactly that. A plan keyed by round number would go
-- stale the moment a draw was regenerated at a different size — round 2 of a
-- 16-draw is the round of 8, round 2 of an 8-draw is the semi-final — and the
-- disagreement would show up as a score being accepted or refused by the wrong
-- rule, silently, on the day.
--
-- The MATCH is the record. The default ladder is computed at generation and
-- stamped onto the rows it applies to; changing a round afterwards writes the
-- rows again. There is nothing else to be out of step with.
--
-- ------------------------------------------------------------
-- 3. THE THIRD-PLACE PLAYOFF NEEDS ITS OWN ANSWER
-- ------------------------------------------------------------
--
-- It shares round_number with the final (00080) and is held out of the round
-- sequence by every index and every reader — 00081's uniqueness guard is
-- WHERE NOT is_third_place for that reason. Because the shape lives on the
-- MATCH ROW rather than in a plan keyed by round number, the playoff simply
-- carries its own values like any other match and needs no key of its own. Had
-- the plan lived on the event keyed by round, the playoff would have had no key
-- and would have fallen back to the event default — the wrong answer, and an
-- invisible one. It is generated with the FINAL's shape.
--
-- ------------------------------------------------------------
-- 4. SAFE ON A LIVE TABLE
-- ------------------------------------------------------------
-- Three nullable ADD COLUMN with no DEFAULT — catalogue-only in PG 11+ — and
-- two CHECKs over data that satisfies them vacuously (every existing row is
-- NULL in all three). The bounds are 00046's, character for character, because
-- a match may not be given a shape an event could not have been given.
-- ============================================================

BEGIN;

ALTER TABLE public.tournament_matches
  ADD COLUMN IF NOT EXISTS match_format TEXT,
  ADD COLUMN IF NOT EXISTS games_per_match INTEGER,
  ADD COLUMN IF NOT EXISTS points_per_game INTEGER;

-- Same four presets tournament_events.match_format allows, plus NULL for
-- "whatever the event says". Written as a dropped-and-recreated constraint
-- rather than inline, because ADD COLUMN IF NOT EXISTS does not re-apply an
-- inline CHECK on a replay where the column already exists (00080).
ALTER TABLE public.tournament_matches
  DROP CONSTRAINT IF EXISTS tournament_matches_match_format_check;
ALTER TABLE public.tournament_matches
  ADD CONSTRAINT tournament_matches_match_format_check CHECK (
    match_format IS NULL
    OR match_format IN ('best_of_3_to_21', 'one_game_21', 'one_game_15', 'one_game_11')
  );

-- 00046's bounds verbatim: an odd best-of between 1 and 7 (an even best-of
-- cannot be decided) and a target between 5 and 30.
ALTER TABLE public.tournament_matches
  DROP CONSTRAINT IF EXISTS tournament_matches_typed_format_sane;
ALTER TABLE public.tournament_matches
  ADD CONSTRAINT tournament_matches_typed_format_sane CHECK (
    (games_per_match IS NULL OR (games_per_match BETWEEN 1 AND 7 AND games_per_match % 2 = 1))
    AND (points_per_game IS NULL OR (points_per_game BETWEEN 5 AND 30))
  );

COMMENT ON COLUMN public.tournament_matches.match_format IS
  'This match''s own format preset, overriding the event''s. NULL — every row before 00108 — means the event decides, which is the behaviour this column replaces nothing of.';
COMMENT ON COLUMN public.tournament_matches.games_per_match IS
  'This match''s own best-of, overriding tournament_events.games_per_match. NULL falls back to the event and then to the preset, exactly as 00046''s event columns fall back to the enum. Stamped by draw generation from the round ladder (round 1 to 11, quarter-final to 15, semi-final to 21, final and third-place playoff best of 3 to 21) and editable per round afterwards while that round has no result.';
COMMENT ON COLUMN public.tournament_matches.points_per_game IS
  'This match''s own target score. See tournament_matches.games_per_match. The pair is what makes a first-round game to 11 rate less than a best-of-3 final: the Elo weight is derived from the RESOLVED shape (derivedFormatWeight), so a shorter match moves ratings less without any new setting.';

COMMIT;

-- ============================================================
-- If a statement above failed, this shows what it found
-- ============================================================
-- SELECT id, event_id, round_number, match_format, games_per_match, points_per_game
--   FROM tournament_matches
--  WHERE match_format IS NOT NULL
--     OR games_per_match IS NOT NULL
--     OR points_per_game IS NOT NULL;
