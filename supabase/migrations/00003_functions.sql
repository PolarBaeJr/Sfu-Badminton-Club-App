-- ============================================================
-- 00003_functions.sql — Database functions (final bodies)
--
-- Consolidated baseline: exactly one definition per function.
-- Every SECURITY DEFINER function pins search_path to
-- "public, pg_temp" inline so a malicious role cannot hijack
-- unqualified object references via a crafted search_path
-- (CVE-2018-1058 class issue).
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Helper: Check if player is admin or coach
CREATE OR REPLACE FUNCTION is_admin_or_coach(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  -- user_role was simplified to player/admin; 'coach_executive' no longer exists
  -- (the old IN ('admin','coach_executive') literal errored at runtime post-simplification)
  RETURN EXISTS (
    SELECT 1 FROM players WHERE user_id = p_user_id AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Helper: Get player_id from user_id
CREATE OR REPLACE FUNCTION get_player_id(p_user_id UUID)
RETURNS UUID AS $$
  SELECT id FROM players WHERE user_id = p_user_id LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Helper: Coarse admin-console access level for a user.
-- Returns 'admin' for full admins, 'exec' for executive-team members, or NULL
-- for everyone else. is_admin (which RLS depends on) is intentionally left
-- untouched; this powers the exec RBAC layer in the admin app.
CREATE OR REPLACE FUNCTION admin_access_level(p_user_id UUID)
RETURNS TEXT AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND role = 'admin') THEN
    RETURN 'admin';
  ELSIF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND is_exec = TRUE) THEN
    RETURN 'exec';
  ELSE
    RETURN NULL;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION admin_access_level(UUID) TO authenticated;

-- Helper: The current active season (with its per-status fees). Anon-safe so
-- the logged-out login page can show the season name; exposes only public
-- season fields.
CREATE OR REPLACE FUNCTION get_active_season()
RETURNS TABLE(id uuid, name text, competitive_fee_cents int, recreational_fee_cents int) AS $$
  SELECT id, name, competitive_fee_cents, recreational_fee_cents
  FROM seasons
  WHERE active_flag = TRUE
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION get_active_season() TO anon, authenticated;

-- Helper: The club executive team, for the public /exec page. Anon-safe;
-- exposes only public fields (public name, title, avatar) for players flagged
-- is_exec. Ordered by title then name so titled execs (President, VP, ...)
-- sort ahead of untitled ones.
CREATE OR REPLACE FUNCTION get_executives()
RETURNS TABLE(id uuid, name text, exec_title text, avatar_url text) AS $$
  SELECT id, COALESCE(display_name, full_name) AS name, exec_title, avatar_url
  FROM players
  WHERE is_exec = TRUE AND active_flag = TRUE
  ORDER BY (exec_title IS NULL), exec_title, COALESCE(display_name, full_name);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION get_executives() TO anon, authenticated;

-- ============================================================
-- CORE: Elo Calculation
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
  v_new INTEGER;
BEGIN
  v_expected := 1.0 / (1.0 + POWER(10, (p_opponent_rating - p_player_rating)::NUMERIC / 800));
  v_actual := CASE WHEN p_won THEN 1.0 ELSE 0.0 END;
  v_delta := ROUND(p_k_factor * p_format_weight * p_event_multiplier * (v_actual - v_expected));

  -- Clamp the new rating to [100, 1500], then derive the delta from the clamped
  -- value so new_rating and delta stay consistent at the bounds (mirrors the TS
  -- engine's clampElo).
  v_new := GREATEST(100, LEAST(1500, p_player_rating + v_delta));

  RETURN QUERY SELECT
    v_new AS new_rating,
    (v_new - p_player_rating) AS delta,
    v_expected AS expected;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

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
-- CORE: Apply Match Result (atomic Elo update)
--
-- The winner is derived server-side from match_games instead of
-- trusting the client-supplied winner_side — except for walkover
-- matches, which legitimately have no games (their winner_side is
-- computed by apply_walkover_result, opposite the forfeiting
-- player). matches.elo_weight_override carries the reduced
-- walkover weighting (0.50 withdrawal < 24h, 0.75 no-show) and is
-- NULL (weight 1.0) for all normal matches.
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
$$ LANGUAGE plpgsql;

-- ============================================================
-- Apply Walkover Result
--
-- Inserts the walkover match as 'pending_confirmation' when ELO
-- will be applied, because apply_match_result rejects any other
-- status and then flips it to 'confirmed' itself. Unrated / zero
-- weight walkovers go straight to result_status = 'walkover'.
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- Atomic increment helper for reliability metrics to avoid
-- read-modify-write race conditions in createChallenge.
-- ============================================================

CREATE OR REPLACE FUNCTION increment_challenges_issued(p_player_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO reliability_metrics (player_id, challenges_issued)
  VALUES (p_player_id, 1)
  ON CONFLICT (player_id)
  DO UPDATE SET
    challenges_issued = reliability_metrics.challenges_issued + 1,
    updated_at = NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION increment_challenges_issued(UUID) TO authenticated;

-- ============================================================
-- Atomic player + initial ratings creation. Replaces the two-step
-- inserts in player onboarding (apps/player/src/lib/actions/profile.ts)
-- and admin createPlayer (apps/admin/src/lib/actions.ts), where a failed
-- second insert could leave a player without a ratings row.
--
-- Note: trigger_init_player_records (00004_triggers.sql) only fires on
-- UPDATE OF status (pending_approval -> active), never on INSERT, so this
-- function must insert the ratings row itself. The trigger's later insert
-- uses ON CONFLICT (player_id) DO NOTHING, so no double-insert occurs.
--
-- The ratings defaults (400/400, provisional, K 80/64) mirror what both
-- call sites inserted before this function existed. onboarding_completed
-- is TRUE only for self-onboarding (p_user_id present): admin-created
-- placeholder players have no auth user and have not onboarded.
-- ============================================================

CREATE OR REPLACE FUNCTION create_player_with_rating(
  p_user_id uuid,
  p_email text,
  p_full_name text,
  p_display_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_status player_status DEFAULT 'pending_approval',
  p_role user_role DEFAULT 'player'
) RETURNS uuid AS $$
DECLARE
  v_player_id uuid;
BEGIN
  -- Mirror the self-onboarding RLS intent of players_self_insert
  -- (00005_rls.sql): a regular user may only create their own pending
  -- player row; anything else requires the service role.
  IF NOT (
    auth.role() = 'service_role'
    OR (
      p_user_id IS NOT NULL
      AND p_user_id = auth.uid()
      AND p_status = 'pending_approval'
      AND p_role = 'player'
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to create this player';
  END IF;

  INSERT INTO players (user_id, email, full_name, display_name, phone, status, role, onboarding_completed)
  VALUES (p_user_id, p_email, p_full_name, p_display_name, p_phone, p_status, p_role, p_user_id IS NOT NULL)
  RETURNING id INTO v_player_id;

  INSERT INTO ratings (
    player_id, singles_elo, doubles_elo,
    singles_provisional, doubles_provisional,
    singles_k_factor, doubles_k_factor
  ) VALUES (v_player_id, 400, 400, TRUE, TRUE, 80, 64);

  RETURN v_player_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION create_player_with_rating(uuid, text, text, text, text, player_status, user_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_player_with_rating(uuid, text, text, text, text, player_status, user_role) TO authenticated, service_role;
