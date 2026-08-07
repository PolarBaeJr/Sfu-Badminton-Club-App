-- ============================================================
-- 00080 — a third-place playoff between the two semi-final losers
--
-- Single elimination ended at the final, so the two semi-final losers both
-- finished joint 3rd (finalizeEvent gives every loser 2^roundsFromFinal + 1,
-- which is 3 for both of them) and there was no way to play the match off.
--
-- Three columns, and every one of them earns its place:
--
--   loser_to_match_id / loser_to_position
--       The exact mirror of winner_to_match_id / winner_to_position, which the
--       bracket has always used to route a winner forward. A third-place match
--       is fed by LOSERS, and routing them with a second, bespoke mechanism —
--       "if this match feeds the final, and the event has a third-place match,
--       then..." — would give the bracket two different ideas of what a
--       downstream match is. The corrective actions all key off "does this match
--       feed anything decided?", and a route they cannot see is a route they
--       cannot protect: voiding a semi-final would strand its loser in a
--       third-place match that had already been played.
--
--       Generic on purpose rather than named `third_place_match_id`. Nothing in
--       here knows what a third-place match is; it knows that a loser can have
--       somewhere to go, which is also true of a consolation bracket if one is
--       ever added.
--
--   is_third_place
--       The marker finalizeEvent and the bracket UI read. It cannot be inferred
--       safely from "two matches route their losers here": that shape is also a
--       consolation semi-final, and finalizeEvent would then hand out 3rd and
--       4th for a match that decides neither.
--
-- NOT ADDED: a matching flag on tournament_events. The generated matches ARE the
-- record of what was chosen — the exec ticks a box next to Generate Bracket and
-- the flag is a parameter to that one call. A second column saying "this event
-- has a third-place match" could disagree with whether one actually exists, and
-- this module's entire defect history is a stored summary disagreeing with the
-- rows it summarises.
--
-- NO ON DELETE CLAUSE, matching winner_to_match_id. Regenerating a draw deletes
-- every match for the event in ONE statement, and a NO ACTION self-reference is
-- checked at the end of the statement, so deleting the referencing and
-- referenced rows together is already legal — that is how winner_to_match_id has
-- always survived regeneration. Adding ON DELETE SET NULL here would make the
-- two columns behave differently for no reason.
--
-- Forward-only and re-runnable: every statement is IF NOT EXISTS or guarded.
-- ============================================================


-- ------------------------------------------------------------
-- Where a match's LOSER goes
-- ------------------------------------------------------------
ALTER TABLE public.tournament_matches
  ADD COLUMN IF NOT EXISTS loser_to_match_id uuid REFERENCES public.tournament_matches(id),
  ADD COLUMN IF NOT EXISTS loser_to_position text,
  ADD COLUMN IF NOT EXISTS is_third_place boolean NOT NULL DEFAULT false;

-- Same domain winner_to_position has. Written as a separate guarded statement
-- because ADD COLUMN IF NOT EXISTS does not re-apply an inline CHECK on a replay
-- where the column already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tournament_matches'::regclass
      AND conname = 'tournament_matches_loser_to_position_check'
  ) THEN
    ALTER TABLE public.tournament_matches
      ADD CONSTRAINT tournament_matches_loser_to_position_check
      CHECK (loser_to_position IN ('a', 'b'));
  END IF;
END
$$;

-- Both halves of the route, or neither. A match_id with no position would be
-- routed to a side chosen by whatever the reading code defaults to — the app
-- reads `loser_to_position === 'a' ? ... : ...`, so a NULL position silently
-- means side B, which is a coin flip dressed up as a rule. winner_to_* has no
-- such constraint and predates this reasoning; the new pair does not have to
-- inherit the omission.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tournament_matches'::regclass
      AND conname = 'tournament_matches_loser_route_complete'
  ) THEN
    ALTER TABLE public.tournament_matches
      ADD CONSTRAINT tournament_matches_loser_route_complete
      CHECK ((loser_to_match_id IS NULL) = (loser_to_position IS NULL));
  END IF;
END
$$;

-- One third-place match per event, enforced rather than assumed. Generation
-- deletes every match for the event before rebuilding, so a duplicate needs a
-- half-failed regeneration to appear — and then finalizeEvent would read one of
-- the two arbitrarily and award 3rd/4th from a match that may not be the played
-- one. A partial index: the ordinary bracket matches are all is_third_place
-- false and must stay unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS tournament_matches_one_third_place_per_event
  ON public.tournament_matches (event_id)
  WHERE is_third_place;

-- The reverse lookup the corrective actions need: "which match does this one
-- feed with its loser" is read off the row itself, but clearing a stranded
-- entry walks the other way.
CREATE INDEX IF NOT EXISTS tournament_matches_loser_to_match_id_idx
  ON public.tournament_matches (loser_to_match_id)
  WHERE loser_to_match_id IS NOT NULL;

COMMENT ON COLUMN public.tournament_matches.loser_to_match_id IS
  'Where this match''s LOSER goes, mirroring winner_to_match_id. Set on both semi-finals when an event is generated with a third-place playoff; NULL everywhere else.';
COMMENT ON COLUMN public.tournament_matches.loser_to_position IS
  'Which side of loser_to_match_id the loser occupies. NULL exactly when loser_to_match_id is NULL.';
COMMENT ON COLUMN public.tournament_matches.is_third_place IS
  'This match decides 3rd vs 4th. It has no winner_to_match_id — it feeds nothing — and finalizeEvent reads it to award positions 3 and 4 instead of the joint 3rd both semi-final losers would otherwise get.';
