-- ============================================================
-- 00003_functions.sql — Core database functions
-- ============================================================

-- Helper: Get format weight
CREATE OR REPLACE FUNCTION get_format_weight(fmt match_format)
RETURNS NUMERIC AS $$
BEGIN
  RETURN CASE fmt
    WHEN 'bo3_21' THEN 1.25
    WHEN 'single_21' THEN 1.00
    WHEN 'single_15' THEN 0.75
    WHEN 'single_11' THEN 0.50
    ELSE 1.00
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Helper: Get event multiplier
CREATE OR REPLACE FUNCTION get_event_multiplier(evt event_type_enum)
RETURNS NUMERIC AS $$
BEGIN
  RETURN CASE evt
    WHEN 'rated_challenge' THEN 1.00
    WHEN 'trial' THEN 1.15
    WHEN 'tournament' THEN 1.15
    WHEN 'admin_entered' THEN 1.00
    WHEN 'casual' THEN 0.00
    ELSE 1.00
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Helper: Check if player is admin
CREATE OR REPLACE FUNCTION is_admin(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM players WHERE user_id = p_user_id AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Helper: Check if player is admin or coach
CREATE OR REPLACE FUNCTION is_admin_or_coach(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM players WHERE user_id = p_user_id AND role IN ('admin', 'coach_executive')
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Helper: Get player_id from user_id
CREATE OR REPLACE FUNCTION get_player_id(p_user_id UUID)
RETURNS UUID AS $$
  SELECT id FROM players WHERE user_id = p_user_id LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ============================================================
-- CORE: Elo Calculation
-- ============================================================

CREATE OR REPLACE FUNCTION calculate_elo_update(
  p_player_rating INTEGER,
  p_opponent_rating INTEGER,
  p_k_factor INTEGER,
  p_format_weight NUMERIC,
  p_event_multiplier NUMERIC,
  p_actual NUMERIC, -- 1.0 win, 0.0 loss
  p_elo_weight_override NUMERIC DEFAULT NULL
)
RETURNS INTEGER AS $$
DECLARE
  v_expected NUMERIC;
  v_delta NUMERIC;
  v_weight NUMERIC;
BEGIN
  v_expected := 1.0 / (1.0 + POWER(10.0, (p_opponent_rating::NUMERIC - p_player_rating::NUMERIC) / 400.0));
  v_weight := COALESCE(p_elo_weight_override, 1.0);
  v_delta := p_k_factor * p_format_weight * p_event_multiplier * v_weight * (p_actual - v_expected);
  RETURN ROUND(v_delta);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- CORE: Apply Match Result (atomic transaction)
-- ============================================================

CREATE OR REPLACE FUNCTION apply_match_result(
  p_match_id UUID,
  p_confirmed_by UUID
)
RETURNS VOID AS $$
DECLARE
  v_match RECORD;
  v_participant RECORD;
  v_team_a_rating NUMERIC;
  v_team_b_rating NUMERIC;
  v_team_a_count INTEGER;
  v_team_b_count INTEGER;
  v_delta INTEGER;
  v_actual NUMERIC;
  v_opponent_rating INTEGER;
  v_is_doubles BOOLEAN;
  v_k INTEGER;
  v_match_type TEXT;
BEGIN
  -- Lock the match row
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;

  IF v_match IS NULL THEN
    RAISE EXCEPTION 'Match not found';
  END IF;

  IF v_match.result_status = 'confirmed' THEN
    RAISE EXCEPTION 'Match already confirmed';
  END IF;

  IF NOT v_match.completed_flag THEN
    RAISE EXCEPTION 'Match not completed';
  END IF;

  IF v_match.winner_side IS NULL THEN
    RAISE EXCEPTION 'No winner set';
  END IF;

  v_is_doubles := v_match.match_type = 'doubles';

  -- Calculate team average ratings
  SELECT COALESCE(AVG(mp.pre_rating), 1200), COUNT(*)
  INTO v_team_a_rating, v_team_a_count
  FROM match_participants mp WHERE mp.match_id = p_match_id AND mp.team_side = 'a';

  SELECT COALESCE(AVG(mp.pre_rating), 1200), COUNT(*)
  INTO v_team_b_rating, v_team_b_count
  FROM match_participants mp WHERE mp.match_id = p_match_id AND mp.team_side = 'b';

  -- Only apply Elo if rated and not casual
  IF v_match.rated_flag AND v_match.event_type != 'casual' THEN
    -- Update each participant
    FOR v_participant IN
      SELECT mp.*, r.singles_elo, r.doubles_elo,
             r.singles_k_factor, r.doubles_k_factor,
             r.singles_provisional, r.doubles_provisional,
             r.singles_matches_played, r.doubles_matches_played
      FROM match_participants mp
      JOIN ratings r ON r.player_id = mp.player_id
      WHERE mp.match_id = p_match_id
    LOOP
      -- Determine actual result
      IF v_participant.team_side = v_match.winner_side THEN
        v_actual := 1.0;
      ELSE
        v_actual := 0.0;
      END IF;

      -- Determine opponent rating (team average)
      IF v_participant.team_side = 'a' THEN
        v_opponent_rating := ROUND(v_team_b_rating);
      ELSE
        v_opponent_rating := ROUND(v_team_a_rating);
      END IF;

      -- Get K factor
      IF v_is_doubles THEN
        v_k := v_participant.doubles_k_factor;
      ELSE
        v_k := v_participant.singles_k_factor;
      END IF;

      -- Calculate delta
      v_delta := calculate_elo_update(
        v_participant.pre_rating,
        v_opponent_rating,
        v_k,
        v_match.format_weight,
        v_match.event_multiplier,
        v_actual,
        v_match.elo_weight_override
      );

      -- Update match_participants
      UPDATE match_participants
      SET post_rating = v_participant.pre_rating + v_delta,
          rating_delta = v_delta,
          win_flag = (v_actual = 1.0)
      WHERE id = v_participant.id;

      -- Update ratings table
      IF v_is_doubles THEN
        UPDATE ratings SET
          doubles_elo = doubles_elo + v_delta,
          doubles_matches_played = doubles_matches_played + 1,
          doubles_wins = doubles_wins + (CASE WHEN v_actual = 1.0 THEN 1 ELSE 0 END),
          doubles_losses = doubles_losses + (CASE WHEN v_actual = 0.0 THEN 1 ELSE 0 END),
          doubles_points_scored = doubles_points_scored + v_participant.points_scored,
          doubles_points_allowed = doubles_points_allowed + v_participant.points_allowed,
          doubles_games_won = doubles_games_won + v_participant.games_won,
          doubles_games_lost = doubles_games_lost + v_participant.games_lost,
          doubles_provisional = (doubles_matches_played + 1 < 8),
          doubles_k_factor = CASE WHEN doubles_matches_played + 1 >= 8 THEN 18 ELSE 32 END,
          current_doubles_streak = CASE
            WHEN v_actual = 1.0 THEN GREATEST(current_doubles_streak, 0) + 1
            ELSE LEAST(current_doubles_streak, 0) - 1
          END,
          best_doubles_streak = GREATEST(best_doubles_streak,
            CASE WHEN v_actual = 1.0 THEN GREATEST(current_doubles_streak, 0) + 1 ELSE best_doubles_streak END
          ),
          updated_at = NOW()
        WHERE player_id = v_participant.player_id;
      ELSE
        UPDATE ratings SET
          singles_elo = singles_elo + v_delta,
          singles_matches_played = singles_matches_played + 1,
          singles_wins = singles_wins + (CASE WHEN v_actual = 1.0 THEN 1 ELSE 0 END),
          singles_losses = singles_losses + (CASE WHEN v_actual = 0.0 THEN 1 ELSE 0 END),
          singles_points_scored = singles_points_scored + v_participant.points_scored,
          singles_points_allowed = singles_points_allowed + v_participant.points_allowed,
          singles_games_won = singles_games_won + v_participant.games_won,
          singles_games_lost = singles_games_lost + v_participant.games_lost,
          singles_provisional = (singles_matches_played + 1 < 8),
          singles_k_factor = CASE WHEN singles_matches_played + 1 >= 8 THEN 24 ELSE 40 END,
          current_singles_streak = CASE
            WHEN v_actual = 1.0 THEN GREATEST(current_singles_streak, 0) + 1
            ELSE LEAST(current_singles_streak, 0) - 1
          END,
          best_singles_streak = GREATEST(best_singles_streak,
            CASE WHEN v_actual = 1.0 THEN GREATEST(current_singles_streak, 0) + 1 ELSE best_singles_streak END
          ),
          updated_at = NOW()
        WHERE player_id = v_participant.player_id;
      END IF;

      -- Update last_active_at
      UPDATE players SET last_active_at = NOW() WHERE id = v_participant.player_id;
    END LOOP;
  ELSE
    -- Non-rated: just mark win/loss flags
    UPDATE match_participants
    SET win_flag = (team_side = v_match.winner_side),
        post_rating = pre_rating,
        rating_delta = 0
    WHERE match_id = p_match_id;
  END IF;

  -- Update match status
  UPDATE matches SET
    result_status = 'confirmed',
    confirmed_by = p_confirmed_by,
    updated_at = NOW()
  WHERE id = p_match_id;

  -- Update challenge status if linked
  IF v_match.challenge_id IS NOT NULL THEN
    UPDATE challenges SET status = 'completed', updated_at = NOW()
    WHERE id = v_match.challenge_id;
  END IF;

  -- Update reliability metrics
  UPDATE reliability_metrics SET
    matches_completed = matches_completed + 1,
    updated_at = NOW()
  WHERE player_id IN (SELECT player_id FROM match_participants WHERE match_id = p_match_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Apply Walkover Result
-- ============================================================

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
  v_match_id UUID;
  v_winner_side team_side;
  v_participant RECORD;
  v_team_a_rating NUMERIC;
  v_team_b_rating NUMERIC;
  v_delta INTEGER;
  v_actual NUMERIC;
  v_opponent_rating INTEGER;
  v_k INTEGER;
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

  -- Create a match record for the walkover
  v_is_doubles := v_challenge.type = 'doubles';

  -- Determine winner side (opposite of forfeiting player)
  SELECT team_side INTO v_winner_side
  FROM challenge_participants
  WHERE challenge_id = v_walkover.challenge_id AND player_id = v_walkover.forfeit_player_id;

  IF v_winner_side = 'a' THEN v_winner_side := 'b'; ELSE v_winner_side := 'a'; END IF;

  -- Create match
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
    TRUE, v_winner_side, 'walkover', v_walkover.walkover_type,
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
  IF v_elo_weight > 0 AND v_challenge.rated_flag THEN
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Validate Challenge Creation
-- ============================================================

CREATE OR REPLACE FUNCTION validate_challenge_creation(
  p_creator_id UUID,
  p_opponent_id UUID,
  p_type match_type_enum,
  p_partner_id UUID DEFAULT NULL,
  p_opponent_partner_id UUID DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_active_count INTEGER;
  v_existing_count INTEGER;
  v_creator_status player_status;
  v_opponent_status player_status;
  v_creator_elo INTEGER;
  v_opponent_elo INTEGER;
  v_elo_range INTEGER;
  v_errors JSONB := '[]'::JSONB;
BEGIN
  -- Check creator status
  SELECT status INTO v_creator_status FROM players WHERE id = p_creator_id;
  IF v_creator_status IN ('suspended', 'inactive', 'pending_approval') THEN
    v_errors := v_errors || jsonb_build_array('Creator is not eligible to create challenges');
  END IF;

  -- Check opponent status
  SELECT status INTO v_opponent_status FROM players WHERE id = p_opponent_id;
  IF v_opponent_status IN ('suspended', 'inactive', 'pending_approval') THEN
    v_errors := v_errors || jsonb_build_array('Opponent is not eligible for challenges');
  END IF;

  -- Check active outgoing challenge limit (max 3)
  SELECT COUNT(*) INTO v_active_count
  FROM challenges
  WHERE created_by = p_creator_id
  AND status IN ('proposed', 'partially_confirmed', 'accepted');
  IF v_active_count >= 3 THEN
    v_errors := v_errors || jsonb_build_array('Maximum 3 active challenges reached');
  END IF;

  -- Check duplicate challenge (max 1 active against same opponent)
  IF p_type = 'singles' THEN
    SELECT COUNT(*) INTO v_existing_count
    FROM challenges c
    JOIN challenge_participants cp1 ON cp1.challenge_id = c.id AND cp1.player_id = p_creator_id
    JOIN challenge_participants cp2 ON cp2.challenge_id = c.id AND cp2.player_id = p_opponent_id
    WHERE c.status IN ('proposed', 'partially_confirmed', 'accepted')
    AND c.type = 'singles';
  ELSE
    SELECT COUNT(*) INTO v_existing_count
    FROM challenges c
    WHERE c.status IN ('proposed', 'partially_confirmed', 'accepted')
    AND c.type = 'doubles'
    AND c.id IN (
      SELECT challenge_id FROM challenge_participants WHERE player_id = p_creator_id
    )
    AND c.id IN (
      SELECT challenge_id FROM challenge_participants WHERE player_id = p_opponent_id
    );
  END IF;

  IF v_existing_count > 0 THEN
    v_errors := v_errors || jsonb_build_array('Active challenge already exists against this opponent');
  END IF;

  -- Check Elo range for singles (get from platform_settings)
  IF p_type = 'singles' THEN
    SELECT COALESCE((value->>'elo_range')::INTEGER, 150)
    INTO v_elo_range FROM platform_settings WHERE key = 'challenge_rules';

    SELECT singles_elo INTO v_creator_elo FROM ratings WHERE player_id = p_creator_id;
    SELECT singles_elo INTO v_opponent_elo FROM ratings WHERE player_id = p_opponent_id;

    IF ABS(COALESCE(v_creator_elo, 1200) - COALESCE(v_opponent_elo, 1200)) > v_elo_range THEN
      v_errors := v_errors || jsonb_build_array('Opponent is outside recommended Elo range');
    END IF;
  END IF;

  RETURN jsonb_build_object('valid', jsonb_array_length(v_errors) = 0, 'errors', v_errors);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- Check Session Caps
-- ============================================================

CREATE OR REPLACE FUNCTION check_session_caps(
  p_player_id UUID,
  p_session_id UUID,
  p_match_type match_type_enum
)
RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM matches m
  JOIN match_participants mp ON mp.match_id = m.id
  WHERE mp.player_id = p_player_id
  AND m.session_id = p_session_id
  AND m.match_type = p_match_type
  AND m.rated_flag = TRUE
  AND m.result_status IN ('confirmed', 'pending_confirmation');

  RETURN v_count < 3;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- Check Repeat Opponent Caps
-- ============================================================

CREATE OR REPLACE FUNCTION check_repeat_opponent_caps(
  p_player_id UUID,
  p_opponent_id UUID,
  p_match_type match_type_enum
)
RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_match_type = 'singles' THEN
    SELECT COUNT(*) INTO v_count
    FROM matches m
    JOIN match_participants mp1 ON mp1.match_id = m.id AND mp1.player_id = p_player_id
    JOIN match_participants mp2 ON mp2.match_id = m.id AND mp2.player_id = p_opponent_id
    WHERE m.match_type = 'singles'
    AND m.rated_flag = TRUE
    AND m.result_status = 'confirmed'
    AND m.played_at >= NOW() - INTERVAL '7 days';
    RETURN v_count < 2;
  END IF;

  -- For doubles, check is done at application level with all 4 players
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- Check Doubles Repeat Caps (all 4 players same combo)
-- ============================================================

CREATE OR REPLACE FUNCTION check_doubles_repeat_caps(
  p_team_a_ids UUID[],
  p_team_b_ids UUID[]
)
RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
  v_all_ids UUID[];
BEGIN
  v_all_ids := p_team_a_ids || p_team_b_ids;

  SELECT COUNT(*) INTO v_count
  FROM matches m
  WHERE m.match_type = 'doubles'
  AND m.rated_flag = TRUE
  AND m.result_status = 'confirmed'
  AND m.played_at >= NOW() - INTERVAL '7 days'
  AND (
    SELECT array_agg(mp.player_id ORDER BY mp.player_id)
    FROM match_participants mp WHERE mp.match_id = m.id
  ) = (SELECT array_agg(u ORDER BY u) FROM unnest(v_all_ids) u);

  RETURN v_count < 2;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- Season Compression
-- ============================================================

CREATE OR REPLACE FUNCTION calculate_season_compression(p_factor NUMERIC DEFAULT 0.1)
RETURNS VOID AS $$
BEGIN
  UPDATE ratings SET
    singles_elo = singles_elo - ROUND((singles_elo - 1200) * p_factor)::INTEGER,
    doubles_elo = doubles_elo - ROUND((doubles_elo - 1200) * p_factor)::INTEGER,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Capture Season Snapshot
-- ============================================================

CREATE OR REPLACE FUNCTION capture_season_snapshot(p_season_id UUID)
RETURNS VOID AS $$
BEGIN
  INSERT INTO season_snapshots (
    player_id, season_id, final_singles_elo, final_doubles_elo,
    singles_rank, doubles_rank,
    singles_matches_played, doubles_matches_played,
    singles_wins, singles_losses, doubles_wins, doubles_losses
  )
  SELECT
    r.player_id, p_season_id, r.singles_elo, r.doubles_elo,
    ROW_NUMBER() OVER (ORDER BY r.singles_elo DESC),
    ROW_NUMBER() OVER (ORDER BY r.doubles_elo DESC),
    r.singles_matches_played, r.doubles_matches_played,
    r.singles_wins, r.singles_losses, r.doubles_wins, r.doubles_losses
  FROM ratings r
  JOIN players p ON p.id = r.player_id
  WHERE p.active_flag = TRUE
  ON CONFLICT (player_id, season_id) DO UPDATE SET
    final_singles_elo = EXCLUDED.final_singles_elo,
    final_doubles_elo = EXCLUDED.final_doubles_elo,
    singles_rank = EXCLUDED.singles_rank,
    doubles_rank = EXCLUDED.doubles_rank,
    singles_matches_played = EXCLUDED.singles_matches_played,
    doubles_matches_played = EXCLUDED.doubles_matches_played,
    singles_wins = EXCLUDED.singles_wins,
    singles_losses = EXCLUDED.singles_losses,
    doubles_wins = EXCLUDED.doubles_wins,
    doubles_losses = EXCLUDED.doubles_losses,
    captured_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Reverse Match Result (for admin void/edit)
-- ============================================================

CREATE OR REPLACE FUNCTION reverse_match_result(p_match_id UUID)
RETURNS VOID AS $$
DECLARE
  v_match RECORD;
  v_participant RECORD;
  v_is_doubles BOOLEAN;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF v_match IS NULL OR v_match.result_status NOT IN ('confirmed', 'walkover') THEN
    RAISE EXCEPTION 'Match not confirmed, cannot reverse';
  END IF;

  v_is_doubles := v_match.match_type = 'doubles';

  FOR v_participant IN
    SELECT * FROM match_participants WHERE match_id = p_match_id
  LOOP
    IF v_participant.rating_delta IS NOT NULL AND v_match.rated_flag THEN
      IF v_is_doubles THEN
        UPDATE ratings SET
          doubles_elo = doubles_elo - v_participant.rating_delta,
          doubles_matches_played = GREATEST(doubles_matches_played - 1, 0),
          doubles_wins = GREATEST(doubles_wins - (CASE WHEN v_participant.win_flag THEN 1 ELSE 0 END), 0),
          doubles_losses = GREATEST(doubles_losses - (CASE WHEN NOT v_participant.win_flag THEN 1 ELSE 0 END), 0),
          doubles_points_scored = GREATEST(doubles_points_scored - v_participant.points_scored, 0),
          doubles_points_allowed = GREATEST(doubles_points_allowed - v_participant.points_allowed, 0),
          doubles_games_won = GREATEST(doubles_games_won - v_participant.games_won, 0),
          doubles_games_lost = GREATEST(doubles_games_lost - v_participant.games_lost, 0),
          doubles_provisional = (GREATEST(doubles_matches_played - 1, 0) < 8),
          doubles_k_factor = CASE WHEN GREATEST(doubles_matches_played - 1, 0) < 8 THEN 32 ELSE 18 END,
          updated_at = NOW()
        WHERE player_id = v_participant.player_id;
      ELSE
        UPDATE ratings SET
          singles_elo = singles_elo - v_participant.rating_delta,
          singles_matches_played = GREATEST(singles_matches_played - 1, 0),
          singles_wins = GREATEST(singles_wins - (CASE WHEN v_participant.win_flag THEN 1 ELSE 0 END), 0),
          singles_losses = GREATEST(singles_losses - (CASE WHEN NOT v_participant.win_flag THEN 1 ELSE 0 END), 0),
          singles_points_scored = GREATEST(singles_points_scored - v_participant.points_scored, 0),
          singles_points_allowed = GREATEST(singles_points_allowed - v_participant.points_allowed, 0),
          singles_games_won = GREATEST(singles_games_won - v_participant.games_won, 0),
          singles_games_lost = GREATEST(singles_games_lost - v_participant.games_lost, 0),
          singles_provisional = (GREATEST(singles_matches_played - 1, 0) < 8),
          singles_k_factor = CASE WHEN GREATEST(singles_matches_played - 1, 0) < 8 THEN 40 ELSE 24 END,
          updated_at = NOW()
        WHERE player_id = v_participant.player_id;
      END IF;
    END IF;
  END LOOP;

  -- Reset match participants
  UPDATE match_participants SET
    post_rating = NULL,
    rating_delta = NULL,
    win_flag = NULL
  WHERE match_id = p_match_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Update Head to Head Stats
-- ============================================================

CREATE OR REPLACE FUNCTION update_head_to_head(p_match_id UUID)
RETURNS VOID AS $$
DECLARE
  v_match RECORD;
  v_player_a UUID;
  v_player_b UUID;
  v_a_won BOOLEAN;
  v_a_points INTEGER;
  v_b_points INTEGER;
  v_sorted_a UUID;
  v_sorted_b UUID;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF v_match.match_type != 'singles' THEN RETURN; END IF;

  SELECT player_id, points_scored INTO v_player_a, v_a_points
  FROM match_participants WHERE match_id = p_match_id AND team_side = 'a' LIMIT 1;

  SELECT player_id, points_scored INTO v_player_b, v_b_points
  FROM match_participants WHERE match_id = p_match_id AND team_side = 'b' LIMIT 1;

  IF v_player_a IS NULL OR v_player_b IS NULL THEN RETURN; END IF;

  -- Sort IDs
  IF v_player_a < v_player_b THEN
    v_sorted_a := v_player_a; v_sorted_b := v_player_b;
  ELSE
    v_sorted_a := v_player_b; v_sorted_b := v_player_a;
    -- Swap points too
    v_a_points := v_b_points;
    SELECT points_scored INTO v_b_points FROM match_participants WHERE match_id = p_match_id AND player_id = v_sorted_b;
    SELECT points_scored INTO v_a_points FROM match_participants WHERE match_id = p_match_id AND player_id = v_sorted_a;
  END IF;

  v_a_won := (v_match.winner_side = 'a' AND v_sorted_a = v_player_a) OR
             (v_match.winner_side = 'b' AND v_sorted_a = v_player_b);

  INSERT INTO head_to_head_stats (player_a_id, player_b_id, match_type, total_matches, player_a_wins, player_b_wins, player_a_points, player_b_points, last_played_at)
  VALUES (v_sorted_a, v_sorted_b, 'singles', 1,
    CASE WHEN v_a_won THEN 1 ELSE 0 END,
    CASE WHEN v_a_won THEN 0 ELSE 1 END,
    v_a_points, v_b_points, NOW())
  ON CONFLICT (player_a_id, player_b_id, match_type) DO UPDATE SET
    total_matches = head_to_head_stats.total_matches + 1,
    player_a_wins = head_to_head_stats.player_a_wins + CASE WHEN v_a_won THEN 1 ELSE 0 END,
    player_b_wins = head_to_head_stats.player_b_wins + CASE WHEN v_a_won THEN 0 ELSE 1 END,
    player_a_points = head_to_head_stats.player_a_points + v_a_points,
    player_b_points = head_to_head_stats.player_b_points + v_b_points,
    last_played_at = NOW(),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Update Partnership Stats
-- ============================================================

CREATE OR REPLACE FUNCTION update_partnership_stats(p_match_id UUID)
RETURNS VOID AS $$
DECLARE
  v_match RECORD;
  v_team RECORD;
  v_p1 UUID;
  v_p2 UUID;
  v_sorted_a UUID;
  v_sorted_b UUID;
  v_won BOOLEAN;
  v_points_scored INTEGER;
  v_points_conceded INTEGER;
  v_avg_delta NUMERIC;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF v_match.match_type != 'doubles' THEN RETURN; END IF;

  -- Process each team
  FOR v_team IN
    SELECT team_side FROM (VALUES ('a'::team_side), ('b'::team_side)) t(team_side)
  LOOP
    SELECT array_agg(player_id ORDER BY player_id) INTO v_p1
    FROM match_participants WHERE match_id = p_match_id AND team_side = v_team.team_side;

    -- Skip if not 2 players
    CONTINUE WHEN array_length(
      (SELECT array_agg(player_id) FROM match_participants WHERE match_id = p_match_id AND team_side = v_team.team_side), 1
    ) != 2;

    SELECT player_id INTO v_p1 FROM match_participants
    WHERE match_id = p_match_id AND team_side = v_team.team_side
    ORDER BY player_id LIMIT 1;

    SELECT player_id INTO v_p2 FROM match_participants
    WHERE match_id = p_match_id AND team_side = v_team.team_side
    ORDER BY player_id OFFSET 1 LIMIT 1;

    IF v_p1 IS NULL OR v_p2 IS NULL THEN CONTINUE; END IF;

    v_sorted_a := LEAST(v_p1, v_p2);
    v_sorted_b := GREATEST(v_p1, v_p2);
    v_won := (v_team.team_side = v_match.winner_side);

    SELECT SUM(points_scored), SUM(points_allowed), AVG(COALESCE(rating_delta, 0))
    INTO v_points_scored, v_points_conceded, v_avg_delta
    FROM match_participants WHERE match_id = p_match_id AND team_side = v_team.team_side;

    INSERT INTO partnership_stats (player_a_id, player_b_id, matches_played, wins, losses, total_points_scored, total_points_conceded, avg_elo_delta, last_played_at)
    VALUES (v_sorted_a, v_sorted_b, 1,
      CASE WHEN v_won THEN 1 ELSE 0 END,
      CASE WHEN v_won THEN 0 ELSE 1 END,
      COALESCE(v_points_scored, 0), COALESCE(v_points_conceded, 0),
      COALESCE(v_avg_delta, 0), NOW())
    ON CONFLICT (player_a_id, player_b_id) DO UPDATE SET
      matches_played = partnership_stats.matches_played + 1,
      wins = partnership_stats.wins + CASE WHEN v_won THEN 1 ELSE 0 END,
      losses = partnership_stats.losses + CASE WHEN v_won THEN 0 ELSE 1 END,
      win_rate = ROUND(
        (partnership_stats.wins + CASE WHEN v_won THEN 1 ELSE 0 END)::NUMERIC /
        (partnership_stats.matches_played + 1) * 100, 2
      ),
      total_points_scored = partnership_stats.total_points_scored + COALESCE(v_points_scored, 0),
      total_points_conceded = partnership_stats.total_points_conceded + COALESCE(v_points_conceded, 0),
      avg_elo_delta = ROUND(
        (partnership_stats.avg_elo_delta * partnership_stats.matches_played + COALESCE(v_avg_delta, 0)) /
        (partnership_stats.matches_played + 1), 2
      ),
      last_played_at = NOW(),
      updated_at = NOW();
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
