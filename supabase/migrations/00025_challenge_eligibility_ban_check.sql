-- ============================================================
-- 00025 - validate_challenge_creation: ban / deactivation / partner checks
-- ============================================================
-- Pre-existing gap. The function (00003_functions.sql) checked only
-- players.status IN ('suspended','inactive','pending_approval') and never
-- looked at the two independent eligibility columns:
--
--   * is_banned  — a separate column, not folded into status. The only
--     is_banned check in the codebase lives in requirePlayer()
--     (apps/player/src/lib/actions/_shared.ts), which gates the CREATOR of an
--     action, never the OPPONENT. So a banned member could be challenged.
--   * active_flag — a deactivated member could likewise be challenged. The
--     /challenges/new picker filters active_flag, but that is client-side
--     only and trivially bypassed by posting an arbitrary opponent_id.
--
-- Both matter more now that a profile QR hands out a prefilled
-- ?opponent=<uuid> link: the id is attacker-supplyable by construction, and
-- this function is the fail-closed gate createChallenge relies on.
--
-- Also extends the doubles branch: partner and opponent_partner were only
-- checked for duplication, never for eligibility, so a banned/suspended member
-- could be dragged into a doubles challenge as a partner.
--
-- Notes:
--   * CREATE OR REPLACE with the identical signature — the argument list is
--     unchanged, so no DROP is needed and dependent grants survive.
--   * The function stays LANGUAGE plpgsql with NO SECURITY DEFINER and no
--     `SET search_path`, unlike its neighbours in 00003. That is preserved
--     deliberately: it is invoked via supabase.rpc() under the caller's
--     session, so its SELECTs on `players` run through that caller's RLS.
--     Switching to DEFINER would change which rows are visible to those
--     lookups and could mask, not fix, an eligibility miss. Hardening it is a
--     separate change that needs its own RLS review.
--   * Error strings stay generic ("Opponent cannot accept challenges") — they
--     surface to the challenger, who should not learn that a specific member
--     is banned.
--   * Forward-only and idempotent. Like every other migration here it omits
--     BEGIN/COMMIT; apply as a single transaction (psql --single-transaction),
--     matching the runbook.
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
  v_creator_banned BOOLEAN;
  v_creator_active BOOLEAN;
  v_opponent_status TEXT;
  v_opponent_banned BOOLEAN;
  v_opponent_active BOOLEAN;
  v_partner_expected INTEGER;
  v_partner_eligible INTEGER;
BEGIN
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
    -- The opponent's partner was never compared against the opponent, so the
    -- same member could fill both slots on side B.
    IF p_opponent_partner_id = p_opponent_id OR p_opponent_partner_id = p_partner_id THEN
      v_errors := array_append(v_errors, 'Duplicate player in challenge');
    END IF;
    -- Partners were previously enrolled with no eligibility check at all, so a
    -- banned/suspended/deactivated member could be dragged into a doubles
    -- challenge. Count the supplied ids that are eligible and require every
    -- one of them to match — a count comparison (rather than bool_and over the
    -- matched rows) also rejects an id that resolves to no player at all.
    SELECT COUNT(DISTINCT pid) INTO v_partner_expected
      FROM unnest(ARRAY[p_partner_id, p_opponent_partner_id]) AS pid
      WHERE pid IS NOT NULL;

    -- id IN (a, NULL) matches only a, so a one-sided call counts correctly.
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
$$ LANGUAGE plpgsql;
