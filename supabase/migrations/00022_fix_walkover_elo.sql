-- ============================================================
-- 00022_fix_walkover_elo.sql
--
-- Fix rated-walkover confirmation, broken since 00008.
--
-- Ground truth:
--   * confirmWalkover (apps/admin/src/lib/actions.ts) calls the 3-arg
--     apply_walkover_result(uuid, uuid, text) from 00003 (00008 added a
--     separate 1-arg overload; it never replaced the 3-arg one).
--   * 00003_functions.sql:332 inserts the walkover match with
--     result_status = 'walkover', then (00003:346) calls
--     apply_match_result when the walkover is rated with elo weight > 0.
--   * apply_match_result was rewritten in 00008 (and re-created in 00020)
--     to RAISE unless result_status = 'pending_confirmation'
--     (00008_functions.sql:60, 00020_derive_match_winner.sql:50). The
--     00003 version only rejected already-confirmed matches.
--   * There is no exception handler, so the RAISE aborts the whole RPC:
--     rated walkovers (no_show, withdrawal with < 24h notice) cannot be
--     confirmed at all and no ELO is ever applied for them.
--
-- Three coordinated changes are needed:
--   1. apply_walkover_result must insert the match as
--      'pending_confirmation' when ELO will be applied (apply_match_result
--      itself flips it to 'confirmed').
--   2. apply_match_result must not try to derive the winner from
--      match_games for walkover matches — walkovers legitimately have no
--      games; their winner_side is computed server-side by
--      apply_walkover_result (opposite the forfeiting player).
--   3. apply_match_result must honor matches.elo_weight_override again
--      (the 00003 version did; 00008 dropped it), otherwise the 0.50 /
--      0.75 walkover weighting is lost. NULL override (all normal
--      matches) coalesces to 1.0, so nothing else changes.
--
-- No retroactive data repair: failed confirmations rolled back entirely,
-- so there is nothing inconsistent to fix.
-- ============================================================

BEGIN;

-- Body copied from 00020_derive_match_winner.sql with the walkover
-- exemption and the elo_weight_override factor added.
CREATE OR REPLACE FUNCTION apply_match_result(
  p_match_id UUID,
  p_confirmed_by UUID
) RETURNS VOID AS $$
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

    -- Get opponent average rating
    SELECT CASE WHEN v_match.match_type = 'singles' THEN AVG(r2.singles_elo) ELSE AVG(r2.doubles_elo) END
    INTO v_opponent_rating
    FROM match_participants mp2
    JOIN ratings r2 ON r2.player_id = mp2.player_id
    WHERE mp2.match_id = p_match_id AND mp2.team_side != v_participant.team_side;

    -- K-factor
    IF v_match.match_type = 'singles' THEN
      v_k_factor := CASE WHEN v_participant.singles_provisional OR v_participant.singles_matches_played < 8 THEN 40 ELSE 24 END;
    ELSE
      v_k_factor := CASE WHEN v_participant.doubles_provisional OR v_participant.doubles_matches_played < 8 THEN 32 ELSE 18 END;
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

  -- Update head_to_head stats
  PERFORM update_head_to_head(p_match_id);

  -- Audit
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, reason)
  VALUES (p_confirmed_by, 'match_confirmed', 'match', p_match_id, 'Match result confirmed and Elo applied');
END;
$$ LANGUAGE plpgsql;

-- Body copied from 00003_functions.sql with the match inserted as
-- 'pending_confirmation' when ELO will be applied (apply_match_result
-- flips it to 'confirmed'), and unused declarations dropped.
-- SECURITY DEFINER + search_path pin preserved from 00003/00019.
CREATE OR REPLACE FUNCTION apply_walkover_result(
  p_walkover_id UUID,
  p_admin_id UUID,
  p_admin_notes TEXT DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  v_walkover RECORD;
  v_challenge RECORD;
  v_elo_weight NUMERIC;
  v_apply_elo BOOLEAN;
  v_match_id UUID;
  v_winner_side team_side;
  v_is_doubles BOOLEAN;
BEGIN
  SELECT * INTO v_walkover FROM walkovers WHERE id = p_walkover_id FOR UPDATE;
  IF v_walkover IS NULL OR v_walkover.status != 'pending' THEN
    RAISE EXCEPTION 'Walkover not found or not pending';
  END IF;

  SELECT * INTO v_challenge FROM challenges WHERE id = v_walkover.challenge_id;

  -- Determine Elo weight based on walkover type
  IF v_walkover.walkover_type = 'withdrawal' AND COALESCE(v_walkover.notice_hours, 0) >= 24 THEN
    v_elo_weight := 0.0; -- No penalty for early withdrawal
  ELSIF v_walkover.walkover_type = 'withdrawal' THEN
    v_elo_weight := 0.50;
  ELSE -- no_show
    v_elo_weight := 0.75;
  END IF;

  v_apply_elo := v_elo_weight > 0 AND v_challenge.rated_flag;

  -- Create a match record for the walkover
  v_is_doubles := v_challenge.type = 'doubles';

  -- Determine winner side (opposite of forfeiting player)
  SELECT team_side INTO v_winner_side
  FROM challenge_participants
  WHERE challenge_id = v_walkover.challenge_id AND player_id = v_walkover.forfeit_player_id;

  IF v_winner_side = 'a' THEN v_winner_side := 'b'; ELSE v_winner_side := 'a'; END IF;

  -- Create match. When ELO applies the row starts as pending_confirmation
  -- because apply_match_result rejects any other status, then flips it to
  -- 'confirmed' itself.
  INSERT INTO matches (
    challenge_id, session_id, season_id, match_type, event_type,
    rated_flag, format, format_weight, event_multiplier,
    completed_flag, winner_side, result_status, walkover_type,
    forfeit_player_id, notice_hours, elo_weight_override, played_at
  ) VALUES (
    v_walkover.challenge_id, v_challenge.session_id,
    (SELECT id FROM seasons WHERE active_flag = TRUE LIMIT 1),
    v_challenge.type, v_challenge.event_type,
    v_challenge.rated_flag AND v_elo_weight > 0,
    v_challenge.format, get_format_weight(v_challenge.format),
    get_event_multiplier(v_challenge.event_type),
    TRUE, v_winner_side,
    CASE WHEN v_apply_elo THEN 'pending_confirmation'::result_status ELSE 'walkover'::result_status END,
    v_walkover.walkover_type,
    v_walkover.forfeit_player_id, v_walkover.notice_hours, v_elo_weight, NOW()
  ) RETURNING id INTO v_match_id;

  -- Add match participants from challenge participants
  INSERT INTO match_participants (match_id, player_id, team_side, pre_rating)
  SELECT v_match_id, cp.player_id, cp.team_side,
    CASE WHEN v_is_doubles THEN r.doubles_elo ELSE r.singles_elo END
  FROM challenge_participants cp
  JOIN ratings r ON r.player_id = cp.player_id
  WHERE cp.challenge_id = v_walkover.challenge_id;

  -- Apply Elo if weight > 0
  IF v_apply_elo THEN
    PERFORM apply_match_result(v_match_id, p_admin_id);
  ELSE
    -- Just mark participants
    UPDATE match_participants SET win_flag = (team_side = v_winner_side),
      post_rating = pre_rating, rating_delta = 0
    WHERE match_id = v_match_id;

    UPDATE matches SET result_status = 'walkover', confirmed_by = p_admin_id WHERE id = v_match_id;
    IF v_challenge.id IS NOT NULL THEN
      UPDATE challenges SET status = 'walkover_confirmed', updated_at = NOW() WHERE id = v_challenge.id;
    END IF;
  END IF;

  -- Update walkover record
  UPDATE walkovers SET
    status = 'confirmed',
    match_id = v_match_id,
    admin_confirmed_by = p_admin_id,
    admin_confirmed_at = NOW(),
    admin_notes = p_admin_notes,
    elo_penalty_applied = (v_elo_weight > 0),
    updated_at = NOW()
  WHERE id = p_walkover_id;

  -- Update challenge status
  UPDATE challenges SET status = 'walkover_confirmed', updated_at = NOW()
  WHERE id = v_walkover.challenge_id;

  -- Update reliability metrics for forfeiting player
  IF v_walkover.walkover_type = 'no_show' THEN
    UPDATE reliability_metrics SET
      no_shows = no_shows + 1,
      updated_at = NOW()
    WHERE player_id = v_walkover.forfeit_player_id;
  ELSIF COALESCE(v_walkover.notice_hours, 0) < 24 THEN
    UPDATE reliability_metrics SET
      late_cancellations = late_cancellations + 1,
      updated_at = NOW()
    WHERE player_id = v_walkover.forfeit_player_id;
  ELSE
    UPDATE reliability_metrics SET
      early_withdrawals = early_withdrawals + 1,
      updated_at = NOW()
    WHERE player_id = v_walkover.forfeit_player_id;
  END IF;

  -- Update walkovers_received for the other players
  UPDATE reliability_metrics SET
    walkovers_received = walkovers_received + 1,
    updated_at = NOW()
  WHERE player_id IN (
    SELECT player_id FROM challenge_participants
    WHERE challenge_id = v_walkover.challenge_id
    AND player_id != v_walkover.forfeit_player_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

COMMIT;
