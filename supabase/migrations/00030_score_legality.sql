-- ============================================================
-- 00030_score_legality.sql — enforce real badminton scoring
-- ============================================================
-- submit_match_result trusted the caller's scores entirely: it derived the
-- winner from them but never checked they were reachable. The Zod layer only
-- capped values at 30 and rejected ties, and since 00027 made the RPC the ONLY
-- write path, anything calling it directly bypassed even that.
--
-- Real results that got through: "21-20, 21-20, 21-20". Both problems are
-- visible there —
--   * 21-20 cannot happen. Rally scoring is first to 21 but win by two, so at
--     20-20 play continues (22-20, 23-21, …) up to the cap, where the next
--     point takes it. 30-29 IS legal; 21-20 is not.
--   * three games with one side winning all three cannot happen either. A
--     best-of-3 stops the moment someone clinches, so it is 2 games (2-0) or
--     3 (2-1) — never 3-0, because game three would never have been played.
--
-- Mirrors isLegalGameScore()/isLegalGameCount() in
-- packages/shared/src/utils/constants.ts; the two must stay in step.
--
-- The 21-point cap of 30 is the BWF rule. The 15- and 11-point caps are club
-- convention — change them in one place here (and in the TS table) if needed.
-- ============================================================

CREATE OR REPLACE FUNCTION format_target(p_format match_format)
RETURNS INTEGER AS $$
  SELECT CASE p_format
    WHEN 'bo3_21' THEN 21 WHEN 'single_21' THEN 21
    WHEN 'single_15' THEN 15 WHEN 'single_11' THEN 11 END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION format_cap(p_format match_format)
RETURNS INTEGER AS $$
  SELECT CASE p_format
    WHEN 'bo3_21' THEN 30 WHEN 'single_21' THEN 30
    WHEN 'single_15' THEN 21 WHEN 'single_11' THEN 15 END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION format_best_of(p_format match_format)
RETURNS INTEGER AS $$
  SELECT CASE p_format WHEN 'bo3_21' THEN 3 ELSE 1 END;
$$ LANGUAGE sql IMMUTABLE;

-- A game is legal if the winner reached the target winning by two, or took it
-- at the cap. See the header for why 30-29 passes and 21-20 does not.
CREATE OR REPLACE FUNCTION is_legal_game_score(p_a INTEGER, p_b INTEGER, p_format match_format)
RETURNS BOOLEAN AS $$
DECLARE
  v_target INTEGER := format_target(p_format);
  v_cap    INTEGER := format_cap(p_format);
  v_win    INTEGER := GREATEST(p_a, p_b);
  v_lose   INTEGER := LEAST(p_a, p_b);
BEGIN
  IF p_a = p_b THEN RETURN FALSE; END IF;            -- a game must be won
  IF v_lose < 0 OR v_win > v_cap THEN RETURN FALSE; END IF;
  IF v_win = v_target THEN RETURN v_lose <= v_target - 2; END IF;
  IF v_win > v_target AND v_win < v_cap THEN RETURN v_win - v_lose = 2; END IF;
  IF v_win = v_cap THEN RETURN v_lose >= v_cap - 2; END IF;
  RETURN FALSE;                                      -- never reached the target
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ------------------------------------------------------------
-- submit_match_result: reject impossible scores and game counts
-- ------------------------------------------------------------
-- Live definition from pg_get_functiondef with the validation block inserted,
-- so the rest of the body cannot drift from what is running.
CREATE OR REPLACE FUNCTION public.submit_match_result(p_challenge_id uuid, p_games jsonb, p_completed boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player    UUID := get_player_id(auth.uid());
  v_challenge RECORD;
  v_season    UUID;
  v_match_id  UUID;
  v_is_doubles BOOLEAN;
  v_score_summary TEXT;
  v_a_games INT := 0;
  v_b_games INT := 0;
  v_winner  TEXT;
  g         JSONB;
BEGIN
  IF v_player IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_games IS NULL OR jsonb_array_length(p_games) = 0 THEN
    RAISE EXCEPTION 'At least one game is required';
  END IF;

  SELECT * INTO v_challenge FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF v_challenge.id IS NULL THEN RAISE EXCEPTION 'Challenge not found'; END IF;
  IF v_challenge.status <> 'accepted' THEN
    RAISE EXCEPTION 'Challenge is not accepted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM challenge_participants
     WHERE challenge_id = p_challenge_id AND player_id = v_player
  ) THEN
    RAISE EXCEPTION 'Not a participant in this challenge';
  END IF;

  IF EXISTS (SELECT 1 FROM matches WHERE challenge_id = p_challenge_id) THEN
    RAISE EXCEPTION 'A match has already been submitted for this challenge';
  END IF;

  v_is_doubles := (v_challenge.type = 'doubles');
  SELECT id INTO v_season FROM seasons WHERE active_flag LIMIT 1;

  -- Derive the winner from the games rather than trusting the caller — the same
  -- rule apply_match_result() applies when the result is confirmed.
  FOR g IN SELECT * FROM jsonb_array_elements(p_games) LOOP
    IF (g->>'side_a_score')::INT > (g->>'side_b_score')::INT THEN
      v_a_games := v_a_games + 1;
    ELSIF (g->>'side_b_score')::INT > (g->>'side_a_score')::INT THEN
      v_b_games := v_b_games + 1;
    END IF;
  END LOOP;
  v_winner := CASE WHEN v_a_games > v_b_games THEN 'a'
                   WHEN v_b_games > v_a_games THEN 'b' END;

  -- Reject scores that cannot occur, and game counts that imply games played
  -- after the match was already decided.
  FOR g IN SELECT * FROM jsonb_array_elements(p_games) LOOP
    IF NOT is_legal_game_score((g->>'side_a_score')::INT, (g->>'side_b_score')::INT, v_challenge.format) THEN
      RAISE EXCEPTION 'Not a possible score for this format: %-%',
        g->>'side_a_score', g->>'side_b_score';
    END IF;
  END LOOP;

  IF GREATEST(v_a_games, v_b_games) <> (format_best_of(v_challenge.format) / 2) + 1
     OR LEAST(v_a_games, v_b_games) > (format_best_of(v_challenge.format) / 2) THEN
    RAISE EXCEPTION 'A % needs % game(s) to win and stops there — % to % is not a possible result',
      CASE WHEN format_best_of(v_challenge.format) > 1 THEN 'best-of-' || format_best_of(v_challenge.format) ELSE 'single game' END,
      (format_best_of(v_challenge.format) / 2) + 1, v_a_games, v_b_games;
  END IF;

  SELECT string_agg((e->>'side_a_score') || '-' || (e->>'side_b_score'), ', ')
    INTO v_score_summary
    FROM jsonb_array_elements(p_games) e;

  INSERT INTO matches (
    challenge_id, session_id, season_id, match_type, event_type, rated_flag,
    format, completed_flag, winner_side, score_summary, played_at,
    submitted_by, result_status
  ) VALUES (
    p_challenge_id, v_challenge.session_id, v_season, v_challenge.type,
    v_challenge.event_type, v_challenge.rated_flag, v_challenge.format,
    p_completed, v_winner::team_side, v_score_summary, NOW(),
    v_player,
    CASE WHEN p_completed THEN 'pending_confirmation'::result_status
         ELSE 'incomplete'::result_status END
  ) RETURNING id INTO v_match_id;

  -- Participants are derived from the challenge — the caller cannot enrol
  -- anyone who wasn't on it.
  INSERT INTO match_participants (
    match_id, player_id, team_side, pre_rating,
    points_scored, points_allowed, games_won, games_lost
  )
  SELECT
    v_match_id,
    cp.player_id,
    cp.team_side,
    COALESCE(CASE WHEN v_is_doubles THEN r.doubles_elo ELSE r.singles_elo END, 400),
    COALESCE(SUM(CASE WHEN cp.team_side = 'a' THEN (e->>'side_a_score')::INT
                                              ELSE (e->>'side_b_score')::INT END), 0),
    COALESCE(SUM(CASE WHEN cp.team_side = 'a' THEN (e->>'side_b_score')::INT
                                              ELSE (e->>'side_a_score')::INT END), 0),
    COALESCE(SUM(CASE WHEN cp.team_side = 'a'
                        AND (e->>'side_a_score')::INT > (e->>'side_b_score')::INT THEN 1
                      WHEN cp.team_side = 'b'
                        AND (e->>'side_b_score')::INT > (e->>'side_a_score')::INT THEN 1
                      ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN cp.team_side = 'a'
                        AND (e->>'side_a_score')::INT <= (e->>'side_b_score')::INT THEN 1
                      WHEN cp.team_side = 'b'
                        AND (e->>'side_b_score')::INT <= (e->>'side_a_score')::INT THEN 1
                      ELSE 0 END), 0)
  FROM challenge_participants cp
  LEFT JOIN ratings r ON r.player_id = cp.player_id
  CROSS JOIN LATERAL jsonb_array_elements(p_games) e
  WHERE cp.challenge_id = p_challenge_id
  GROUP BY cp.player_id, cp.team_side, r.doubles_elo, r.singles_elo;

  INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score)
  SELECT v_match_id, ord, (e->>'side_a_score')::INT, (e->>'side_b_score')::INT
    FROM jsonb_array_elements(p_games) WITH ORDINALITY AS t(e, ord);

  RETURN v_match_id;
END;
$function$;
