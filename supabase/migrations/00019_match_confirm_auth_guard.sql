-- ============================================================
-- 00019 - Match confirmation authorization guard (audit M6)
-- ============================================================
-- apply_match_result had no in-function participant check, so any authed user
-- could rpc() it to force-apply Elo for a match they aren't in (forging
-- confirmed_by/audit actor). Body below is the exact current definition
-- (pg_get_functiondef, preserving the 00017 SECURITY DEFINER) with only the
-- guard inserted after the status checks. Idempotent (CREATE OR REPLACE).
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_match_result(p_match_id uuid, p_confirmed_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match RECORD;
  v_participant RECORD;
  v_opponent_rating INTEGER;
  v_k_factor INTEGER;
  v_format_weight NUMERIC;
  v_event_mult NUMERIC;
  v_won BOOLEAN;
  v_new_rating INTEGER;
  v_delta INTEGER;
  v_games_a INTEGER;
  v_games_b INTEGER;
  v_derived_winner team_side;
  v_elo_field TEXT;
  v_matches_field TEXT;
  v_wins_field TEXT;
  v_losses_field TEXT;
  v_prov_field TEXT;
  v_streak_field TEXT;
  v_best_streak_field TEXT;
  v_pts_scored_field TEXT;
  v_pts_allowed_field TEXT;
  v_games_won_field TEXT;
  v_games_lost_field TEXT;
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

  -- Set field names based on match type
  IF v_match.match_type = 'singles' THEN
    v_elo_field := 'singles_elo'; v_matches_field := 'singles_matches_played';
    v_wins_field := 'singles_wins'; v_losses_field := 'singles_losses';
    v_prov_field := 'singles_provisional'; v_streak_field := 'current_singles_streak';
    v_best_streak_field := 'best_singles_streak';
    v_pts_scored_field := 'singles_points_scored'; v_pts_allowed_field := 'singles_points_allowed';
    v_games_won_field := 'singles_games_won'; v_games_lost_field := 'singles_games_lost';
  ELSE
    v_elo_field := 'doubles_elo'; v_matches_field := 'doubles_matches_played';
    v_wins_field := 'doubles_wins'; v_losses_field := 'doubles_losses';
    v_prov_field := 'doubles_provisional'; v_streak_field := 'current_doubles_streak';
    v_best_streak_field := 'best_doubles_streak';
    v_pts_scored_field := 'doubles_points_scored'; v_pts_allowed_field := 'doubles_points_allowed';
    v_games_won_field := 'doubles_games_won'; v_games_lost_field := 'doubles_games_lost';
  END IF;

  v_format_weight := v_match.format_weight;
  -- elo_weight_override carries the reduced walkover weighting
  -- (0.50 withdrawal < 24h, 0.75 no-show); NULL for normal matches.
  v_event_mult := v_match.event_multiplier * COALESCE(v_match.elo_weight_override, 1.0);

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
    IF v_match.match_type = 'singles' THEN
      v_k_factor := CASE WHEN v_participant.singles_provisional OR v_participant.singles_matches_played < 8 THEN 80 ELSE 48 END;
    ELSE
      v_k_factor := CASE WHEN v_participant.doubles_provisional OR v_participant.doubles_matches_played < 8 THEN 64 ELSE 36 END;
    END IF;

    -- Calculate Elo delta
    SELECT cu.new_rating, cu.delta INTO v_new_rating, v_delta
    FROM calculate_elo_update(v_participant.pre_rating, v_opponent_rating, v_k_factor, v_format_weight, v_event_mult, v_won) cu;

    -- Update match_participants
    UPDATE match_participants SET
      post_rating = v_new_rating,
      rating_delta = v_delta,
      win_flag = v_won
    WHERE id = v_participant.id;

    -- Update ratings table using dynamic SQL
    EXECUTE format(
      'UPDATE ratings SET %I = $1, %I = %I + 1, %I = CASE WHEN $2 THEN %I + 1 ELSE %I END, %I = CASE WHEN NOT $2 THEN %I + 1 ELSE %I END, %I = $3 + COALESCE(%I, 0), %I = $4 + COALESCE(%I, 0), %I = $5 + COALESCE(%I, 0), %I = $6 + COALESCE(%I, 0), %I = CASE WHEN $2 THEN GREATEST(COALESCE(%I, 0) + 1, 1) ELSE LEAST(COALESCE(%I, 0) - 1, -1) END, %I = CASE WHEN %I + 1 >= 8 THEN FALSE ELSE %I END, updated_at = NOW() WHERE player_id = $7',
      v_elo_field,
      v_matches_field, v_matches_field,
      v_wins_field, v_wins_field, v_wins_field,
      v_losses_field, v_losses_field, v_losses_field,
      v_pts_scored_field, v_pts_scored_field,
      v_pts_allowed_field, v_pts_allowed_field,
      v_games_won_field, v_games_won_field,
      v_games_lost_field, v_games_lost_field,
      v_streak_field, v_streak_field, v_streak_field,
      v_prov_field, v_matches_field, v_prov_field
    ) USING v_new_rating, v_won, v_participant.points_scored, v_participant.points_allowed, v_participant.games_won, v_participant.games_lost, v_participant.player_id;

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
