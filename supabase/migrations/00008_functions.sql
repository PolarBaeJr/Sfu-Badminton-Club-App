-- ============================================================
-- Elo calculation function
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_elo_update(
  p_player_rating INTEGER,
  p_opponent_rating INTEGER,
  p_k_factor INTEGER,
  p_format_weight NUMERIC,
  p_event_multiplier NUMERIC,
  p_won BOOLEAN
) RETURNS TABLE(new_rating INTEGER, delta INTEGER, expected NUMERIC) AS $$
DECLARE
  v_expected NUMERIC;
  v_actual NUMERIC;
  v_delta INTEGER;
BEGIN
  v_expected := 1.0 / (1.0 + POWER(10, (p_opponent_rating - p_player_rating)::NUMERIC / 400));
  v_actual := CASE WHEN p_won THEN 1.0 ELSE 0.0 END;
  v_delta := ROUND(p_k_factor * p_format_weight * p_event_multiplier * (v_actual - v_expected));

  RETURN QUERY SELECT
    (p_player_rating + v_delta)::INTEGER AS new_rating,
    v_delta AS delta,
    v_expected AS expected;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- Apply match result (atomic Elo update)
-- ============================================================
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
    v_won := (v_participant.team_side = v_match.winner_side);

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

-- ============================================================
-- Update head-to-head stats after a match
-- ============================================================
CREATE OR REPLACE FUNCTION update_head_to_head(p_match_id UUID) RETURNS VOID AS $$
DECLARE
  v_match RECORD;
  v_side_a UUID[];
  v_side_b UUID[];
  v_pa UUID;
  v_pb UUID;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;

  SELECT ARRAY_AGG(player_id) INTO v_side_a FROM match_participants WHERE match_id = p_match_id AND team_side = 'a';
  SELECT ARRAY_AGG(player_id) INTO v_side_b FROM match_participants WHERE match_id = p_match_id AND team_side = 'b';

  FOREACH v_pa IN ARRAY v_side_a LOOP
    FOREACH v_pb IN ARRAY v_side_b LOOP
      INSERT INTO head_to_head_stats (player_a_id, player_b_id, match_type, total_matches, player_a_wins, player_b_wins)
      VALUES (LEAST(v_pa, v_pb), GREATEST(v_pa, v_pb), v_match.match_type, 1,
              CASE WHEN (v_match.winner_side = 'a' AND v_pa < v_pb) OR (v_match.winner_side = 'b' AND v_pa > v_pb) THEN 1 ELSE 0 END,
              CASE WHEN (v_match.winner_side = 'b' AND v_pa < v_pb) OR (v_match.winner_side = 'a' AND v_pa > v_pb) THEN 1 ELSE 0 END)
      ON CONFLICT (player_a_id, player_b_id, match_type)
      DO UPDATE SET
        total_matches = head_to_head_stats.total_matches + 1,
        player_a_wins = head_to_head_stats.player_a_wins +
          CASE WHEN (v_match.winner_side = 'a' AND v_pa < v_pb) OR (v_match.winner_side = 'b' AND v_pa > v_pb) THEN 1 ELSE 0 END,
        player_b_wins = head_to_head_stats.player_b_wins +
          CASE WHEN (v_match.winner_side = 'b' AND v_pa < v_pb) OR (v_match.winner_side = 'a' AND v_pa > v_pb) THEN 1 ELSE 0 END,
        last_played_at = NOW(),
        updated_at = NOW();
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Apply walkover result
-- ============================================================
CREATE OR REPLACE FUNCTION apply_walkover_result(p_walkover_id UUID) RETURNS VOID AS $$
DECLARE
  v_walkover RECORD;
  v_challenge RECORD;
  v_forfeit_side TEXT;
  v_winner_side TEXT;
BEGIN
  SELECT * INTO v_walkover FROM walkovers WHERE id = p_walkover_id;
  IF v_walkover IS NULL THEN RAISE EXCEPTION 'Walkover not found'; END IF;

  SELECT * INTO v_challenge FROM challenges WHERE id = v_walkover.challenge_id;

  -- Determine which side forfeited
  SELECT team_side INTO v_forfeit_side FROM challenge_participants
  WHERE challenge_id = v_walkover.challenge_id AND player_id = v_walkover.forfeit_player_id LIMIT 1;

  v_winner_side := CASE WHEN v_forfeit_side = 'a' THEN 'b' ELSE 'a' END;

  -- Update walkover
  UPDATE walkovers SET status = 'confirmed', admin_confirmed_at = NOW() WHERE id = p_walkover_id;

  -- Update challenge
  UPDATE challenges SET status = 'walkover_confirmed', updated_at = NOW() WHERE id = v_walkover.challenge_id;

  -- Elo penalty for no-shows (lose 15 points)
  IF v_walkover.walkover_type = 'no_show' THEN
    IF v_challenge.type = 'singles' THEN
      UPDATE ratings SET singles_elo = GREATEST(singles_elo - 15, 800), updated_at = NOW()
      WHERE player_id = v_walkover.forfeit_player_id;
    ELSE
      UPDATE ratings SET doubles_elo = GREATEST(doubles_elo - 15, 800), updated_at = NOW()
      WHERE player_id = v_walkover.forfeit_player_id;
    END IF;

    UPDATE walkovers SET elo_penalty_applied = TRUE WHERE id = p_walkover_id;
  END IF;

  -- Update reliability
  UPDATE reliability_metrics SET
    no_shows = CASE WHEN v_walkover.walkover_type = 'no_show' THEN no_shows + 1 ELSE no_shows END,
    late_cancellations = CASE WHEN v_walkover.walkover_type = 'withdrawal' AND v_walkover.notice_hours IS NOT NULL AND v_walkover.notice_hours < 24 THEN late_cancellations + 1 ELSE late_cancellations END,
    early_withdrawals = CASE WHEN v_walkover.walkover_type = 'withdrawal' AND (v_walkover.notice_hours IS NULL OR v_walkover.notice_hours >= 24) THEN early_withdrawals + 1 ELSE early_withdrawals END,
    walkover_flag = TRUE,
    walkovers_received = walkovers_received + 1,
    updated_at = NOW()
  WHERE player_id = v_walkover.forfeit_player_id;

  -- Audit
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, reason)
  VALUES (NULL, 'walkover_confirmed', 'walkover', p_walkover_id,
          format('Walkover (%s) confirmed for challenge %s', v_walkover.walkover_type, v_walkover.challenge_id));
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Reverse match result (admin function)
-- ============================================================
CREATE OR REPLACE FUNCTION reverse_match_result(p_match_id UUID) RETURNS VOID AS $$
DECLARE
  v_match RECORD;
  v_participant RECORD;
  v_elo_field TEXT;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF v_match IS NULL THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF v_match.result_status != 'confirmed' THEN RAISE EXCEPTION 'Can only reverse confirmed matches'; END IF;

  v_elo_field := CASE WHEN v_match.match_type = 'singles' THEN 'singles_elo' ELSE 'doubles_elo' END;

  -- Reverse each participant's rating
  FOR v_participant IN SELECT * FROM match_participants WHERE match_id = p_match_id AND rating_delta IS NOT NULL LOOP
    EXECUTE format('UPDATE ratings SET %I = %I - $1, updated_at = NOW() WHERE player_id = $2', v_elo_field, v_elo_field)
    USING v_participant.rating_delta, v_participant.player_id;
  END LOOP;

  -- Mark match as voided
  UPDATE matches SET result_status = 'voided', updated_at = NOW() WHERE id = p_match_id;

  -- Audit
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, reason)
  VALUES (NULL, 'match_reversed', 'match', p_match_id, 'Match result reversed by admin');
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Validate challenge creation
-- ============================================================
CREATE OR REPLACE FUNCTION validate_challenge_creation(
  p_creator_id UUID,
  p_opponent_id UUID,
  p_type TEXT,
  p_partner_id UUID DEFAULT NULL,
  p_opponent_partner_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_errors TEXT[] := '{}';
  v_active_count INTEGER;
  v_repeat_count INTEGER;
  v_creator_status TEXT;
  v_opponent_status TEXT;
BEGIN
  -- Check creator status
  SELECT status INTO v_creator_status FROM players WHERE id = p_creator_id;
  IF v_creator_status IN ('suspended', 'inactive', 'pending_approval') THEN
    v_errors := array_append(v_errors, 'Your account cannot create challenges');
  END IF;

  -- Check opponent status
  SELECT status INTO v_opponent_status FROM players WHERE id = p_opponent_id;
  IF v_opponent_status IN ('suspended', 'inactive', 'pending_approval') THEN
    v_errors := array_append(v_errors, 'Opponent cannot accept challenges');
  END IF;

  -- Self-challenge check
  IF p_creator_id = p_opponent_id THEN
    v_errors := array_append(v_errors, 'Cannot challenge yourself');
  END IF;

  -- Active challenge cap (max 3)
  SELECT COUNT(*) INTO v_active_count FROM challenges
  WHERE created_by = p_creator_id AND status IN ('proposed', 'partially_confirmed', 'accepted');
  IF v_active_count >= 3 THEN
    v_errors := array_append(v_errors, 'Maximum 3 active challenges reached');
  END IF;

  -- Repeat opponent in 7 days (max 2)
  SELECT COUNT(*) INTO v_repeat_count FROM matches m
  JOIN match_participants mp1 ON mp1.match_id = m.id AND mp1.player_id = p_creator_id
  JOIN match_participants mp2 ON mp2.match_id = m.id AND mp2.player_id = p_opponent_id AND mp2.team_side != mp1.team_side
  WHERE m.played_at > NOW() - INTERVAL '7 days' AND m.match_type = p_type::match_type_enum;
  IF v_repeat_count >= 2 THEN
    v_errors := array_append(v_errors, 'Maximum 2 rated matches vs same opponent in 7 days');
  END IF;

  -- Doubles partner checks
  IF p_type = 'doubles' THEN
    IF p_partner_id IS NULL OR p_opponent_partner_id IS NULL THEN
      v_errors := array_append(v_errors, 'Doubles requires a partner for each side');
    END IF;
    IF p_partner_id = p_creator_id OR p_partner_id = p_opponent_id OR p_opponent_partner_id = p_creator_id THEN
      v_errors := array_append(v_errors, 'Duplicate player in challenge');
    END IF;
  END IF;

  RETURN jsonb_build_object('valid', array_length(v_errors, 1) IS NULL, 'errors', to_jsonb(v_errors));
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Check session caps
-- ============================================================
CREATE OR REPLACE FUNCTION check_session_caps(
  p_player_id UUID,
  p_session_id UUID,
  p_match_type TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM matches m
  JOIN match_participants mp ON mp.match_id = m.id
  WHERE mp.player_id = p_player_id
    AND m.session_id = p_session_id
    AND m.match_type = p_match_type::match_type_enum
    AND m.rated_flag = TRUE
    AND m.result_status IN ('confirmed', 'pending_confirmation');

  RETURN v_count < 3; -- MAX_RATED_PER_SESSION = 3
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Check repeat opponent caps (max 2 in 7 days)
-- ============================================================
CREATE OR REPLACE FUNCTION check_repeat_opponent_caps(
  p_player_id UUID,
  p_opponent_id UUID,
  p_match_type TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM matches m
  JOIN match_participants mp1 ON mp1.match_id = m.id AND mp1.player_id = p_player_id
  JOIN match_participants mp2 ON mp2.match_id = m.id AND mp2.player_id = p_opponent_id AND mp2.team_side != mp1.team_side
  WHERE m.played_at > NOW() - INTERVAL '7 days'
    AND m.match_type = p_match_type::match_type_enum
    AND m.rated_flag = TRUE;

  RETURN v_count < 2;
END;
$$ LANGUAGE plpgsql;
