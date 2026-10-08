-- ============================================================
-- 00027_match_integrity.sql — close the match-forgery / Elo-dodge holes
-- ============================================================
-- Two audit findings, one root cause: the `authenticated` role holds
-- table-level INSERT/UPDATE on matches, match_participants and match_games, so
-- anything a participant can reach through PostgREST they can also write
-- directly, bypassing the RPCs that enforce the rules.
--
--   H2/M6 — Elo dodge. `matches_update` (00005_rls.sql:173) lets any
--   participant UPDATE the match row. Elo is only ever applied inside
--   apply_match_result(), so PATCHing result_status straight to 'confirmed'
--   marks the match settled while skipping the rating change entirely — a
--   losing player can null out their own Elo loss. The same write also fires
--   on_match_confirmed (00004_triggers.sql:70), inflating head-to-head and
--   partnership stats with an attacker-chosen verdict.
--
--   H4/A1 — non-atomic submit + forged participants. submitMatchResult does
--   three separate writes (match, participants, games) from the app. It already
--   compensates by deleting the match if a later write fails, but a crash
--   between the insert and that compensation wedges the challenge permanently
--   (the unique index on challenge_id blocks any resubmit). Worse, because the
--   client supplies the participant rows, a submitter can enrol ANY player —
--   including a victim — rather than the people on the challenge.
--
-- The fix is privileges, not filtering. Rather than adding a trigger that tries
-- to distinguish "good" writes from "bad" ones, we REVOKE the ability to write
-- these tables from `authenticated` altogether and expose the two legitimate
-- operations as SECURITY DEFINER functions. Definer functions run as the owner,
-- so they are unaffected by the revoke — no transaction-local flag to set, and
-- no trusted path that can be forgotten later and break in production.
--
-- NOTE: a previous attempt used a BEFORE UPDATE trigger. It broke
-- confirm_match_result(), which is SECURITY DEFINER but still sees the
-- participant's auth.uid(), so the trigger could not tell a legitimate
-- confirmation from a forged one. Privileges have no such ambiguity.
-- ============================================================

-- ------------------------------------------------------------
-- 1. dispute_match_result — the only UPDATE a member still needs
-- ------------------------------------------------------------
-- Replaces the raw `UPDATE matches SET result_status='disputed'` in
-- actions/matches.ts. Also fixes two bugs the audit flagged on that path: there
-- was no status precheck (a voided or already-disputed match could be
-- re-disputed) and no dedup (the same player could open unlimited disputes).
CREATE OR REPLACE FUNCTION dispute_match_result(
  p_match_id        UUID,
  p_reason_category dispute_reason,
  p_description     TEXT
) RETURNS UUID AS $$
DECLARE
  v_player  UUID := get_player_id(auth.uid());
  v_match   matches%ROWTYPE;
  v_dispute UUID;
BEGIN
  IF v_player IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF v_match.id IS NULL THEN
    RAISE EXCEPTION 'Match not found';
  END IF;

  -- Only the people who played it may dispute it.
  IF NOT EXISTS (
    SELECT 1 FROM match_participants
     WHERE match_id = p_match_id AND player_id = v_player
  ) THEN
    RAISE EXCEPTION 'Only a participant can dispute this match';
  END IF;

  IF v_match.result_status NOT IN ('pending_confirmation', 'confirmed') THEN
    RAISE EXCEPTION 'This match cannot be disputed (status: %)', v_match.result_status;
  END IF;

  -- One open dispute per match — otherwise a member can spam the admin queue.
  IF EXISTS (
    SELECT 1 FROM disputes
     WHERE match_id = p_match_id AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'A dispute is already open for this match';
  END IF;

  UPDATE matches SET result_status = 'disputed', updated_at = NOW() WHERE id = p_match_id;

  INSERT INTO disputes (match_id, opened_by, reason_category, description, status)
  VALUES (p_match_id, v_player, p_reason_category, p_description, 'open')
  RETURNING id INTO v_dispute;

  RETURN v_dispute;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION dispute_match_result(UUID, dispute_reason, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dispute_match_result(UUID, dispute_reason, TEXT) TO authenticated, service_role;


-- ------------------------------------------------------------
-- 2. submit_match_result — one transaction, server-derived participants
-- ------------------------------------------------------------
-- Participants come from challenge_participants, never from the caller, so a
-- submitter can no longer enrol someone who wasn't on the challenge (A1).
-- match/participants/games all insert in a single transaction, so a failure
-- rolls the whole thing back instead of leaving a half-built match (H4).
-- format_weight / event_multiplier are set by trigger_set_match_weights
-- (00004_triggers.sql) on insert, so they are deliberately not passed in.
CREATE OR REPLACE FUNCTION submit_match_result(
  p_challenge_id UUID,
  p_games        JSONB,   -- [{"side_a_score":21,"side_b_score":19}, ...]
  p_completed    BOOLEAN DEFAULT TRUE
) RETURNS UUID AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION submit_match_result(UUID, JSONB, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_match_result(UUID, JSONB, BOOLEAN) TO authenticated, service_role;


-- ------------------------------------------------------------
-- 3. Remove direct write access — the actual fix
-- ------------------------------------------------------------
-- With both legitimate operations behind definer functions, `authenticated`
-- has no remaining reason to write these tables. SELECT stays (RLS governs
-- reads); service_role is untouched so the admin app keeps working.
REVOKE INSERT, UPDATE, DELETE ON matches            FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON match_participants FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON match_games        FROM authenticated;
