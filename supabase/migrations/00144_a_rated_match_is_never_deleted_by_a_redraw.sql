-- ============================================================
-- 00144 — a redraw deletes the whole phase or none of it, and it can never
--         take a rating with it
-- ============================================================
-- ONE NEW FUNCTION. NO TABLE IS ALTERED, no column is added, no constraint is
-- changed, no trigger is created and no existing function is touched. Safe to
-- run at any time, in any order, repeatedly: CREATE OR REPLACE plus idempotent
-- REVOKE/GRANT/COMMENT/NOTIFY. Applying it changes nothing until the admin app
-- that calls it is deployed; the old code path keeps working meanwhile.
--
-- ------------------------------------------------------------
-- WHAT IS BROKEN
-- ------------------------------------------------------------
-- Regenerating a draw is two separate statements issued dozens of PostgREST
-- round trips apart:
--
--   apps/admin/src/lib/tournament-actions/brackets.ts:91  assertNoResultsEntered
--       SELECT count(*) FROM tournament_matches WHERE event_id = ...
--                                                 AND status IN (...)
--
--   apps/admin/src/lib/tournament-actions/brackets.ts:190 deletePhaseMatches
--       DELETE FROM tournament_matches WHERE event_id = ...
--
-- Between them sit assertNobodyLeftUnpaired, the whole field read,
-- buildFieldFromPool/buildFieldFromOwnPool (4-6 round trips of their own), the
-- seeding computation and one seed_number UPDATE per entrant. On a 32-entry
-- draw that is 40+ sequential round trips — several seconds of wall clock in
-- which the guard's answer is simply out of date.
--
-- THE DELETE HAS NO PREDICATE AT ALL. Whatever the guard saw, the DELETE takes
-- every match row of the phase.
--
-- Two distinct harms come out of that, and they need different preconditions.
--
-- (a) NO RACE IS REQUIRED. A match that is ON COURT RIGHT NOW does not block a
--     redraw. RESULT_MATCH_STATUSES (packages/shared/src/utils/
--     tournament-withdrawal.ts:69) is ('completed','walkover','disputed') and
--     excludes 'live', so isPlayedMatch counts a live match as zero: the
--     Regenerate button is not greyed and assertNoResultsEntered returns 0. An
--     exec who redraws while three matches are being played deletes those three
--     matches, their court assignments and every set_match_ready mark, from
--     under the people playing them, and nothing anywhere says so. This needs
--     no concurrency — just an exec who does not know that 'live' is not a
--     result.
--
-- (b) A RACE LOSES A RATING, PERMANENTLY. Exec A presses Regenerate; the guard
--     reads 0. Exec B, on the Court Management tab, enters the score for match
--     M. enterMatchResultImpl is a correct compare-and-set, so it lands: M goes
--     'completed', apply_tournament_match_rating commits an elo_snapshot on M
--     and moves both players' ratings. Exec A's DELETE then removes M.
--
--     BOTH PLAYERS KEEP THE DELTA AND NOTHING CAN TAKE IT BACK.
--     reverse_tournament_match_rating reads the deltas off
--     tournament_matches.elo_snapshot (00078), and that row is now gone. The
--     snapshot WAS the only record of what was applied. There is no compensating
--     path, no reconstruction from tournament_participants.elo_change (which is
--     an accumulator, 00083), and no error: exec B is told the result saved (it
--     did), exec A is told the draw regenerated (it did), and the ladder is
--     quietly wrong for the rest of the season.
--
--     00139 did not create this. The DELETE was always unpredicated. What 00139
--     changed is that tournament_audit_log's FK is now ON DELETE SET NULL, so
--     the delete no longer errors on the audit row — the failure went from loud
--     to silent.
--
-- ------------------------------------------------------------
-- WHY THE OBVIOUS FIXES ARE NOT AVAILABLE
-- ------------------------------------------------------------
-- ADDING A PREDICATE TO THE DELETE DOES NOT WORK. Deleting the unplayed matches
-- and leaving the played one behind produces an incoherent half-draw: a bracket
-- with one orphan match, no feeders, and a winner routed into a slot that no
-- longer exists. The operation is all-or-nothing by nature, so the invariant has
-- to be "refuse the whole thing", which a WHERE clause cannot express.
--
-- MOVING THE COUNT INTO THE SAME FUNCTION AS THE DELETE DOES NOT WORK EITHER,
-- and this is the trap worth spelling out because it looks like the fix.
--
--     SELECT count(*) ... INTO v_played;      -- statement 1
--     IF v_played > 0 THEN RAISE ...; END IF;
--     DELETE FROM tournament_matches ...;     -- statement 2
--
-- Under READ COMMITTED — the default, and what PostgREST uses — EVERY STATEMENT
-- TAKES ITS OWN SNAPSHOT. A rating applied between statement 1 and statement 2
-- is invisible to the count and fully visible to the delete, so the exact same
-- race survives; it is merely microseconds wide instead of seconds wide. And an
-- advisory lock does not close it either: apply_tournament_match_rating and
-- reverse_tournament_match_rating take only `SELECT ... FOR UPDATE` on the match
-- row (00078) and never touch this event's advisory lock, so holding the lock
-- excludes the pairing RPCs and nothing else.
--
-- A narrower race is not a fixed race. This one destroys ratings.
--
-- ------------------------------------------------------------
-- WHAT THIS FUNCTION DOES INSTEAD — THE DELETE IS ITS OWN GUARD
-- ------------------------------------------------------------
-- The check and the delete are ONE STATEMENT: a data-modifying CTE that deletes
-- the phase, RETURNS the rows it deleted, counts the ones that must not have
-- been deleted, and RAISES — rolling the delete back — if there were any.
--
-- That is airtight, for two reasons that are worth stating rather than trusted:
--
--   1. THE DELETE TAKES THE ROW LOCKS. A rating apply that is in flight when the
--      DELETE arrives holds `FOR UPDATE` on the match row, so the DELETE BLOCKS.
--      When that transaction commits, Postgres re-evaluates the row under
--      EvalPlanQual and deletes the NEW version, so RETURNING yields the
--      freshly-written elo_snapshot and this function refuses. There is no
--      window in which the count and the delete can disagree, because there is
--      only one snapshot.
--
--   2. THE LOSING SIDE FAILS LOUDLY, NOT SILENTLY. A rating apply that arrives
--      AFTER an uncommitted delete blocks on the vanished row and then raises
--      'Tournament match not found' from 00078's own NOT FOUND branch — and if
--      this function has meanwhile refused and rolled back, the row is still
--      there and the rating applies normally. Likewise enterMatchResultImpl's
--      compare-and-set (results.ts:386) matches zero rows against a committed
--      delete and returns its own stale-row refusal. Every interleaving ends in
--      either a clean refusal or a clean success. None ends in a lost delta.
--
-- ------------------------------------------------------------
-- WHAT BLOCKS A REDRAW, AND WHY EACH ONE
-- ------------------------------------------------------------
-- 1. A RESULT — status IN ('completed','walkover','disputed'), is_bye IS NOT
--    TRUE. This is assertNoResultsEntered's rule and RESULT_MATCH_STATUSES'
--    membership, restated here so the two cannot drift apart silently. A
--    walkover counts: it is rated (recordWalkover -> applyTournamentMatchElo).
--
--    `is_bye IS NOT TRUE` and NOT `is_bye <> true`, because the column is
--    nullable (00001: BOOLEAN DEFAULT false) and under three-valued logic
--    `<> true` is UNKNOWN against NULL — which would drop every NULL row and
--    leave the guard permanently satisfied. This is the same null-safety the
--    PostgREST guard spells as `.not('is_bye','is',true)`.
--
--    A BYE IS NOT A RESULT. Generation writes status 'completed' onto every bye
--    because it is already decided, and it has no score, no opponent and no
--    Elo. Counting byes here would make every draw whose field is not a power
--    of two permanently unregenerable — the defect brackets.ts:64 records at
--    length.
--
-- 2. AN APPLIED RATING — elo_snapshot IS NOT NULL, whatever the status says.
--    THIS IS THE CLAUSE THE WHOLE FILE EXISTS FOR, and it is deliberately not
--    the same question as (1).
--
--    elo_snapshot means exactly "this match moved the ladder, and the only
--    record of by how much is on this row". That is a stronger and more precise
--    statement of the thing that must not be destroyed than any status is:
--
--      * it catches a match written 'completed' whose status the console has
--        since rewritten — voidMatchImpl (results.ts:623) updates on the id
--        alone, so a void racing a result entry leaves a row that reads
--        'voided' and still carries an applied delta;
--      * it does NOT catch a properly voided match. reverse_tournament_match_
--        rating sets `elo_snapshot = NULL` in the same transaction as the
--        reversal it describes (00078, verified against production 2026-08-17),
--        so void-then-redraw — the documented escape hatch, and the one the
--        refusal message names — still works exactly as before;
--      * it does NOT catch a bye, which is 'completed' with no snapshot, so a
--        redraw of a draw full of byes is unaffected.
--
--    In effect: AN EVENT CARRYING AN APPLIED RATING IS NOT REGENERABLE UNTIL
--    THAT RATING HAS BEEN REVERSED. That is the intended reading. Reversal
--    already has a path (void, or undo), it is the path the console already
--    tells the exec to take, and it is the only path that leaves the ladder
--    correct. The cost is that an exec who wants to rebuild a draw must void or
--    undo each played match one at a time first. That is a real cost at a busy
--    desk and it is the right one: a refusal wastes a minute, and a redraw that
--    silently rewrites the ladder cannot be undone from a backup without
--    discarding everything else that has happened since.
--
-- 3. A MATCH ON COURT — status = 'live', is_bye IS NOT TRUE. Harm (a).
--
--    The audit that found this proposed leaving 'live' to the user interface, on
--    the grounds that a live match has no result to lose. It has no RESULT; it
--    has people on court. Greying the button is not a fix, because the count
--    behind the greying is taken from a page snapshot and a match can be called
--    onto court during the several seconds the generation is running. The server
--    is the only place this can be refused reliably, so it is refused here as
--    well as greyed there.
--
--    THE ESCAPE HATCH IS CHEAP AND ALREADY EXISTS: setMatchLive (scheduling.ts:
--    311) is a toggle, so un-starting the match returns it to 'ready' and the
--    redraw proceeds. A live match is the one blocker an exec can clear in one
--    click without touching a rating.
--
-- ------------------------------------------------------------
-- p_phase IS NULL MEANS "NO PHASE FILTER" AND NOT "phase IS NULL"
-- ------------------------------------------------------------
-- 00107 split pool_to_bracket events into two phases carried on
-- tournament_matches.phase. The two single-phase formats write NULL there, and
-- deletePhaseMatches deliberately issues an UNFILTERED delete for them — the
-- comment at brackets.ts:186 explains that adding `.is('phase', null)` would
-- only create a way for a stray row to survive a rebuild. `(p_phase IS NULL OR
-- phase = p_phase)` reproduces that exactly. Written as `phase IS NOT DISTINCT
-- FROM p_phase` it would silently change behaviour for the two common formats.
--
-- The filter is also what keeps pool_to_bracket usable: a played-out POOL must
-- not block regenerating the BRACKET drawn from it. The blocker counts are taken
-- from the deleted rows only, so a phase this call does not touch cannot refuse
-- it.
--
-- ------------------------------------------------------------
-- THE ADVISORY LOCK — WHAT IT IS AND IS NOT FOR
-- ------------------------------------------------------------
-- The same event-scoped lock pair_tournament_entrants (00102),
-- unpair_tournament_pair (00102) and swap_tournament_pair_member (00103) take.
-- It serialises this delete against a pairing change and against a second
-- redraw, which is worth having: a pair formed or split halfway through a
-- generation is a field that changed under the seeding.
--
-- IT IS NOT WHAT MAKES THIS SAFE. The rating RPCs do not take it. The delete's
-- own row locks are what close the race, and this function would be correct
-- without the lock. Stated plainly so nobody later removes the CTE on the
-- grounds that "the lock handles it".
--
-- Note also that the lock is released at COMMIT, i.e. when this function
-- returns — the caller's subsequent INSERTs are outside it. Two concurrent
-- generations of the same event still collide, as they did before, on
-- tournament_matches_draw_position_idx. That is unchanged and out of scope.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_phase_matches(
  p_event_id uuid,
  p_phase    text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted integer;
  v_played  integer;
  v_rated   integer;
  v_live    integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- ONE STATEMENT. The rows counted below are the rows this DELETE actually
  -- removed, under its own locks, in its own snapshot — not the rows some
  -- earlier SELECT thought were there.
  WITH gone AS (
    DELETE FROM tournament_matches
     WHERE event_id = p_event_id
       AND (p_phase IS NULL OR phase = p_phase)
    RETURNING status, is_bye, elo_snapshot
  )
  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE is_bye IS NOT TRUE
        AND status IN ('completed', 'walkover', 'disputed')
    )::integer,
    count(*) FILTER (WHERE elo_snapshot IS NOT NULL)::integer,
    count(*) FILTER (WHERE is_bye IS NOT TRUE AND status = 'live')::integer
  INTO v_deleted, v_played, v_rated, v_live
  FROM gone;

  -- Each RAISE aborts the transaction, so the DELETE above is rolled back with
  -- it. Ordered by what the exec should deal with first, and each one names a
  -- REACHABLE remedy — a refusal an exec cannot act on is a dead end.
  IF v_played > 0 THEN
    RAISE EXCEPTION
      '% match% in this draw % a result, and rebuilding the draw deletes every match — including %. Void or undo % first if the draw really has to be rebuilt. Byes do not count towards this.',
      v_played,
      CASE WHEN v_played = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_played = 1 THEN 'has' ELSE 'have' END,
      CASE WHEN v_played = 1 THEN 'that one' ELSE 'those' END,
      CASE WHEN v_played = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reached only by a match whose status says it is finished with while its row
  -- still carries the delta — the void-racing-a-result shape at results.ts:623.
  -- "Void it first" would be a dead end here because it IS already voided, so
  -- the message names the two-step that actually reverses the rating.
  IF v_rated > 0 THEN
    RAISE EXCEPTION
      '% match% in this draw still carr% an applied rating that was never reversed, and deleting % would leave that rating on the ladder with no way to take it back. Unvoid then undo % first.',
      v_rated,
      CASE WHEN v_rated = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_rated = 1 THEN 'ies' ELSE 'y' END,
      CASE WHEN v_rated = 1 THEN 'it' ELSE 'them' END,
      CASE WHEN v_rated = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_live > 0 THEN
    RAISE EXCEPTION
      '% match% in this draw % being played right now. Rebuilding the draw would delete % mid-game. Undo the start on the Court Management tab first, or wait for the result.',
      v_live,
      CASE WHEN v_live = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_live = 1 THEN 'is' ELSE 'are' END,
      CASE WHEN v_live = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_deleted;
END;
$function$;

COMMENT ON FUNCTION public.delete_phase_matches(uuid, text) IS
  'Delete one phase of an event''s draw, or refuse the whole thing. The DELETE and the check that it was allowed are ONE statement (a data-modifying CTE counting its own RETURNING rows), so no result and no rating can land between them — which a count-then-delete in the same function CANNOT guarantee under READ COMMITTED. Refuses if any deleted row had a result (completed/walkover/disputed, byes excluded), carried a non-null elo_snapshot (an applied rating whose only record is that row — reverse_tournament_match_rating nulls it, so a properly voided match still deletes), or was live. p_phase NULL means NO phase filter, matching deletePhaseMatches'' behaviour for the two single-phase formats; it does NOT mean phase IS NULL. Returns the number of rows deleted.';

-- service_role ONLY, as 00102/00103. Called by an admin server action behind
-- requireCapability('tournaments.draw.generate'); SECURITY DEFINER means a grant
-- to `authenticated` would hand every member the ability to delete any draw.
REVOKE ALL ON FUNCTION public.delete_phase_matches(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_phase_matches(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_phase_matches(uuid, text) TO service_role;

-- A SIGNATURE THAT HAS NEVER EXISTED, so PostgREST's cached schema cannot know
-- it and the first call would be PGRST202 "Could not find the function
-- public.delete_phase_matches(...) in the schema cache" — which, on this path,
-- means a redraw that fails at the delete after the seeding writes have landed.
-- 00135 omitted exactly this and 00136 had to add it back. See 00136:10.
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- VERIFICATION (2026-08-17)
-- ============================================================
-- Run in a disposable supabase/postgres:17.6.1.136 container, loaded from
-- read-only `pg_dump --schema-only` of BOTH production and staging, separately.
-- Nothing was written to either live database.
--
--   pre-state   `delete_phase_matches` does not exist on either database
--               (0 occurrences in either schema dump). tournament_matches
--               carries elo_snapshot jsonb and a nullable is_bye on both.
--
--   FAILURE     with a tournament -> event -> match fixture seeded and the
--               interleaving driven from two concurrent psql sessions:
--                 S1  SELECT count(*) ... -> 0          (the guard passes)
--                 S2  UPDATE ... status='completed', elo_snapshot='{...}'
--                 S1  DELETE FROM tournament_matches WHERE event_id = ...
--               -> the rated match is GONE and no error is raised. Reproduced
--               against the CURRENT code path and, separately, against a
--               count-then-delete function body in one transaction — which
--               loses the row too, for the READ COMMITTED reason above.
--
--   after       the same interleaving against this function raises
--               check_violation, the DELETE is rolled back, and the rated match
--               is STILL THERE. Also refused: a live match; a voided row that
--               still carries a snapshot. Still permitted: a draw of byes; a
--               properly voided (snapshot-nulled) match; and regenerating the
--               BRACKET of a pool_to_bracket event whose POOL is fully played.
--
--   idempotent  the whole file re-applied over itself; second run clean, still
--               exactly one function, and pg_proc.oid UNCHANGED across the
--               re-apply (25919 before and after) — CREATE OR REPLACE really
--               did replace rather than drop and recreate, so nothing that
--               depends on the oid was invalidated.
--
--   not proven  everything above went through psql. The PostgREST path was not
--               exercised: that `p_phase: null` binds to the text parameter
--               (there is only one overload, so there is nothing to be
--               ambiguous about), and that a check_violation RAISE reaches
--               supabase-js as error.code '23514'. The second is precedent
--               rather than measurement — addPairToEventImpl
--               (participants.ts:1240) already reads 00102's raises exactly
--               that way and has done since 00102 shipped.
--
-- ============================================================
-- APPLYING IT
-- ============================================================
-- APPLY THIS BEFORE DEPLOYING THE ADMIN APP THAT CALLS IT. deletePhaseMatches
-- becomes an .rpc() call in the same commit, so between a deploy and this
-- migration every redraw comes back PGRST202 ("Could not find the function
-- public.delete_phase_matches in the schema cache"). That is loud and destroys
-- nothing — the seed_number writes have landed and the draw is untouched — but
-- the Regenerate button does not work until this file has run.
--
-- ONE FREE SMOKE TEST once it is applied, on any event that has no matches:
--
--     select delete_phase_matches('<event-with-no-draw>'::uuid, null);
--
-- It returns 0 and deletes nothing, and it proves the whole PostgREST path at
-- once: the schema cache reloaded, the arguments bind, and service_role may
-- execute it.
-- ============================================================
