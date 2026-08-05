-- ============================================================
-- 00044_elo_bounds_on_margin_overload.sql — finish what 00041 started
-- ============================================================
-- 00041 made the rating clamp configurable, but patched the WRONG overload.
--
-- calculate_elo_update exists twice. 00003 defined it with 6 parameters; 00028
-- added margin scaling by declaring a SEVEN-parameter version instead of
-- replacing the original — CREATE OR REPLACE only replaces on an exact
-- signature match, so adding p_margin_multiplier created a sibling and orphaned
-- the old one. apply_match_result calls the 7-arg version, so 00041 rewrote a
-- function nothing uses: K-factor and provisional threshold became configurable
-- (those live in apply_match_result itself, which 00041 did patch), while
-- max_elo/min_elo silently did not apply to challenges at all.
--
-- Nothing was broken by that — the caller passes all 7 arguments explicitly, so
-- resolution was never ambiguous for it. The feature was simply half-wired.
--
-- Also DROPS the orphaned 6-arg version. Because the 7th parameter carries
-- DEFAULT 1.0, a 6-argument call currently matches BOTH and fails with
-- "function is not unique" — so removing the orphan does not break 6-arg
-- callers, it makes them work again by resolving to the 7-arg default.
-- ============================================================

DROP FUNCTION IF EXISTS calculate_elo_update(integer, integer, integer, numeric, numeric, boolean);

CREATE OR REPLACE FUNCTION public.calculate_elo_update(p_player_rating integer, p_opponent_rating integer, p_k_factor integer, p_format_weight numeric, p_event_multiplier numeric, p_won boolean, p_margin_multiplier numeric DEFAULT 1.0)
 RETURNS TABLE(new_rating integer, delta integer, expected numeric)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v_expected NUMERIC;
  v_actual NUMERIC;
  v_delta INTEGER;
  v_new INTEGER;
  v_lo INTEGER;
  v_hi INTEGER;
BEGIN
  v_expected := 1.0 / (1.0 + POWER(10, (p_opponent_rating - p_player_rating)::NUMERIC / 800));
  v_actual := CASE WHEN p_won THEN 1.0 ELSE 0.0 END;
  v_delta := ROUND(p_k_factor * p_format_weight * p_event_multiplier
                   * COALESCE(p_margin_multiplier, 1.0) * (v_actual - v_expected));

  -- Clamp the new rating to [100, 1500], then derive the delta from the clamped
  -- value so new_rating and delta stay consistent at the bounds (mirrors the TS
  -- engine's clampElo).
  SELECT lo, hi INTO v_lo, v_hi FROM rating_bounds();
  v_new := GREATEST(v_lo, LEAST(v_hi, p_player_rating + v_delta));

  RETURN QUERY SELECT
    v_new AS new_rating,
    (v_new - p_player_rating) AS delta,
    v_expected AS expected;
END;
$function$;
