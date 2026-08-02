-- ============================================================
-- 00031_custom_match_formats.sql — "best of X to Y points"
-- ============================================================
-- Until now a match had to be one of four presets. This lets a challenge define
-- its own shape: best-of-X games to Y points, rated or casual (rated_flag
-- already decides that, so nothing new is needed for it).
--
-- Deliberately NOT new enum members — that grows without bound. Two nullable
-- columns instead, authoritative when present, with the enum kept for the
-- presets so every existing row and all tournament code keeps working.
--
-- The Elo weight is the part that needed a decision. Each preset had a
-- hand-picked weight (bo3_21 1.25, single_21 1.0, single_15 0.75,
-- single_11 0.5) and an arbitrary (games, points) pair has no entry — get that
-- wrong and a "1 game to 5 points" becomes a rating farm. It is now derived:
--
--     weight = (points / 21) * (best-of > 1 ? 1.25 : 1.0)   clamped to [0.25, 1.5]
--
-- That reproduces bo3_21 (1.25) and single_21 (1.00) exactly and lands within
-- 0.03 of the other two, so custom and preset matches stay comparable and no
-- existing rating needs recomputing. The clamp stops a 99-point format being
-- worth triple.
--
-- Scoring rules come from 00030 and generalise: a game is won by reaching the
-- target with a two-point margin or by taking the cap, and a best-of-X stops
-- once someone clinches. The cap is now ONE rule everywhere — target + 9,
-- mirroring the BWF 21 -> 30 — replacing the per-format guesses in 00030.
-- ============================================================

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS games_per_match SMALLINT,
  ADD COLUMN IF NOT EXISTS points_per_game SMALLINT;
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS games_per_match SMALLINT,
  ADD COLUMN IF NOT EXISTS points_per_game SMALLINT;

-- Bounds keep a "best of 99 to 500" out of the ladder. Best-of must be odd so a
-- majority always exists.
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_custom_format_sane;
ALTER TABLE challenges ADD CONSTRAINT challenges_custom_format_sane CHECK (
  (games_per_match IS NULL AND points_per_game IS NULL)
  OR (
    games_per_match BETWEEN 1 AND 7 AND games_per_match % 2 = 1
    AND points_per_game BETWEEN 5 AND 30
  )
);

-- ------------------------------------------------------------
-- Format rules, now custom-aware
-- ------------------------------------------------------------
-- One cap rule for every format, preset or custom.
CREATE OR REPLACE FUNCTION points_cap(p_target INTEGER)
RETURNS INTEGER AS $$ SELECT p_target + 9; $$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION format_cap(p_format match_format)
RETURNS INTEGER AS $$ SELECT points_cap(format_target(p_format)); $$ LANGUAGE sql IMMUTABLE;

-- Custom-aware variants: fall back to the preset when the columns are unset.
CREATE OR REPLACE FUNCTION effective_target(p_format match_format, p_points SMALLINT)
RETURNS INTEGER AS $$ SELECT COALESCE(p_points::INTEGER, format_target(p_format)); $$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION effective_best_of(p_format match_format, p_games SMALLINT)
RETURNS INTEGER AS $$ SELECT COALESCE(p_games::INTEGER, format_best_of(p_format)); $$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION is_legal_game_score_custom(
  p_a INTEGER, p_b INTEGER, p_target INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
  v_cap  INTEGER := points_cap(p_target);
  v_win  INTEGER := GREATEST(p_a, p_b);
  v_lose INTEGER := LEAST(p_a, p_b);
BEGIN
  IF p_a = p_b THEN RETURN FALSE; END IF;
  IF v_lose < 0 OR v_win > v_cap THEN RETURN FALSE; END IF;
  IF v_win = p_target THEN RETURN v_lose <= p_target - 2; END IF;
  IF v_win > p_target AND v_win < v_cap THEN RETURN v_win - v_lose = 2; END IF;
  IF v_win = v_cap THEN RETURN v_lose >= v_cap - 2; END IF;
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Derived Elo weight — see the header for why it is shaped this way.
CREATE OR REPLACE FUNCTION derived_format_weight(p_best_of INTEGER, p_target INTEGER)
RETURNS NUMERIC AS $$
  SELECT LEAST(1.5, GREATEST(0.25,
    (p_target::NUMERIC / 21) * CASE WHEN p_best_of > 1 THEN 1.25 ELSE 1.0 END
  ));
$$ LANGUAGE sql IMMUTABLE;

-- Weights are stamped onto the match at insert by trigger_set_match_weights;
-- teach it to use the custom shape when present.
CREATE OR REPLACE FUNCTION trigger_set_match_weights()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.points_per_game IS NOT NULL THEN
    NEW.format_weight := derived_format_weight(
      COALESCE(NEW.games_per_match::INTEGER, 1), NEW.points_per_game::INTEGER);
  ELSE
    NEW.format_weight := get_format_weight(NEW.format);
  END IF;
  IF NEW.event_multiplier IS NULL OR NEW.event_multiplier = 0 THEN
    NEW.event_multiplier := get_event_multiplier(NEW.event_type);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ------------------------------------------------------------
-- submit_match_result: honour the challenge's custom shape
-- ------------------------------------------------------------
-- Same body as 00030 with three changes: scores validate against the
-- challenge's own target, the game count against its own best-of, and both
-- columns are copied onto the match so the result records the shape it was
-- played under.
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
    IF NOT is_legal_game_score_custom((g->>'side_a_score')::INT, (g->>'side_b_score')::INT,
                                      effective_target(v_challenge.format, v_challenge.points_per_game)) THEN
      RAISE EXCEPTION 'Not a possible score for this format: %-%',
        g->>'side_a_score', g->>'side_b_score';
    END IF;
  END LOOP;

  IF GREATEST(v_a_games, v_b_games) <> (effective_best_of(v_challenge.format, v_challenge.games_per_match) / 2) + 1
     OR LEAST(v_a_games, v_b_games) > (effective_best_of(v_challenge.format, v_challenge.games_per_match) / 2) THEN
    RAISE EXCEPTION 'A % needs % game(s) to win and stops there — % to % is not a possible result',
      CASE WHEN effective_best_of(v_challenge.format, v_challenge.games_per_match) > 1
           THEN 'best-of-' || effective_best_of(v_challenge.format, v_challenge.games_per_match)
           ELSE 'single game' END,
      (effective_best_of(v_challenge.format, v_challenge.games_per_match) / 2) + 1, v_a_games, v_b_games;
  END IF;

  SELECT string_agg((e->>'side_a_score') || '-' || (e->>'side_b_score'), ', ')
    INTO v_score_summary
    FROM jsonb_array_elements(p_games) e;

  INSERT INTO matches (
    challenge_id, session_id, season_id, match_type, event_type, rated_flag,
    format, completed_flag, winner_side, score_summary, played_at,
    submitted_by, result_status, games_per_match, points_per_game
  ) VALUES (
    p_challenge_id, v_challenge.session_id, v_season, v_challenge.type,
    v_challenge.event_type, v_challenge.rated_flag, v_challenge.format,
    p_completed, v_winner::team_side, v_score_summary, NOW(),
    v_player,
    CASE WHEN p_completed THEN 'pending_confirmation'::result_status
         ELSE 'incomplete'::result_status END,
    v_challenge.games_per_match, v_challenge.points_per_game
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
