-- ============================================================
-- 00053_settings_db_remainder.sql — wire up the last of the
-- admin-panel settings that Postgres was supposed to enforce
--
-- 00041/00044 fixed rating_defaults, 00048 fixed the challenge
-- caps, 00049 fixed the late-withdrawal threshold. What is left
-- is the tail of the same bug: keys the settings UI happily
-- edits and no code path ever reads.
--
--   season_settings.compression_factor       panel 0.1, SQL default 0.5
--   season_settings.soft_compression_enabled read by nothing
--   session_caps.max_rated_*_per_session     hardcoded 3, and the
--                                            function had no callers at all
--   challenge_rules.challenge_expiry_hours   frozen into a column DEFAULT
--   challenge_rules.elo_range / ladder_range read by nothing
--
-- walkover_rules.grace_period_minutes is deliberately NOT wired
-- here — see the note at the bottom of this file.
-- ============================================================

-- ============================================================
-- SETTINGS READERS — non-integer siblings of platform_setting_int
-- ============================================================

-- platform_setting_int (00048) covers the integer keys. compression_factor is
-- a fraction and soft_compression_enabled is a flag, so they need their own
-- readers. Identical defensive contract to 00048: a missing row, missing key,
-- NULL, or a value that will not cast falls back to the supplied default
-- rather than erroring or — far worse — silently resolving to 0/false and
-- either flattening every rating or switching a rule off without anyone
-- noticing.
CREATE OR REPLACE FUNCTION platform_setting_numeric(p_section TEXT, p_key TEXT, p_default NUMERIC)
RETURNS NUMERIC AS $$
DECLARE
  v_raw TEXT;
BEGIN
  SELECT value->>p_key INTO v_raw FROM platform_settings WHERE key = p_section;
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN p_default;
  END IF;
  RETURN v_raw::NUMERIC;
EXCEPTION WHEN OTHERS THEN
  RETURN p_default;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION platform_setting_numeric(TEXT, TEXT, NUMERIC) IS
  'Reads a numeric from platform_settings.<section>, falling back to the supplied default when the section, key, or value is absent, null, or not castable.';

GRANT EXECUTE ON FUNCTION platform_setting_numeric(TEXT, TEXT, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION platform_setting_bool(p_section TEXT, p_key TEXT, p_default BOOLEAN)
RETURNS BOOLEAN AS $$
DECLARE
  v_raw TEXT;
BEGIN
  SELECT value->>p_key INTO v_raw FROM platform_settings WHERE key = p_section;
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN p_default;
  END IF;
  RETURN v_raw::BOOLEAN;
EXCEPTION WHEN OTHERS THEN
  RETURN p_default;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION platform_setting_bool(TEXT, TEXT, BOOLEAN) IS
  'Reads a boolean from platform_settings.<section>, falling back to the supplied default when the section, key, or value is absent, null, or not castable.';

GRANT EXECUTE ON FUNCTION platform_setting_bool(TEXT, TEXT, BOOLEAN) TO authenticated;

-- ============================================================
-- 1 + 2. season_settings.compression_factor / soft_compression_enabled
--
-- setActiveSeason() calls activate_season(p_season_id, p_elo_policy => 'soft')
-- and never passes p_compression_factor, so the SQL default 0.5 has been
-- applying while the admin panel has said 0.1 since the settings UI shipped.
--
-- The parameter default becomes NULL and the setting fills the gap, so an
-- explicit caller-supplied factor still wins. Identity arguments stay
-- (uuid, text, numeric), so this CREATE OR REPLACE lands on the one existing
-- overload (verified: activate_season has exactly one).
--
-- soft_compression_enabled raises rather than silently no-opping. An operator
-- who picks "Soft reset" in the season dialog while the club-level switch is
-- off has asked for two contradictory things; carrying ratings over in silence
-- is an outcome they cannot undo, whereas a failed activation is one toast and
-- a retry. The whole function is one transaction, so nothing partial happens.
-- ============================================================

CREATE OR REPLACE FUNCTION public.activate_season(
  p_season_id uuid,
  p_elo_policy text DEFAULT 'carry'::text,
  p_compression_factor numeric DEFAULT NULL::numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prev_season uuid;
  v_factor numeric;
BEGIN
  IF p_elo_policy NOT IN ('carry', 'soft', 'full') THEN
    RAISE EXCEPTION 'invalid elo policy: %', p_elo_policy;
  END IF;

  IF p_elo_policy = 'soft' THEN
    IF NOT platform_setting_bool('season_settings', 'soft_compression_enabled', TRUE) THEN
      RAISE EXCEPTION 'Soft compression is disabled in platform settings — enable it or choose a different Elo policy';
    END IF;

    -- COALESCE, not a parameter default: an explicit factor from a caller who
    -- knows what it wants still wins, and only an omitted one falls through to
    -- the panel. Clamped to [0,1] because the formula below inverts ratings
    -- above 1 and inflates them below 0; the settings UI already bounds the
    -- field, this stops a hand-edited row from doing damage.
    v_factor := LEAST(1, GREATEST(0,
      COALESCE(p_compression_factor,
               platform_setting_numeric('season_settings', 'compression_factor', 0.5))));
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
    UPDATE ratings SET
      singles_elo = 400, doubles_elo = 400,
      singles_provisional = TRUE, doubles_provisional = TRUE,
      singles_matches_played = 0, doubles_matches_played = 0,
      singles_k_factor = 80, doubles_k_factor = 64,
      updated_at = NOW();
  ELSIF p_elo_policy = 'soft' THEN
    -- Formula carried over verbatim; only the source of the factor changed.
    -- The GREATEST(...) term is the 200-point tier floor: nobody drops below
    -- the bottom of the tier they earned.
    UPDATE ratings SET
      singles_elo = GREATEST(
        400 + 200 * GREATEST(0, FLOOR((singles_elo - 400) / 200.0))::int,
        ROUND(400 + (singles_elo - 400) * (1 - v_factor))::int
      ),
      doubles_elo = GREATEST(
        400 + 200 * GREATEST(0, FLOOR((doubles_elo - 400) / 200.0))::int,
        ROUND(400 + (doubles_elo - 400) * (1 - v_factor))::int
      ),
      updated_at = NOW();
  END IF;
END;
$function$;

-- ============================================================
-- 3a. session_caps.max_rated_{singles,doubles}_per_session
--
-- check_session_caps hardcoded "< 3" and — worse — had no callers anywhere in
-- SQL or TypeScript, so the panel's number was decoration on top of a rule
-- that was not running at all.
--
-- Now SECURITY DEFINER: the call site added below asks about every player on
-- the challenge, not just the submitter, and under invoker rights RLS can hide
-- another player's match rows. The count would then silently under-report and
-- the cap would fail open exactly when it is doing work.
--
-- The default stays 3 — the value that was hardcoded — so a vanished settings
-- row restores the historical rule rather than inventing a new one.
-- ============================================================

-- The cap value is needed twice — once to decide, once to quote in the error
-- message — and the two must be the same number even if an admin saves the
-- settings form in between. One helper, called once per check, guarantees that.
CREATE OR REPLACE FUNCTION public.session_cap_for(p_match_type TEXT)
RETURNS INTEGER AS $$
  SELECT platform_setting_int('session_caps', 'max_rated_' || p_match_type || '_per_session', 3);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.session_cap_for(TEXT) IS
  'Rated matches of the given type one player may play in one session (session_caps in platform_settings, default 3).';

GRANT EXECUTE ON FUNCTION public.session_cap_for(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.check_session_caps(
  p_player_id uuid,
  p_session_id uuid,
  p_match_type text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count INTEGER;
  v_cap   INTEGER;
BEGIN
  v_cap := session_cap_for(p_match_type);

  -- pending_confirmation counts: a submitted-but-unconfirmed match has been
  -- played, and leaving it out would let a player run past the cap simply by
  -- not confirming.
  SELECT COUNT(*) INTO v_count
  FROM matches m
  JOIN match_participants mp ON mp.match_id = m.id
  WHERE mp.player_id = p_player_id
    AND m.session_id = p_session_id
    AND m.match_type = p_match_type::match_type_enum
    AND m.rated_flag = TRUE
    AND m.result_status IN ('confirmed', 'pending_confirmation');

  RETURN v_count < v_cap;
END;
$function$;

COMMENT ON FUNCTION public.check_session_caps(uuid, uuid, text) IS
  'TRUE when the player has room for one more rated match of this type in this session, per session_caps in platform_settings.';

-- No client ever calls this directly — the only caller is submit_match_result,
-- which is SECURITY DEFINER and so runs it as the owner regardless of grants.
-- Now that the function reads other players' match rows as its owner, drop the
-- blanket grant it inherited. REVOKE FROM anon alone would do nothing: the
-- EXECUTE actually sits on PUBLIC (`=X/postgres` in proacl), and anon is a
-- member of PUBLIC.
REVOKE EXECUTE ON FUNCTION public.check_session_caps(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_session_caps(uuid, uuid, text) FROM anon;

-- ============================================================
-- 3b. …and give the cap a call site
--
-- Chosen enforcement point: submit_match_result. It is the only path that
-- creates a rated match carrying a session_id as a result of players choosing
-- to play:
--   * admin_create_match (apps/admin/src/lib/actions/matches.ts) never sets
--     session_id at all, and an admin entering a result by hand is the escape
--     hatch, not the thing to police.
--   * process_walkover (00049) inherits the challenge's session_id, but a
--     forfeit is not a match anyone chose to play — refusing it would leave
--     the walkover unresolvable.
-- Nothing else inserts into matches.
--
-- The check runs over every participant, not just the submitter: capping only
-- v_player would let a player at their limit hand the phone to their opponent
-- and submit through them.
--
-- It sits before the score validation so a player at the cap is told so
-- immediately rather than after typing a full scoreline.
-- ============================================================

CREATE OR REPLACE FUNCTION public.submit_match_result(
  p_challenge_id uuid,
  p_games jsonb,
  p_completed boolean DEFAULT true
)
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

-- ============================================================
-- 4. challenge_rules.challenge_expiry_hours
--
-- The 72 hours lived in the column DEFAULT, so editing the panel changed
-- nothing. Kept as a DEFAULT rather than promoted to a BEFORE INSERT trigger:
-- a default preserves the existing semantics exactly — a caller that supplies
-- expires_at still wins, a caller that omits it gets the club's number — and
-- adds no trigger surface. (challengeCreateSchema does not currently expose
-- expires_at, so today nothing supplies one; a default keeps the door open for
-- a caller that later does, which a trigger would have to re-open by hand.)
--
-- platform_setting_int is STABLE and executable by PUBLIC, which is what a
-- column default needs. Existing rows are untouched; defaults are evaluated at
-- INSERT.
-- ============================================================

ALTER TABLE challenges ALTER COLUMN expires_at
  SET DEFAULT (now() + make_interval(hours => platform_setting_int('challenge_rules', 'challenge_expiry_hours', 72)));

-- ============================================================
-- 5. challenge_rules.elo_range and ladder_range
--
-- Both have been editable and enforced nowhere since the settings UI shipped.
-- Added to validate_challenge_creation alongside the caps 00048 wired up;
-- everything else is carried over verbatim from the live definition.
--
-- Scope: creator vs opponent, on the column for the discipline being played.
-- That is what the panel's own hints describe ("Players can only challenge
-- within this many Elo points / ladder positions") and it matches the
-- repeat-opponent check above, which is also creator-vs-opponent. Averaging a
-- doubles pair's ratings would be a rule nobody wrote down.
--
-- Ladder position mirrors get_leaderboard's eligibility filter exactly, with
-- RANK() so tied ratings share a position — three of the club's players sit on
-- 400 and ROW_NUMBER would invent an ordering between them.
--
-- FAIL OPEN ON NULL, deliberately: a player who is hidden from the leaderboard
-- or has no ratings row has no ladder position and no rating. Treating that
-- absence as 0 — the exact failure 00048's reader contract warns about — would
-- read as a huge gap and bar them from ever challenging. An unknown position
-- skips the check instead.
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_challenge_creation(
  p_creator_id uuid,
  p_opponent_id uuid,
  p_type text,
  p_partner_id uuid DEFAULT NULL::uuid,
  p_opponent_partner_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_errors TEXT[] := '{}';
  v_active_count INTEGER;
  v_repeat_count INTEGER;
  v_creator_status TEXT;
  v_creator_banned BOOLEAN;
  v_creator_active BOOLEAN;
  v_opponent_status TEXT;
  v_opponent_banned BOOLEAN;
  v_opponent_active BOOLEAN;
  v_partner_expected INTEGER;
  v_partner_eligible INTEGER;
  v_max_active INTEGER;
  v_max_repeat INTEGER;
  v_window_days INTEGER;
  v_elo_range INTEGER;
  v_ladder_range INTEGER;
  v_creator_elo INTEGER;
  v_opponent_elo INTEGER;
  v_creator_pos INTEGER;
  v_opponent_pos INTEGER;
BEGIN
  -- Read once per call. These are cheap single-row lookups and reading them
  -- up front keeps the cap value used in the test identical to the one quoted
  -- back in the error message.
  v_max_active := platform_setting_int('challenge_rules', 'max_active_challenges', 3);
  v_window_days := platform_setting_int('repeat_opponent_caps', 'window_days', 7);
  v_max_repeat := CASE
    WHEN p_type = 'doubles'
      THEN platform_setting_int('repeat_opponent_caps', 'max_rated_doubles_same_combo_7days', 2)
    ELSE platform_setting_int('repeat_opponent_caps', 'max_rated_singles_vs_same_7days', 2)
  END;
  -- No previously-hardcoded value to fall back to — these rules never ran — so
  -- the defaults mirror what the panel currently stores. A settings row that
  -- went missing must not start refusing challenges on numbers nobody chose.
  v_elo_range := platform_setting_int('challenge_rules', 'elo_range', 9999);
  v_ladder_range := platform_setting_int('challenge_rules', 'ladder_range', 50);

  -- Check creator eligibility. A missing row (NULL status) is treated as
  -- ineligible: the IS DISTINCT FROM TRUE tests below fail closed on NULL.
  SELECT status, is_banned, active_flag
    INTO v_creator_status, v_creator_banned, v_creator_active
    FROM players WHERE id = p_creator_id;
  IF v_creator_status IS NULL
     OR v_creator_status IN ('suspended', 'inactive', 'pending_approval')
     OR v_creator_banned IS DISTINCT FROM FALSE
     OR v_creator_active IS DISTINCT FROM TRUE THEN
    v_errors := array_append(v_errors, 'Your account cannot create challenges');
  END IF;

  -- Check opponent eligibility (status + ban + deactivation).
  SELECT status, is_banned, active_flag
    INTO v_opponent_status, v_opponent_banned, v_opponent_active
    FROM players WHERE id = p_opponent_id;
  IF v_opponent_status IS NULL
     OR v_opponent_status IN ('suspended', 'inactive', 'pending_approval')
     OR v_opponent_banned IS DISTINCT FROM FALSE
     OR v_opponent_active IS DISTINCT FROM TRUE THEN
    v_errors := array_append(v_errors, 'Opponent cannot accept challenges');
  END IF;

  -- Self-challenge check
  IF p_creator_id = p_opponent_id THEN
    v_errors := array_append(v_errors, 'Cannot challenge yourself');
  END IF;

  -- Active challenge cap — challenge_rules.max_active_challenges
  SELECT COUNT(*) INTO v_active_count FROM challenges
  WHERE created_by = p_creator_id AND status IN ('proposed', 'partially_confirmed', 'accepted');
  IF v_active_count >= v_max_active THEN
    v_errors := array_append(v_errors,
      format('Maximum %s active challenges reached', v_max_active));
  END IF;

  -- Repeat opponent — repeat_opponent_caps, per match type, over a
  -- configurable window. The message quotes the live numbers so an admin who
  -- changes the cap sees the change reflected back instead of stale copy.
  SELECT COUNT(*) INTO v_repeat_count FROM matches m
  JOIN match_participants mp1 ON mp1.match_id = m.id AND mp1.player_id = p_creator_id
  JOIN match_participants mp2 ON mp2.match_id = m.id AND mp2.player_id = p_opponent_id AND mp2.team_side != mp1.team_side
  WHERE m.played_at > NOW() - make_interval(days => v_window_days)
    AND m.match_type = p_type::match_type_enum;
  IF v_repeat_count >= v_max_repeat THEN
    v_errors := array_append(v_errors,
      format('Maximum %s rated matches vs same opponent in %s days', v_max_repeat, v_window_days));
  END IF;

  -- Elo range — challenge_rules.elo_range
  SELECT CASE WHEN p_type = 'doubles' THEN doubles_elo ELSE singles_elo END
    INTO v_creator_elo FROM ratings WHERE player_id = p_creator_id;
  SELECT CASE WHEN p_type = 'doubles' THEN doubles_elo ELSE singles_elo END
    INTO v_opponent_elo FROM ratings WHERE player_id = p_opponent_id;
  IF v_creator_elo IS NOT NULL AND v_opponent_elo IS NOT NULL
     AND ABS(v_creator_elo - v_opponent_elo) > v_elo_range THEN
    v_errors := array_append(v_errors,
      format('Opponent is %s Elo away — challenges are limited to %s points',
             ABS(v_creator_elo - v_opponent_elo), v_elo_range));
  END IF;

  -- Ladder range — challenge_rules.ladder_range
  SELECT
    MAX(pos) FILTER (WHERE id = p_creator_id),
    MAX(pos) FILTER (WHERE id = p_opponent_id)
    INTO v_creator_pos, v_opponent_pos
  FROM (
    SELECT p.id,
           RANK() OVER (ORDER BY CASE WHEN p_type = 'doubles' THEN r.doubles_elo
                                      ELSE r.singles_elo END DESC)::INTEGER AS pos
      FROM players p
      JOIN ratings r ON r.player_id = p.id
     WHERE p.active_flag = TRUE
       AND p.hide_from_leaderboard = FALSE
       AND p.status NOT IN ('pending_approval', 'suspended')
  ) ladder;
  IF v_creator_pos IS NOT NULL AND v_opponent_pos IS NOT NULL
     AND ABS(v_creator_pos - v_opponent_pos) > v_ladder_range THEN
    v_errors := array_append(v_errors,
      format('Opponent is %s ladder positions away — challenges are limited to %s',
             ABS(v_creator_pos - v_opponent_pos), v_ladder_range));
  END IF;

  -- Doubles partner checks
  IF p_type = 'doubles' THEN
    IF p_partner_id IS NULL OR p_opponent_partner_id IS NULL THEN
      v_errors := array_append(v_errors, 'Doubles requires a partner for each side');
    END IF;
    IF p_partner_id = p_creator_id OR p_partner_id = p_opponent_id OR p_opponent_partner_id = p_creator_id THEN
      v_errors := array_append(v_errors, 'Duplicate player in challenge');
    END IF;
    -- The opponent's partner was never compared against the opponent, so the
    -- same member could fill both slots on side B.
    IF p_opponent_partner_id = p_opponent_id OR p_opponent_partner_id = p_partner_id THEN
      v_errors := array_append(v_errors, 'Duplicate player in challenge');
    END IF;

    v_partner_expected := (
      SELECT COUNT(*) FROM (VALUES (p_partner_id), (p_opponent_partner_id)) AS t(id)
      WHERE t.id IS NOT NULL
    );

    SELECT COUNT(*) INTO v_partner_eligible
      FROM players
      WHERE id IN (p_partner_id, p_opponent_partner_id)
        -- status::TEXT, not a bare enum comparison: the status list below is
        -- carried over verbatim from the original function and contains
        -- 'inactive', which is NOT a player_status label (the enum is
        -- competitive/recreational/pending_approval/suspended). The creator and
        -- opponent checks only ever compared it through a TEXT variable, so the
        -- stray value was inert; comparing the enum directly would raise
        -- "invalid input value for enum player_status". Keeping the cast keeps
        -- the semantics identical and tolerates the label being added later.
        AND status::TEXT NOT IN ('suspended', 'inactive', 'pending_approval')
        AND is_banned = FALSE
        AND active_flag = TRUE;

    IF v_partner_eligible <> v_partner_expected THEN
      v_errors := array_append(v_errors, 'A selected partner cannot join challenges');
    END IF;
  END IF;

  RETURN jsonb_build_object('valid', array_length(v_errors, 1) IS NULL, 'errors', to_jsonb(v_errors));
END;
$function$;

-- ============================================================
-- 6. walkover_rules.grace_period_minutes — NOT wired, on purpose
--
-- The obvious rule ("a no-show cannot be reported until N minutes after the
-- scheduled start") has no anchor Postgres can trust:
--   * challenges.scheduled_date / scheduled_time and sessions.date /
--     start_time are all nullable, and the two time columns are
--     `time without time zone` with no timezone column anywhere. Turning them
--     into an instant means hardcoding a club timezone that nothing in the
--     schema states.
--   * walkovers.grace_period_ends_at exists but is read by nothing, in SQL or
--     TypeScript, and is NULL on every row. Populating it would look like
--     enforcement while enforcing nothing.
-- Anything else would be a rule invented here rather than one the club wrote.
-- The dead constants (packages/shared/src/utils/constants.ts and
-- supabase/functions/_shared/constants.ts) are left in place for the same
-- reason: removing them would suggest the setting had been dealt with.
-- ============================================================
