-- 00177_apply_match_result_deltas.sql
--
-- Finishes the job 00082 started and explicitly left open in its own header:
--
--   "NOT addressed here, and still open: apply_match_result (00041) computes
--    the ordinary challenge path from a stored pre_rating and writes an
--    absolute. Same class of bug, different function, and it needs its own
--    migration."
--
-- This is that migration.
--
-- THE BUG. match_participants.pre_rating is stamped when a result is
-- SUBMITTED. apply_match_result derives the new rating from it at
-- CONFIRMATION time and writes that number into ratings as an absolute. Every
-- rating movement in between is erased:
--
--   1. Alice is 500. She submits a challenge result; pre_rating = 500.
--   2. Before her opponent confirms, Alice plays a tournament and wins.
--      apply_tournament_match_rating (correctly, since 00082) applies +25 by
--      delta. Alice is 525.
--   3. The opponent confirms the challenge. This function computes
--      500 + 18 = 518 and writes 518.
--
-- Alice is now 518. The tournament's +25 is gone, and this is worse than a
-- lost update: the tournament match's own elo_snapshot still records that its
-- delta was applied, so reversing that match later subtracts 25 from a number
-- it was never added to, taking Alice to 493 — below where she started.
--
-- The window is not narrow. It is the entire time a result sits waiting for
-- the opponent to confirm, which is hours or days, and any rated activity by
-- either player inside it is destroyed. Two challenges confirmed concurrently
-- lose one of the two outright.
--
-- THE FIX, in two parts.
--
-- 1. Write through apply_rating_delta (00082) instead of dynamic SQL. It
--    re-reads the live rating, adds the delta, clamps to rating_bounds(), and
--    returns what actually landed. It already maintains every column the
--    inline UPDATE maintained — matches played, wins, losses, points, games,
--    streak, provisional flag — so this is a change of arithmetic, not of
--    coverage.
--
-- 2. Take FOR UPDATE on the participants' ratings rows before the loop. The
--    read inside apply_rating_delta is only safe under a lock, and the
--    `matches` lock at the top of this function serialises two confirmations
--    of the same match and nothing else. Rows are locked in player_id order so
--    two matches sharing two players cannot deadlock.
--
-- WHAT DELIBERATELY DOES NOT CHANGE. pre_rating remains the basis of the
-- ARITHMETIC. The opponent average is a pre-match snapshot too, and rating
-- both sides off live values would make the result depend on the order the
-- loop happens to process participants in — the asymmetric-delta bug the
-- comment inside the loop already warns about. Only the WRITE becomes a delta.
--
-- The participant row records the APPLIED delta rather than the requested one,
-- for the reason 00082 gives: at the ceiling or the floor the clamp absorbs
-- part of the movement, and every reversal path subtracts rating_delta.
--
-- IDEMPOTENT. Function replacement only; no data is rewritten. Existing rows
-- whose ratings were corrupted by the old behaviour are NOT repaired here —
-- that needs the audit's existing-data check first, and a repair migration is
-- a separate, reviewable change.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_match_result(p_match_id uuid, p_confirmed_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match RECORD;
  v_threshold INTEGER := rating_setting_int('provisional_threshold', 8);
  -- <<< 00127 >>> The switch. Read once per call, beside the threshold it
  -- qualifies, via 00053's section-aware helper — no new helper needed.
  v_provisional_k BOOLEAN := platform_setting_bool('rating_defaults', 'provisional_k_enabled', TRUE);
  v_participant RECORD;
  v_opponent_rating INTEGER;
  v_k_factor INTEGER;
  v_format_weight NUMERIC;
  v_event_mult NUMERIC;
  v_won BOOLEAN;
  v_new_rating INTEGER;
  v_delta INTEGER;
  v_applied JSONB;
  v_games_a INTEGER;
  v_games_b INTEGER;
  v_derived_winner team_side;
BEGIN
  -- Lock and fetch match
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF v_match IS NULL THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF v_match.result_status != 'pending_confirmation' THEN RAISE EXCEPTION 'Match not pending confirmation'; END IF;
  -- M6: block force-confirming a match you are not part of. SECURITY DEFINER
  -- keeps auth.uid() = the caller, so a legit participant confirm passes; the
  -- admin service-role (auth.uid() NULL) and admins bypass.
  IF auth.uid() IS NOT NULL
     AND NOT is_admin(auth.uid())
     AND get_player_id(auth.uid()) NOT IN (
       SELECT player_id FROM match_participants WHERE match_id = p_match_id)
  THEN RAISE EXCEPTION 'Only a participant can confirm this match'; END IF;
  -- The submitter must NOT confirm their own result — confirmation is the
  -- opponent's attestation. This also shuts the match-forgery path: fabricating
  -- a match + self-enrolling a victim requires being the submitter (mp_insert),
  -- and applying it requires confirming, so submitter=confirmer is blocked here.
  IF auth.uid() IS NOT NULL
     AND NOT is_admin(auth.uid())
     AND get_player_id(auth.uid()) = v_match.submitted_by
  THEN RAISE EXCEPTION 'The submitter cannot confirm their own result'; END IF;
  IF v_match.event_type = 'casual' THEN
    -- Casual matches: just confirm, no Elo changes
    UPDATE matches SET result_status = 'confirmed', confirmed_by = p_confirmed_by, updated_at = NOW() WHERE id = p_match_id;
    UPDATE challenges SET status = 'completed', updated_at = NOW() WHERE id = v_match.challenge_id;
    RETURN;
  END IF;

  IF v_match.walkover_type IS NOT NULL THEN
    -- Walkover matches have no games; winner_side is derived server-side
    -- by apply_walkover_result (opposite the forfeiting player).
    IF v_match.winner_side IS NULL THEN
      RAISE EXCEPTION 'No winner set for walkover match';
    END IF;
    v_derived_winner := v_match.winner_side;
  ELSE
    -- Derive the winner from the recorded games rather than trusting the
    -- client-supplied winner_side. Tied games count for neither side.
    SELECT
      COUNT(*) FILTER (WHERE side_a_score > side_b_score),
      COUNT(*) FILTER (WHERE side_b_score > side_a_score)
    INTO v_games_a, v_games_b
    FROM match_games
    WHERE match_id = p_match_id;

    IF COALESCE(v_games_a, 0) + COALESCE(v_games_b, 0) = 0 THEN
      RAISE EXCEPTION 'No decisive games recorded for match';
    END IF;
    IF v_games_a = v_games_b THEN
      RAISE EXCEPTION 'Games won are tied; cannot derive winner';
    END IF;

    v_derived_winner := CASE WHEN v_games_a > v_games_b THEN 'a'::team_side ELSE 'b'::team_side END;

    IF v_match.winner_side IS DISTINCT FROM v_derived_winner THEN
      RAISE EXCEPTION 'winner_side does not match game scores';
    END IF;
  END IF;

  -- The per-discipline column names this function used to build dynamic SQL
  -- from now live in apply_rating_delta, which owns the ratings write.

  v_format_weight := v_match.format_weight;
  -- elo_weight_override carries the reduced walkover weighting
  -- (0.50 withdrawal < 24h, 0.75 no-show); NULL for normal matches.
  v_event_mult := v_match.event_multiplier * COALESCE(v_match.elo_weight_override, 1.0);

  -- LOCK EVERY PARTICIPANT'S RATING ROW FIRST, in player_id order.
  --
  -- apply_rating_delta reads the live rating and adds to it, and that read is
  -- only safe against a concurrent confirmation of a DIFFERENT match involving
  -- the same player if it happens through a lock. The `matches` row lock taken
  -- at the top of this function serialises two confirmations of THIS match and
  -- nothing else. Ordered by player_id so two matches sharing two players
  -- cannot take the two locks in opposite orders and deadlock.
  PERFORM 1
    FROM ratings r
   WHERE r.player_id IN (
           SELECT mp.player_id FROM match_participants mp WHERE mp.match_id = p_match_id)
   ORDER BY r.player_id
     FOR UPDATE;

  -- Process each participant
  FOR v_participant IN
    SELECT mp.*, r.singles_elo, r.doubles_elo, r.singles_provisional, r.doubles_provisional,
           r.singles_matches_played, r.doubles_matches_played
    FROM match_participants mp
    JOIN ratings r ON r.player_id = mp.player_id
    WHERE mp.match_id = p_match_id
  LOOP
    v_won := (v_participant.team_side = v_derived_winner);

    -- Get opponent average rating from the PRE-match snapshot
    -- (match_participants.pre_rating), NOT the live ratings table.
    -- Reading live ratings here is order-dependent: this loop writes
    -- each participant's new rating in-place, so whichever participant
    -- is processed second would see the opponent's ALREADY-UPDATED
    -- rating, producing asymmetric deltas (e.g. winner +20 / loser -19).
    -- pre_rating already encodes the correct field (singles_elo vs
    -- doubles_elo) chosen at participant-insert time by match_type, so
    -- no match_type branch is needed. Singles: the other player's
    -- pre_rating; doubles: AVG of the two opposing players' pre_ratings.
    SELECT AVG(mp2.pre_rating)
    INTO v_opponent_rating
    FROM match_participants mp2
    WHERE mp2.match_id = p_match_id AND mp2.team_side != v_participant.team_side;

    -- K-factor
    --
    -- <<< 00127 >>> `v_provisional_k AND (...)` is the ONLY change to this
    -- function. With the switch on (the default, and every club's behaviour
    -- before 00127) the condition is exactly what it always was. With it off,
    -- every player takes the established K regardless of how few matches they
    -- have played. The provisional FLAGS are still maintained by the UPDATE
    -- below — see the header for why.
    IF v_match.match_type = 'singles' THEN
      v_k_factor := CASE WHEN v_provisional_k AND (v_participant.singles_provisional OR v_participant.singles_matches_played < v_threshold)
                         THEN rating_setting_int('singles_k_provisional', 80)
                         ELSE rating_setting_int('singles_k_established', 48) END;
    ELSE
      v_k_factor := CASE WHEN v_provisional_k AND (v_participant.doubles_provisional OR v_participant.doubles_matches_played < v_threshold)
                         THEN rating_setting_int('doubles_k_provisional', 64)
                         ELSE rating_setting_int('doubles_k_established', 36) END;
    END IF;

    -- Calculate Elo delta
    SELECT cu.new_rating, cu.delta INTO v_new_rating, v_delta
    FROM calculate_elo_update(v_participant.pre_rating, v_opponent_rating, v_k_factor, v_format_weight, v_event_mult, v_won,
                              get_margin_multiplier(v_participant.games_won, v_participant.games_lost)) cu;

    -- A DELTA, NOT AN ABSOLUTE. This is the bug 00082 fixed for the
    -- tournament ladder and explicitly left open here.
    --
    -- calculate_elo_update above derives v_new_rating from
    -- match_participants.pre_rating, a snapshot taken when the result was
    -- SUBMITTED. Writing that absolute back into ratings erases anything that
    -- moved the player between submission and confirmation — a tournament
    -- result, another challenge, an exec correction. The player is silently
    -- rolled back to a rating that was current at submission time, and the
    -- other match's own snapshot still claims its delta was applied, so
    -- reversing THAT match later subtracts a delta from a number it was never
    -- added to.
    --
    -- Deltas commute; absolutes do not. apply_rating_delta re-reads the
    -- current rating through the lock taken above, adds v_delta, and clamps.
    -- pre_rating stays the basis of the ARITHMETIC (it has to — the opponent
    -- average is a pre-match snapshot too, and rating both sides off live
    -- values would make the loop order-dependent and the deltas asymmetric).
    -- Only the WRITE changes.
    v_applied := apply_rating_delta(
      v_participant.player_id, v_match.match_type, v_delta, v_won,
      v_participant.points_scored, v_participant.points_allowed,
      v_participant.games_won, v_participant.games_lost);

    -- What actually landed, which differs from what was asked for whenever the
    -- clamp absorbed part of it. Every reversal path subtracts rating_delta, so
    -- recording the request instead would walk a clamped player past where they
    -- started each time a result was corrected.
    v_new_rating := (v_applied->>'new_elo')::INTEGER;
    v_delta      := (v_applied->>'applied_delta')::INTEGER;

    UPDATE match_participants SET
      post_rating = v_new_rating,
      rating_delta = v_delta,
      win_flag = v_won
    WHERE id = v_participant.id;

    -- Update reliability
    UPDATE reliability_metrics SET
      matches_completed = matches_completed + 1,
      updated_at = NOW()
    WHERE player_id = v_participant.player_id;
  END LOOP;

  -- Update match status
  UPDATE matches SET
    result_status = 'confirmed',
    confirmed_by = p_confirmed_by,
    completed_flag = TRUE,
    updated_at = NOW()
  WHERE id = p_match_id;

  -- Update challenge status
  UPDATE challenges SET status = 'completed', updated_at = NOW() WHERE id = v_match.challenge_id;

  -- NOTE: head_to_head_stats is intentionally NOT updated here.
  -- The UPDATE ... SET result_status = 'confirmed' above fires the
  -- on_match_confirmed AFTER UPDATE trigger (00004_triggers.sql), which
  -- is the single owner of both update_head_to_head() and
  -- update_partnership_stats(). Every confirmation path that applies Elo
  -- (normal player confirm, apply_walkover_result, adminCreateMatch,
  -- resolveDispute accepted/edited) routes through this function and
  -- therefore through that UPDATE, so the trigger fires exactly once per
  -- confirmed rated match. Calling update_head_to_head() explicitly here
  -- as well would double-count every match (partnership_stats is already
  -- trigger-only and correct; this keeps h2h consistent with it).

  -- Audit
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, reason)
  VALUES (p_confirmed_by, 'match_confirmed', 'match', p_match_id, 'Match result confirmed and Elo applied');
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
