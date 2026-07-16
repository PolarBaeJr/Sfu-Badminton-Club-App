-- ============================================================
-- 00020_derive_match_winner.sql
--
-- 1. apply_match_result: derive the winner server-side from
--    match_games instead of trusting the client-supplied
--    winner_side. Body is copied from 00008_functions.sql with
--    the derivation block added after the status checks and
--    v_won switched to the derived winner.
--    apply_walkover_result is intentionally untouched —
--    walkovers legitimately have no games.
--
-- 2. Enforce at most one match per challenge (double-submission
--    guard anticipated by apps/player/src/lib/actions/matches.ts).
-- ============================================================

BEGIN;

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
  v_event_mult := v_match.event_multiplier;

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

-- One match per challenge (double-submission guard).
CREATE UNIQUE INDEX IF NOT EXISTS matches_challenge_id_unique
  ON matches(challenge_id) WHERE challenge_id IS NOT NULL;

COMMIT;
