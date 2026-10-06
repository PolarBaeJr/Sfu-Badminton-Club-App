-- ============================================================================
-- 00280: A CHALLENGE CAN BE SENT, AND A RESULT REPORTED, FROM DISCORD
--
-- APPLY AFTER 00279. Nothing here depends on it; the ordering is only so that
-- schema_migrations stays a straight line.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
-- ----------------------------------------------------------------------------
-- /challenge send and /challenge report in the bot. The bot reaches the player
-- app over a service secret, and the app acts as the member it resolves from
-- the caller's Discord id through player_discord_links. There is no member
-- session on that path, so auth.uid() is NULL, and both functions the web
-- calls take their actor from auth.uid() and from nothing else (00183, 00236).
--
-- So each gets an "actor passed in" twin, granted to service_role ONLY, and
-- the member function becomes a thin wrapper around it. The rules stay in one
-- body: a change to who may challenge whom, or to which scores are legal,
-- lands in the twin and both doors see it.
--
--   create_challenge_for(p_creator, <00183's twelve params>)
--   create_challenge_atomic(<the same twelve>)        wrapper, same signature
--   submit_match_result_for(p_actor, <00236's three>, p_duration_minutes)
--   submit_match_result(<the same three>)             wrapper, same signature
--
-- WHY A TWIN AND NOT A PARAMETER ON THE MEMBER FUNCTION. 00126 and 00183 say
-- it: a SECURITY DEFINER function that accepts the player it should act as is
-- an impersonation primitive the moment `authenticated` can reach it. The
-- member functions keep taking no player id. The twins take one and are not
-- reachable by any browser key.
--
-- ----------------------------------------------------------------------------
-- matches.duration_minutes
-- ----------------------------------------------------------------------------
-- How long the match took, in minutes, as the submitter reported it. Discord
-- requires it; the web form does not ask yet, so web results carry NULL. It is
-- informational: no rating, weight or standing reads it. Written only by
-- submit_match_result_for, so no member role gets a column grant on it.
--
-- ----------------------------------------------------------------------------
-- ON THE RESTATED BODIES
-- ----------------------------------------------------------------------------
-- create_challenge_for is 00183:43-127 and submit_match_result_for is
-- 00236:70-228, copied by a script that fails unless each edit matches exactly
-- once. The lines this migration authored: the actor taken from the parameter
-- (and, for create, refused when no players row has that id), and
-- duration_minutes in the matches INSERT. Four comments and one RAISE text
-- carried a long dash and now carry a colon or a semicolon; the RAISE still
-- matches the guard pattern in expected-error.ts ("needs N game(s) to win and
-- stops there").
--
-- The two wrappers keep their signatures, parameter names, defaults and
-- return types, so CREATE OR REPLACE applies and no caller changes. Their
-- grants are restated anyway, in the explicit form function-grant-drift.test
-- asks of every function a migration creates, and they come back to what
-- 00183 and 00236 left: create_challenge_atomic to authenticated and
-- service_role, submit_match_result to authenticated.
--
-- No trigger needs the actor threaded through. The triggers these bodies fire
-- (trigger_set_match_weights on matches, on_match_participants_inserted on
-- match_participants) and every helper they call (validate_challenge_creation,
-- check_session_caps, session_cap_for, effective_target, effective_best_of,
-- is_legal_game_score_custom) read no auth.uid(). guard_challenge_member_columns
-- is BEFORE UPDATE on challenges and neither body updates a challenge.
-- ============================================================================


-- ============================================================================
-- SECTION 1: matches.duration_minutes
-- ============================================================================

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS duration_minutes smallint
    CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 300);

COMMENT ON COLUMN public.matches.duration_minutes IS
  'How long the match took, in minutes, as the submitter reported it (00280). Required from Discord, NULL from the web. Informational only: nothing rated reads it.';


-- ============================================================================
-- SECTION 2: create_challenge_for, and create_challenge_atomic around it
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_challenge_for(
  p_creator              UUID,
  p_type                 TEXT,
  p_rated_flag           BOOLEAN,
  p_format               TEXT,
  p_opponent_id          UUID,
  p_partner_id           UUID DEFAULT NULL,
  p_opponent_partner_id  UUID DEFAULT NULL,
  p_games_per_match      SMALLINT DEFAULT NULL,
  p_points_per_game      SMALLINT DEFAULT NULL,
  p_session_id           UUID DEFAULT NULL,
  p_scheduled_date       DATE DEFAULT NULL,
  p_scheduled_time       TIME DEFAULT NULL,
  p_note                 TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_creator    UUID;
  v_validation JSONB;
  v_challenge  UUID;
BEGIN
  -- THE ONE LINE THIS MIGRATION AUTHORED IN THIS BODY: the creator is the
  -- parameter rather than auth.uid(). Everything below is 00183 verbatim.
  v_creator := p_creator;
  IF v_creator IS NULL OR NOT EXISTS (SELECT 1 FROM players WHERE id = v_creator) THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Serialise a single member's own concurrent creations. Without it the cap
  -- check below is a read that another transaction can invalidate before the
  -- insert lands. Transaction-scoped, so it is released by the COMMIT or the
  -- ROLLBACK either way, and it is keyed on the creator so two different
  -- members never wait on each other.
  PERFORM pg_advisory_xact_lock(hashtext('challenge_create:' || v_creator::TEXT));

  -- THE SAME FUNCTION THE APP USED TO CALL, unchanged and called from inside
  -- the transaction that writes. Its rules are the club's, and re-implementing
  -- them here would be a second copy free to disagree with the first.
  v_validation := validate_challenge_creation(
    v_creator, p_opponent_id, p_type, p_partner_id, p_opponent_partner_id
  );
  IF NOT COALESCE((v_validation->>'valid')::BOOLEAN, FALSE) THEN
    RETURN jsonb_build_object('valid', FALSE, 'errors', v_validation->'errors');
  END IF;

  INSERT INTO challenges (
    type, rated_flag, format, games_per_match, points_per_game,
    event_type, session_id, scheduled_date, scheduled_time,
    created_by, status, note
  ) VALUES (
    p_type::match_type_enum,
    p_rated_flag,
    p_format::match_format,
    p_games_per_match,
    p_points_per_game,
    -- Mirrors the app's `input.rated_flag ? 'rated_challenge' : 'casual'`. It
    -- moves here so the two can never disagree about what a rated flag means.
    CASE WHEN p_rated_flag THEN 'rated_challenge' ELSE 'casual' END::event_type_enum,
    p_session_id, p_scheduled_date, p_scheduled_time,
    v_creator, 'proposed'::challenge_status, p_note
  )
  RETURNING id INTO v_challenge;

  -- The creator is 'accepted' by construction; everyone else is asked.
  INSERT INTO challenge_participants (challenge_id, player_id, role, team_side, confirmation_status)
  VALUES
    (v_challenge, v_creator,      'challenger'::participant_role, 'a'::team_side, 'accepted'::confirmation_status),
    (v_challenge, p_opponent_id,  'opponent'::participant_role,   'b'::team_side, 'pending'::confirmation_status);

  IF p_type = 'doubles' THEN
    IF p_partner_id IS NOT NULL THEN
      INSERT INTO challenge_participants (challenge_id, player_id, role, team_side, confirmation_status)
      VALUES (v_challenge, p_partner_id, 'partner'::participant_role, 'a'::team_side, 'pending'::confirmation_status);
    END IF;
    IF p_opponent_partner_id IS NOT NULL THEN
      INSERT INTO challenge_participants (challenge_id, player_id, role, team_side, confirmation_status)
      VALUES (v_challenge, p_opponent_partner_id, 'opponent_partner'::participant_role, 'b'::team_side, 'pending'::confirmation_status);
    END IF;
  END IF;

  RETURN jsonb_build_object('valid', TRUE, 'challenge_id', v_challenge);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_challenge_for(
  UUID, TEXT, BOOLEAN, TEXT, UUID, UUID, UUID, SMALLINT, SMALLINT, UUID, DATE, TIME, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_challenge_for(
  UUID, TEXT, BOOLEAN, TEXT, UUID, UUID, UUID, SMALLINT, SMALLINT, UUID, DATE, TIME, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.create_challenge_atomic(
  p_type                 TEXT,
  p_rated_flag           BOOLEAN,
  p_format               TEXT,
  p_opponent_id          UUID,
  p_partner_id           UUID DEFAULT NULL,
  p_opponent_partner_id  UUID DEFAULT NULL,
  p_games_per_match      SMALLINT DEFAULT NULL,
  p_points_per_game      SMALLINT DEFAULT NULL,
  p_session_id           UUID DEFAULT NULL,
  p_scheduled_date       DATE DEFAULT NULL,
  p_scheduled_time       TIME DEFAULT NULL,
  p_note                 TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_creator UUID;
BEGIN
  -- The member's own door: the creator is the session, never a parameter.
  v_creator := get_player_id(auth.uid());
  IF v_creator IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  RETURN create_challenge_for(
    v_creator, p_type, p_rated_flag, p_format, p_opponent_id, p_partner_id,
    p_opponent_partner_id, p_games_per_match, p_points_per_game, p_session_id,
    p_scheduled_date, p_scheduled_time, p_note
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_challenge_atomic(
  TEXT, BOOLEAN, TEXT, UUID, UUID, UUID, SMALLINT, SMALLINT, UUID, DATE, TIME, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_challenge_atomic(
  TEXT, BOOLEAN, TEXT, UUID, UUID, UUID, SMALLINT, SMALLINT, UUID, DATE, TIME, TEXT
) TO authenticated, service_role;


-- ============================================================================
-- SECTION 3: submit_match_result_for, and submit_match_result around it
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_match_result_for(p_actor uuid, p_challenge_id uuid, p_games jsonb, p_completed boolean DEFAULT true, p_duration_minutes smallint DEFAULT NULL::smallint)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player    UUID := p_actor;
  v_challenge RECORD;
  v_season    UUID;
  v_match_id  UUID;
  v_is_doubles BOOLEAN;
  v_score_summary TEXT;
  v_a_games INT := 0;
  v_b_games INT := 0;
  v_winner  TEXT;
  g         JSONB;
  v_capped  RECORD;
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

  -- Session caps: session_caps.max_rated_{singles,doubles}_per_session.
  -- Only rated matches tied to a session can breach a per-session cap, so a
  -- casual game or an unscheduled challenge is untouched.
  IF v_challenge.rated_flag AND v_challenge.session_id IS NOT NULL THEN
    FOR v_capped IN
      SELECT COALESCE(pl.display_name, pl.full_name) AS nm
        FROM challenge_participants cp
        JOIN players pl ON pl.id = cp.player_id
       WHERE cp.challenge_id = p_challenge_id
         AND NOT check_session_caps(cp.player_id, v_challenge.session_id,
                                    v_challenge.type::TEXT)
    LOOP
      RAISE EXCEPTION '% has already played the maximum of % rated % match(es) in this session',
        v_capped.nm, session_cap_for(v_challenge.type::TEXT), v_challenge.type;
    END LOOP;
  END IF;

  v_is_doubles := (v_challenge.type = 'doubles');
  SELECT id INTO v_season FROM seasons WHERE active_flag LIMIT 1;
  IF v_season IS NULL THEN
    -- No season running is a fact about the CLUB, and it used to be recorded as
    -- a fact about the match: the row was stamped NULL and dropped out of every
    -- season-scoped page permanently, silently, with the submitter told it
    -- worked. Refusing is the smaller harm, and it is recoverable in one click.
    RAISE EXCEPTION 'No season is active, so this result cannot be recorded. Ask an exec to activate a season in the admin console, then submit again.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Derive the winner from the games rather than trusting the caller: the same
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
    RAISE EXCEPTION 'A % needs % game(s) to win and stops there: % to % is not a possible result',
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
    submitted_by, result_status, games_per_match, points_per_game,
    duration_minutes
  ) VALUES (
    p_challenge_id, v_challenge.session_id, v_season, v_challenge.type,
    v_challenge.event_type, v_challenge.rated_flag, v_challenge.format,
    p_completed, v_winner::team_side, v_score_summary, NOW(),
    v_player,
    CASE WHEN p_completed THEN 'pending_confirmation'::result_status
         ELSE 'incomplete'::result_status END,
    v_challenge.games_per_match, v_challenge.points_per_game,
    p_duration_minutes
  ) RETURNING id INTO v_match_id;

  -- Participants are derived from the challenge; the caller cannot enrol
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

REVOKE ALL ON FUNCTION public.submit_match_result_for(uuid, uuid, jsonb, boolean, smallint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_match_result_for(uuid, uuid, jsonb, boolean, smallint)
  TO service_role;

CREATE OR REPLACE FUNCTION public.submit_match_result(p_challenge_id uuid, p_games jsonb, p_completed boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The member's own door. A NULL actor is refused inside with the same
  -- 'Not authenticated' this function always raised. The web asks for no
  -- duration, so it is NULL here.
  RETURN submit_match_result_for(get_player_id(auth.uid()), p_challenge_id, p_games, p_completed, NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_match_result(uuid, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_match_result(uuid, jsonb, boolean)
  TO authenticated;


-- ============================================================================
-- SECTION 4: VERIFY
-- ============================================================================

DO $verify$
DECLARE
  v_create_for text := 'public.create_challenge_for(uuid,text,boolean,text,uuid,uuid,uuid,smallint,smallint,uuid,date,time,text)';
  v_create     text := 'public.create_challenge_atomic(text,boolean,text,uuid,uuid,uuid,smallint,smallint,uuid,date,time,text)';
  v_submit_for text := 'public.submit_match_result_for(uuid,uuid,jsonb,boolean,smallint)';
  v_submit     text := 'public.submit_match_result(uuid,jsonb,boolean)';
  v_fn         text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[v_create_for, v_submit_for] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00280: % must be service_role only', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[v_create, v_submit] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00280: % lost its member grant or gained anon', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[v_create_for, v_create, v_submit_for, v_submit] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION '00280: % is not SECURITY DEFINER', v_fn;
    END IF;
  END LOOP;

  IF position('create_challenge_for(' IN (SELECT prosrc FROM pg_proc WHERE oid = v_create::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00280: create_challenge_atomic does not delegate to create_challenge_for';
  END IF;
  IF position('submit_match_result_for(' IN (SELECT prosrc FROM pg_proc WHERE oid = v_submit::regprocedure)) = 0 THEN
    RAISE EXCEPTION '00280: submit_match_result does not delegate to submit_match_result_for';
  END IF;

  IF has_column_privilege('authenticated', 'public.matches', 'duration_minutes', 'UPDATE')
     OR has_column_privilege('anon', 'public.matches', 'duration_minutes', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.matches', 'duration_minutes', 'INSERT')
     OR has_column_privilege('anon', 'public.matches', 'duration_minutes', 'INSERT') THEN
    RAISE EXCEPTION '00280: a member role can write matches.duration_minutes';
  END IF;
END
$verify$;


NOTIFY pgrst, 'reload schema';
