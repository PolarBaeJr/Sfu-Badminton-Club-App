-- 00178_resolve_dispute_atomically.sql
--
-- Resolving a dispute as `accepted` or `edited` currently runs as three or four
-- separate transactions from the admin app:
--
--   1. (edited only) DELETE the match games, INSERT the corrected ones
--   2. UPDATE matches SET result_status = 'pending_confirmation'
--   3. rpc apply_match_result(...)          <- moves ratings, wins, streaks, H2H
--   4. UPDATE disputes SET status = 'resolved'
--
-- Nothing ties them together, and step 2 is what makes that dangerous. It
-- unconditionally re-arms the precondition step 3 checks. So if the admin's
-- request fails or its response is simply lost after step 3 committed, the
-- retry does not bounce off "match already confirmed" the way it looks like it
-- should — step 2 sets the match back to pending_confirmation first, and
-- apply_match_result runs a SECOND time.
--
-- That is not a cosmetic double write. apply_match_result increments matches
-- played, wins or losses, points scored and allowed, games won and lost, and
-- the win/loss streak, applies another rating delta, and fires
-- on_match_confirmed, which drives head_to_head_stats and partnership_stats.
-- A single lost response permanently doubles every one of those for both
-- players, and nothing in the data marks it as having happened twice.
--
-- The same shape, without a retry: a crash between step 3 and step 4 leaves the
-- ratings applied and the dispute still open on the console, inviting an
-- operator to resolve it again by hand.
--
-- THE FIX. One SECURITY DEFINER function, one transaction, in this order:
--
--   * lock the dispute row, and return early if it is already resolved. This
--     is the idempotence key. A retry after a lost response sees `resolved`
--     and reports what happened instead of re-applying it.
--   * lock the match row.
--   * refuse outright if the match is already `confirmed`. Belt and braces:
--     the dispute check above should already have caught it, and if the two
--     ever disagree, refusing to rate a match twice is the safe direction.
--   * do the edit, restore the status, apply the result, resolve the dispute.
--
-- Every step commits together or none of them do, so there is no window in
-- which the ratings have moved and the dispute has not closed.
--
-- SCOPE. `voided` and `converted_to_casual` are deliberately NOT handled here.
-- Neither calls apply_match_result, so neither can double-count ratings, and
-- both delegate to existing server actions (voidMatch, convertMatchToCasual)
-- with their own reversal logic. The caller claims the dispute for those two
-- the same way, but the work stays where it is.

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_dispute_rated(
  p_dispute_id      uuid,
  p_admin_id        uuid,
  p_resolution_type dispute_resolution,
  p_resolution_note text DEFAULT NULL,
  p_winner_side     team_side DEFAULT NULL,
  p_games           jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dispute disputes;
  v_match   matches;
  v_summary TEXT;
BEGIN
  IF p_resolution_type NOT IN ('accepted', 'edited') THEN
    RAISE EXCEPTION 'resolve_dispute_rated handles accepted and edited only, not %', p_resolution_type;
  END IF;

  SELECT * INTO v_dispute FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'Dispute not found';
  END IF;

  -- THE IDEMPOTENCE KEY. Taken before anything is written, through the row
  -- lock, so two operators resolving the same dispute at the same moment
  -- serialise here and the second one finds it done.
  IF v_dispute.status = 'resolved' THEN
    RETURN jsonb_build_object('applied', false, 'already_resolved', true);
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = v_dispute.match_id FOR UPDATE;
  IF v_match IS NULL THEN
    RAISE EXCEPTION 'Match not found';
  END IF;

  -- A confirmed match has already had its ratings, stats and head-to-head
  -- applied. Restoring it to pending_confirmation so it can be applied again
  -- is precisely the bug this migration exists to remove, so it is refused
  -- rather than repaired.
  IF v_match.result_status = 'confirmed' THEN
    RAISE EXCEPTION 'Match % is already confirmed; its result cannot be applied a second time', v_match.id;
  END IF;

  IF p_resolution_type = 'edited' THEN
    IF p_winner_side IS NULL OR p_games IS NULL OR jsonb_array_length(p_games) = 0 THEN
      RAISE EXCEPTION 'Edited resolution requires winner_side and games';
    END IF;

    DELETE FROM match_games WHERE match_id = v_match.id;

    INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score)
    SELECT v_match.id,
           (g->>'game_number')::INTEGER,
           (g->>'side_a_score')::INTEGER,
           (g->>'side_b_score')::INTEGER
      FROM jsonb_array_elements(p_games) g;

    -- Built from the same array that was just inserted, in game order, so the
    -- summary string cannot drift from the rows behind it.
    SELECT string_agg((g->>'side_a_score') || '-' || (g->>'side_b_score'), ', '
                      ORDER BY (g->>'game_number')::INTEGER)
      INTO v_summary
      FROM jsonb_array_elements(p_games) g;

    UPDATE matches
       SET winner_side   = p_winner_side,
           score_summary = v_summary,
           result_status = 'pending_confirmation',
           updated_at    = NOW()
     WHERE id = v_match.id;
  ELSE
    -- The match was disputed and so never confirmed; apply_match_result
    -- requires pending_confirmation.
    UPDATE matches
       SET result_status = 'pending_confirmation',
           updated_at    = NOW()
     WHERE id = v_match.id;
  END IF;

  PERFORM apply_match_result(v_match.id, p_admin_id);

  UPDATE disputes
     SET status          = 'resolved',
         resolution_type = p_resolution_type,
         resolution_note = p_resolution_note,
         resolved_by     = p_admin_id,
         resolved_at     = NOW(),
         updated_at      = NOW()
   WHERE id = p_dispute_id;

  RETURN jsonb_build_object('applied', true, 'already_resolved', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_dispute_rated(uuid, uuid, dispute_resolution, text, team_side, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_dispute_rated(uuid, uuid, dispute_resolution, text, team_side, jsonb) TO service_role;

-- Claims a dispute for the two resolution types whose work stays in the admin
-- app. Same idempotence key, same lock, so a retry or a second operator cannot
-- start a void or a casual conversion that is already under way. The caller
-- finishes the resolution itself and closes the dispute.
CREATE OR REPLACE FUNCTION public.claim_dispute_for_resolution(
  p_dispute_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dispute disputes;
BEGIN
  SELECT * INTO v_dispute FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'Dispute not found';
  END IF;
  IF v_dispute.status = 'resolved' THEN
    RETURN jsonb_build_object('claimed', false, 'already_resolved', true, 'match_id', v_dispute.match_id);
  END IF;
  -- under_review is the "someone is working on this" state that already exists
  -- in dispute_status; using it means the claim is visible on the console
  -- rather than being an invisible lock.
  UPDATE disputes SET status = 'under_review', updated_at = NOW() WHERE id = p_dispute_id;
  RETURN jsonb_build_object('claimed', true, 'already_resolved', false, 'match_id', v_dispute.match_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_dispute_for_resolution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_dispute_for_resolution(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
