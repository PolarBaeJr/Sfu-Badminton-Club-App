-- ============================================================
-- 00041_configurable_rating_knobs.sql — make the rating settings real
-- ============================================================
-- platform_settings.rating_defaults has offered seven controls in the admin
-- Settings screen since 00006. Exactly ONE of them was ever read by rating
-- code: sweep_margin_multiplier, wired in 00029. The other six —
-- default_elo, provisional_threshold and the four K-factors — existed only as
-- a seed row and a form field. Editing them did nothing, silently.
--
-- That is worse than not offering them: prod currently has singles K set to
-- 64/36 (the doubles numbers), which someone clearly changed at some point
-- while the engine went on using the hardcoded 80/48.
--
-- This wires them up, and adds the two knobs that were missing entirely:
-- max_elo and min_elo. The rating cap was a hardcoded 1500 in two places at
-- once, and with players seeded near it the ladder had almost no headroom.
--
-- Reading settings per call is deliberate. These functions run once per match
-- confirmation, not in a hot loop, and the alternative — caching in a GUC or a
-- session variable — is how a settings change ends up applying to some matches
-- and not others.
-- ============================================================

-- Seed the two new keys without disturbing anything already set.
UPDATE platform_settings
   SET value = value
     || CASE WHEN value ? 'max_elo' THEN '{}'::jsonb ELSE jsonb_build_object('max_elo', 1500) END
     || CASE WHEN value ? 'min_elo' THEN '{}'::jsonb ELSE jsonb_build_object('min_elo', 100) END
 WHERE key = 'rating_defaults';

-- One accessor for every integer rating knob.
--
-- STABLE, not IMMUTABLE: it reads a table, and mislabelling it IMMUTABLE would
-- let the planner cache a stale value across a settings change inside a single
-- statement — the same trap called out in 00029.
--
-- Falls back to the caller's default on a missing key, a NULL, or a value that
-- will not cast. A malformed setting must never be able to zero out a K-factor
-- or collapse the rating range; the bounds below are the backstop.
CREATE OR REPLACE FUNCTION rating_setting_int(p_key TEXT, p_default INTEGER)
RETURNS INTEGER AS $$
DECLARE
  v_raw TEXT;
  v_val INTEGER;
BEGIN
  SELECT value->>p_key INTO v_raw FROM platform_settings WHERE key = 'rating_defaults';
  IF v_raw IS NULL OR v_raw = '' THEN RETURN p_default; END IF;
  BEGIN
    v_val := v_raw::INTEGER;
  EXCEPTION WHEN OTHERS THEN
    RETURN p_default;
  END;
  RETURN COALESCE(v_val, p_default);
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION rating_setting_int(TEXT, INTEGER) IS
  'Reads an integer from platform_settings.rating_defaults, falling back to the supplied default when the key is absent, null, or not castable.';

-- Clamp bounds, sanity-checked. max must exceed min or every rating collapses
-- to a single value; if the settings say otherwise the hardcoded pair wins.
CREATE OR REPLACE FUNCTION rating_bounds(OUT lo INTEGER, OUT hi INTEGER) AS $$
BEGIN
  lo := rating_setting_int('min_elo', 100);
  hi := rating_setting_int('max_elo', 1500);
  IF hi <= lo THEN
    lo := 100;
    hi := 1500;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- Now clamps to the configured range instead of a literal [100, 1500].
CREATE OR REPLACE FUNCTION calculate_elo_update(
  p_player_rating INTEGER,
  p_opponent_rating INTEGER,
  p_k_factor INTEGER,
  p_format_weight NUMERIC,
  p_event_multiplier NUMERIC,
  p_won BOOLEAN
)
RETURNS TABLE(new_rating INTEGER, delta INTEGER, expected NUMERIC) AS $$
DECLARE
  v_expected NUMERIC;
  v_actual NUMERIC;
  v_delta INTEGER;
  v_new INTEGER;
  v_lo INTEGER;
  v_hi INTEGER;
BEGIN
  v_expected := 1.0 / (1.0 + POWER(10, (p_opponent_rating - p_player_rating) / 800.0));
  v_actual := CASE WHEN p_won THEN 1.0 ELSE 0.0 END;
  v_delta := ROUND(p_k_factor * p_format_weight * p_event_multiplier * (v_actual - v_expected));

  SELECT lo, hi INTO v_lo, v_hi FROM rating_bounds();

  -- Clamp the rating, then derive the delta FROM the clamped rating so the two
  -- stay consistent at the bounds. Note this is what makes the cap lossy: at
  -- the ceiling the winner's delta becomes 0 while the loser still drops in
  -- full, so rating leaves the ladder. Raising max_elo is now a settings
  -- change rather than a migration.
  v_new := GREATEST(v_lo, LEAST(v_hi, p_player_rating + v_delta));

  RETURN QUERY SELECT
    v_new AS new_rating,
    (v_new - p_player_rating) AS delta,
    v_expected AS expected;
END;
$$ LANGUAGE plpgsql STABLE;

-- ------------------------------------------------------------
-- apply_match_result: K-factor and provisional threshold from settings
-- ------------------------------------------------------------
-- Rebuilt from the LIVE definition (pg_get_functiondef) rather than from the
-- copy in 00028, so any later hand-patch on the server is preserved. Only the
-- K-factor selection, the provisional threshold and the new variable differ.
--
-- The provisional-flag reset inside the dynamic UPDATE is passed as bind
-- parameter $8, NOT concatenated into the format() string — string-building a
-- value into that literal is how you get an injection or a syntax error that
-- only shows up at runtime.
CREATE OR REPLACE FUNCTION public.apply_match_result(p_match_id uuid, p_confirmed_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match RECORD;
  v_threshold INTEGER := rating_setting_int('provisional_threshold', 8);
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
      v_k_factor := CASE WHEN v_participant.singles_provisional OR v_participant.singles_matches_played < v_threshold
                         THEN rating_setting_int('singles_k_provisional', 80)
                         ELSE rating_setting_int('singles_k_established', 48) END;
    ELSE
      v_k_factor := CASE WHEN v_participant.doubles_provisional OR v_participant.doubles_matches_played < v_threshold
                         THEN rating_setting_int('doubles_k_provisional', 64)
                         ELSE rating_setting_int('doubles_k_established', 36) END;
    END IF;

    -- Calculate Elo delta
    SELECT cu.new_rating, cu.delta INTO v_new_rating, v_delta
    FROM calculate_elo_update(v_participant.pre_rating, v_opponent_rating, v_k_factor, v_format_weight, v_event_mult, v_won,
                              get_margin_multiplier(v_participant.games_won, v_participant.games_lost)) cu;

    -- Update match_participants
    UPDATE match_participants SET
      post_rating = v_new_rating,
      rating_delta = v_delta,
      win_flag = v_won
    WHERE id = v_participant.id;

    -- Update ratings table using dynamic SQL
    EXECUTE format(
      'UPDATE ratings SET %I = $1, %I = %I + 1, %I = CASE WHEN $2 THEN %I + 1 ELSE %I END, %I = CASE WHEN NOT $2 THEN %I + 1 ELSE %I END, %I = $3 + COALESCE(%I, 0), %I = $4 + COALESCE(%I, 0), %I = $5 + COALESCE(%I, 0), %I = $6 + COALESCE(%I, 0), %I = CASE WHEN $2 THEN GREATEST(COALESCE(%I, 0) + 1, 1) ELSE LEAST(COALESCE(%I, 0) - 1, -1) END, %I = CASE WHEN %I + 1 >= $8 THEN FALSE ELSE %I END, updated_at = NOW() WHERE player_id = $7',
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
    ) USING v_new_rating, v_won, v_participant.points_scored, v_participant.points_allowed, v_participant.games_won, v_participant.games_lost, v_participant.player_id, v_threshold;

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
$function$

