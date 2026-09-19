-- ============================================================================
-- 00236: A SEASON IS NOT OPTIONAL, AND A FULL RESET IS NOT HALF A RESET
--
-- APPLY AFTER 00235. Nothing here depends on it; the ordering is only so that
-- schema_migrations stays a straight line.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
-- ----------------------------------------------------------------------------
-- Two defects found by the season-scoping audit of 2026-09-19. They are
-- unrelated to each other and share only a cause: both treat `seasons` as
-- something that is always there and always the same one.
--
--   1. A result recorded while NO season is active was stamped season_id NULL
--      and vanished. Two functions did it.  (sections 1 and 2)
--   2. The `full` Elo policy reset four columns of twenty and called it a
--      reset.                                (section 3)
--
-- ----------------------------------------------------------------------------
-- READ THIS BEFORE RUNNING: SECTIONS 1 AND 2 CHANGE BEHAVIOUR
-- ----------------------------------------------------------------------------
-- After this migration, submitting a match result or applying a walkover while
-- no season is active FAILS, with a message naming the fix. Today it succeeds.
--
-- That is the point, and it is a trade worth making deliberately rather than
-- discovering between terms. `matches.season_id` is nullable, and both
-- functions read the active season with a bare
--
--     SELECT id FROM seasons WHERE active_flag LIMIT 1
--
-- which yields NULL between terms rather than raising. The row was written,
-- the submitter was told it worked, and the match then failed to appear on the
-- ladder, on the feed, on either profile, in the Discord card and in every
-- season page, permanently, because every one of those is filtered by season.
-- Nothing in the app ever surfaced it again. A loud refusal that an exec fixes
-- by activating a season is strictly better than a silent permanent drop.
--
-- The third writer into `matches`, the admin console's manual entry in
-- apps/admin/src/lib/actions/matches.ts, was ALREADY guarded: it calls
-- requireActiveSeasonId() before the insert. This brings the two database
-- paths level with it rather than inventing a new rule.
--
-- No trigger. A BEFORE INSERT trigger on `matches` would cover the same two
-- paths with a worse message, and would still not produce the invariant it
-- looks like it produces: seasons.id is ON DELETE SET NULL, so deleting a
-- season nulls its matches by UPDATE, which no insert trigger ever sees. The
-- guard belongs where the caller is known.
--
-- ----------------------------------------------------------------------------
-- ON THE RESTATED BODIES
-- ----------------------------------------------------------------------------
-- All three functions are restated in full, because CREATE OR REPLACE takes no
-- patch. Each body below was generated from `pg_get_functiondef` read off prod
-- on 2026-09-19 (226/226 applied, 0 pending, 0 drifted, so live and checkout
-- agree), with the edit applied by a script that fails unless its target
-- matches exactly once. Nothing was retyped by hand. If you are reading this
-- during a later conflict, the ONLY lines this migration authored are the
-- IF v_season IS NULL blocks, the v_season declaration in section 2, and the
-- sixteen zeroed counters in section 3. Everything else is carried forward.
--
-- CREATE OR REPLACE keeps the existing grants and ownership, so there is no
-- regrant here and no grant to check. Signatures are unchanged.
-- ============================================================================


-- ============================================================================
-- SECTION 1: submit_match_result, refusing rather than stamping NULL
-- ============================================================================

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

  -- Session caps — session_caps.max_rated_{singles,doubles}_per_session.
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


-- ============================================================================
-- SECTION 2: apply_walkover_result, the same hole and the same refusal
--
-- The season was read inline, in the middle of the INSERT's VALUES list, where
-- there was nowhere to check it. It is now read into v_season first, so the
-- guard has something to guard.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_walkover_result(p_walkover_id uuid, p_admin_id uuid, p_admin_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_walkover RECORD;
  v_challenge RECORD;
  v_elo_weight NUMERIC;
  v_apply_elo BOOLEAN;
  v_match_id UUID;
  v_winner_side team_side;
  v_is_doubles BOOLEAN;
  v_late_threshold INTEGER;
  v_season UUID;
BEGIN
  SELECT * INTO v_walkover FROM walkovers WHERE id = p_walkover_id FOR UPDATE;
  IF v_walkover IS NULL OR v_walkover.status != 'pending' THEN
    RAISE EXCEPTION 'Walkover not found or not pending';
  END IF;

  -- Read once, before either branch uses it. The Elo decision and the
  -- reliability-metric decision must agree on the same number within a single
  -- call; two separate reads could straddle a settings edit.
  v_late_threshold := platform_setting_int('walkover_rules', 'late_withdrawal_threshold_hours', 24);

  SELECT * INTO v_challenge FROM challenges WHERE id = v_walkover.challenge_id;

  -- Determine Elo weight based on walkover type. At or above the threshold is
  -- early notice and free; below it costs half weight.
  IF v_walkover.walkover_type = 'withdrawal' AND COALESCE(v_walkover.notice_hours, 0) >= v_late_threshold THEN
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

  SELECT id INTO v_season FROM seasons WHERE active_flag = TRUE LIMIT 1;
  IF v_season IS NULL THEN
    -- No season running is a fact about the CLUB, and it used to be recorded as
    -- a fact about the match: the row was stamped NULL and dropped out of every
    -- season-scoped page permanently, silently, with the submitter told it
    -- worked. Refusing is the smaller harm, and it is recoverable in one click.
    RAISE EXCEPTION 'No season is active, so this result cannot be recorded. Ask an exec to activate a season in the admin console, then submit again.'
      USING ERRCODE = 'check_violation';
  END IF;

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
    v_season,
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

  -- Update walkover record.
  --
  -- `admin_notes = p_admin_notes` IS NO LONGER HERE — 00125. walkovers_select
  -- admits forfeit_player_id, so the column let the member who forfeited read
  -- the exec's verdict on their own forfeit. The verdict goes to
  -- walkover_admin_notes below instead.
  UPDATE walkovers SET
    status = 'confirmed',
    match_id = v_match_id,
    admin_confirmed_by = p_admin_id,
    admin_confirmed_at = NOW(),
    elo_penalty_applied = (v_elo_weight > 0),
    updated_at = NOW()
  WHERE id = p_walkover_id;

  -- THE VERDICT, SOMEWHERE ITS SUBJECT CANNOT READ IT — 00125.
  -- walkover_admin_notes holds no grant for anon or authenticated and has RLS
  -- on with no policy, so it is reachable only through the service-role key
  -- and by SECURITY DEFINER bodies like this one. Only when a note was actually
  -- passed: `p_admin_notes` is DEFAULT NULL, today's caller omits it entirely,
  -- and `note` is NOT NULL on the private table.
  IF p_admin_notes IS NOT NULL AND btrim(p_admin_notes) <> '' THEN
    INSERT INTO walkover_admin_notes (walkover_id, note, author_id)
    VALUES (p_walkover_id, p_admin_notes, p_admin_id)
    ON CONFLICT (walkover_id) DO UPDATE
      SET note      = EXCLUDED.note,
          author_id = EXCLUDED.author_id;
  END IF;

  -- Update challenge status
  UPDATE challenges SET status = 'walkover_confirmed', updated_at = NOW()
  WHERE id = v_walkover.challenge_id;

  -- Update reliability metrics for forfeiting player. Same threshold as the
  -- Elo branch above, so the metric a player accrues always matches whether
  -- they were charged rating for it.
  IF v_walkover.walkover_type = 'no_show' THEN
    UPDATE reliability_metrics SET
      no_shows = no_shows + 1,
      updated_at = NOW()
    WHERE player_id = v_walkover.forfeit_player_id;
  ELSIF COALESCE(v_walkover.notice_hours, 0) < v_late_threshold THEN
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
$function$;


-- ============================================================================
-- SECTION 3: activate_season, where a full reset resets everything
--
-- `ratings` carries twenty per-season numbers. The `full` branch zeroed four of
-- them (matches_played, and the two k-factors alongside the two elos) and left
-- sixteen standing: wins, losses, points scored and allowed, games won and
-- lost, current and best streak, in both disciplines.
--
-- The result was a row that could not be true. A member who finished a season
-- 31-12 began the next one still reading 31-12 next to "0 matches played", and
-- every profile, card and console panel that draws a season from `ratings`
-- repeated it.
--
-- Zeroing loses nothing. `ratings` is a cache of the current season; the record
-- itself lives in `matches` (stamped with season_id), `match_participants` and
-- `match_games`, and rebuilds for any season on demand. The player app's
-- my-stats/past-season.tsx and the shared summarizeSeason() already do this.
--
-- `carry` and `soft` are deliberately untouched. Both keep the counters running
-- across the rollover by design, which makes them all-time figures. Several
-- surfaces still label those as the current season; that is a labelling bug on
-- the audit punch list, not something to fix by changing what the policies do.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.activate_season(p_season_id uuid, p_elo_policy text DEFAULT 'carry'::text, p_compression_factor numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prev_season uuid;
  v_factor numeric;
  v_baseline integer;
  v_tier integer;
  v_singles_mean numeric;
  v_doubles_mean numeric;
BEGIN
  IF p_elo_policy NOT IN ('carry', 'soft', 'full') THEN
    RAISE EXCEPTION 'invalid elo policy: %', p_elo_policy;
  END IF;

  -- The bottom of the ladder. Same key a new player starts at, because it is
  -- the same concept: where an unrated player sits. Still the origin for tier
  -- bands and still the target for a FULL reset.
  v_baseline := platform_setting_int('rating_defaults', 'default_elo', 400);
  -- Tier band width. GREATEST(1, ...) because a tier of 0 would divide by zero
  -- in the FLOOR below, and a negative one is meaningless.
  v_tier := GREATEST(1, platform_setting_int('season_settings', 'tier_size', 200));

  IF p_elo_policy = 'soft' THEN
    IF NOT platform_setting_bool('season_settings', 'soft_compression_enabled', TRUE) THEN
      RAISE EXCEPTION 'Soft compression is disabled in platform settings — enable it or choose a different Elo policy';
    END IF;

    -- COALESCE, not a parameter default: an explicit factor from a caller who
    -- knows what it wants still wins, and only an omitted one falls through to
    -- the panel. Clamped to [0,1] because the formula below inverts ratings
    -- above 1 and inflates them below 0.
    v_factor := LEAST(1, GREATEST(0,
      COALESCE(p_compression_factor,
               platform_setting_numeric('season_settings', 'compression_factor', 0.5))));

    -- Established players only, per discipline. Falls back to the unfiltered
    -- mean, then to the baseline — see the header for why the baseline is last
    -- and not first. Snapshotted before any rewrite: reading it inline would
    -- make the target move as rows are updated.
    SELECT
      COALESCE(
        AVG(singles_elo) FILTER (WHERE singles_provisional = FALSE),
        AVG(singles_elo),
        v_baseline
      ),
      COALESCE(
        AVG(doubles_elo) FILTER (WHERE doubles_provisional = FALSE),
        AVG(doubles_elo),
        v_baseline
      )
      INTO v_singles_mean, v_doubles_mean
      FROM ratings;
  END IF;

  SELECT id INTO v_prev_season FROM seasons WHERE active_flag = TRUE LIMIT 1;
  IF v_prev_season IS NOT NULL THEN
    INSERT INTO season_final_ratings (season_id, player_id, singles_elo, doubles_elo)
    SELECT v_prev_season, r.player_id, r.singles_elo, r.doubles_elo FROM ratings r
    ON CONFLICT (season_id, player_id) DO UPDATE
      SET singles_elo = EXCLUDED.singles_elo,
          doubles_elo = EXCLUDED.doubles_elo,
          archived_at = NOW();
  END IF;

  UPDATE seasons SET active_flag = FALSE WHERE active_flag = TRUE;
  UPDATE seasons SET active_flag = TRUE WHERE id = p_season_id;

  IF p_elo_policy = 'full' THEN
    -- A FULL RESET NOW CLEARS EVERY COUNTER, NOT FOUR OF TWENTY.
    --
    -- It used to zero matches_played and leave the other sixteen standing, so a
    -- member came out of a rollover reading "31-12, 0 matches played": a
    -- career record sitting beside a counter saying no career had happened.
    -- Every surface that draws a season from `ratings` inherited that.
    --
    -- Nothing is lost. `ratings` is a cache: `matches.season_id` is stamped on
    -- every row, and wins, losses, points and games all rebuild from
    -- match_participants + match_games for any season you name. past-season.tsx
    -- and summarizeSeason() already do exactly that. Zeroing here resets the
    -- LIVE counter for the season now starting; it does not touch history.
    UPDATE ratings SET
      singles_elo = v_baseline, doubles_elo = v_baseline,
      singles_provisional = TRUE, doubles_provisional = TRUE,
      singles_matches_played = 0, doubles_matches_played = 0,
      singles_k_factor = 80, doubles_k_factor = 64,
      singles_wins = 0, singles_losses = 0,
      doubles_wins = 0, doubles_losses = 0,
      singles_points_scored = 0, singles_points_allowed = 0,
      doubles_points_scored = 0, doubles_points_allowed = 0,
      singles_games_won = 0, singles_games_lost = 0,
      doubles_games_won = 0, doubles_games_lost = 0,
      current_singles_streak = 0, best_singles_streak = 0,
      current_doubles_streak = 0, best_doubles_streak = 0,
      updated_at = NOW();
  ELSIF p_elo_policy = 'soft' THEN
    -- The GREATEST(...) term is the tier floor: nobody drops below the bottom
    -- of the tier they earned. Still measured from v_baseline — tiers are bands
    -- above the ladder floor, and re-basing them on a mean that moves every
    -- season would renumber everyone's tier at each rollover.
    --
    -- Provisional players are compressed too, even though they do not count
    -- toward the target. They are at the floor, the target is above it, so this
    -- nudges them up — which is harmless, and excluding them would need a
    -- second code path for no benefit.
    UPDATE ratings SET
      singles_elo = GREATEST(
        v_baseline + v_tier * GREATEST(0, FLOOR((singles_elo - v_baseline) / v_tier::numeric))::int,
        ROUND(v_singles_mean + (singles_elo - v_singles_mean) * (1 - v_factor))::int
      ),
      doubles_elo = GREATEST(
        v_baseline + v_tier * GREATEST(0, FLOOR((doubles_elo - v_baseline) / v_tier::numeric))::int,
        ROUND(v_doubles_mean + (doubles_elo - v_doubles_mean) * (1 - v_factor))::int
      ),
      updated_at = NOW();
  END IF;
END;
$function$;



-- ============================================================================
-- SECTION 4: grants, restated so the guard can see them
--
-- CREATE OR REPLACE preserves the existing ACL, so nothing above changes who
-- can call these three. The grant-drift test cannot know that from the file,
-- and it is right not to guess: the failure mode it exists to catch is a
-- migration that looks service-role-only and is world-callable, and
-- "it was fine before" is exactly what that one says too.
--
-- So the grants are restated here, matching the live ACL read off prod on
-- 2026-09-19 rather than invented:
--
--   submit_match_result   postgres=X | authenticated=X | service_role=X
--   apply_walkover_result postgres=X |                   service_role=X
--   activate_season       postgres=X |                   service_role=X
--
-- REVOKE ... FROM PUBLIC alone would not do it. Supabase ships
-- ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon,
-- authenticated, service_role, so a function is born with EXPLICIT anon and
-- authenticated entries that a PUBLIC revoke does not touch. See 00126.
--
-- Net effect on a database already at prod's ACL: none. This is the assertion,
-- written as SQL.
-- ============================================================================

REVOKE ALL ON FUNCTION public.submit_match_result(uuid, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
-- Members submit their own results. This is the one of the three a browser key
-- is meant to reach, and apply_match_result behind it re-checks the actor.
GRANT EXECUTE ON FUNCTION public.submit_match_result(uuid, jsonb, boolean)
  TO authenticated;

-- Admin-only, both of them, and both take an actor id as a parameter. Reachable
-- by `authenticated` they would be impersonation primitives, so neither gets a
-- grant back: the console calls them with the service key.
REVOKE ALL ON FUNCTION public.apply_walkover_result(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.activate_season(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;


NOTIFY pgrst, 'reload schema';
