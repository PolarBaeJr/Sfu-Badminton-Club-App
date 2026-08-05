-- ============================================================
-- 00049_configurable_late_withdrawal_threshold.sql — make
-- walkover_rules.late_withdrawal_threshold_hours take effect
--
-- The admin panel has offered "Late withdrawal threshold
-- (hours)" since the settings UI was built, and
-- apply_walkover_result ignored it: the boundary between an
-- unpenalised early withdrawal and a 0.50-weight late one was
-- the literal 24, written twice in the function. Prod happens
-- to hold 24, so nothing is wrong today — but editing the
-- field would have changed nothing, silently, exactly like
-- the repeat-opponent caps in 00048 and the rating knobs in
-- 00041.
--
-- Both literals are replaced, not just the Elo one. They are
-- two halves of a single decision: the Elo branch decides
-- whether the withdrawal costs rating, the reliability branch
-- decides whether it is filed as a late_cancellation or an
-- early_withdrawal. Wiring only the first would let an admin
-- who raises the threshold to 48 produce a 30-hour withdrawal
-- that costs no rating yet is still recorded as a late
-- cancellation — a new inconsistency in place of the old one.
--
-- Boundary is unchanged: notice_hours = threshold is early
-- (no Elo penalty, counted as an early_withdrawal), matching
-- the previous >= 24 / < 24 pair exactly.
-- ============================================================

-- ============================================================
-- SETTINGS READER
--
-- Carried verbatim from 00048, which lives on an unmerged branch. All three
-- statements are idempotent CREATE OR REPLACE / COMMENT / GRANT, so this is a
-- no-op wherever 00048 has already run (including prod, where it has) and
-- either merge order replays cleanly. Delete this block only once 00048 is an
-- ancestor of this file.
-- ============================================================

-- rating_setting_int (00041) is hardwired to the rating_defaults row. The
-- thresholds below live in other sections, so this takes the section as an
-- argument. Same defensive contract: a missing row, missing key, NULL, or a
-- value that will not cast falls back to the supplied default rather than
-- erroring or — far worse — silently resolving to 0, which here would make
-- every withdrawal early and free.
CREATE OR REPLACE FUNCTION platform_setting_int(p_section TEXT, p_key TEXT, p_default INTEGER)
RETURNS INTEGER AS $$
DECLARE
  v_raw TEXT;
BEGIN
  SELECT value->>p_key INTO v_raw FROM platform_settings WHERE key = p_section;
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN p_default;
  END IF;
  RETURN v_raw::INTEGER;
EXCEPTION WHEN OTHERS THEN
  RETURN p_default;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION platform_setting_int(TEXT, TEXT, INTEGER) IS
  'Reads an integer from platform_settings.<section>, falling back to the supplied default when the section, key, or value is absent, null, or not castable.';

GRANT EXECUTE ON FUNCTION platform_setting_int(TEXT, TEXT, INTEGER) TO authenticated;

-- ============================================================
-- apply_walkover_result — late-withdrawal boundary from settings
--
-- Replacing the whole function rather than patching: plpgsql has no way to
-- redefine part of a body. Everything outside the two threshold comparisons
-- and the new v_late_threshold declaration/read is carried over verbatim from
-- the live definition. The signature — including p_admin_notes' DEFAULT NULL —
-- is reproduced exactly: CREATE OR REPLACE matches on the argument list, so a
-- changed type would mint a second overload and leave the old body live for
-- every existing caller.
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_walkover_result(
  p_walkover_id uuid,
  p_admin_id uuid,
  p_admin_notes text DEFAULT NULL::text
)
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
