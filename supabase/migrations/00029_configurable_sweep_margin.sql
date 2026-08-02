-- ============================================================
-- 00029_configurable_sweep_margin.sql — make the sweep bonus tunable
-- ============================================================
-- 00028 hardcoded the margin-of-victory bonus at 1.15. Rating knobs belong in
-- platform_settings next to the K-factors and starting Elo, so an admin can
-- tune the ladder's feel without a migration and a redeploy.
--
-- Lives in `rating_defaults` alongside default_elo / provisional_threshold /
-- the K-factors. 1.0 disables margin scaling entirely, which is the escape
-- hatch if it turns out to encourage running up the score.
-- ============================================================

UPDATE platform_settings
   SET value = value || jsonb_build_object('sweep_margin_multiplier', 1.15)
 WHERE key = 'rating_defaults'
   AND NOT (value ? 'sweep_margin_multiplier');

-- Now reads the configured value instead of a literal. NOTE: this is STABLE,
-- not IMMUTABLE as in 00028 — it touches a table now, and mislabelling it
-- IMMUTABLE would let the planner cache a stale multiplier across a settings
-- change within the same statement.
CREATE OR REPLACE FUNCTION get_margin_multiplier(p_games_won INTEGER, p_games_lost INTEGER)
RETURNS NUMERIC AS $$
DECLARE
  v_mult NUMERIC;
BEGIN
  IF p_games_won IS NULL OR p_games_lost IS NULL THEN RETURN 1.0; END IF;
  -- Single-game format, or no games recorded (e.g. a walkover).
  IF p_games_won + p_games_lost < 2 THEN RETURN 1.0; END IF;
  -- Match went the distance — no bonus either way.
  IF p_games_won > 0 AND p_games_lost > 0 THEN RETURN 1.0; END IF;

  SELECT COALESCE((value->>'sweep_margin_multiplier')::NUMERIC, 1.15)
    INTO v_mult
    FROM platform_settings
   WHERE key = 'rating_defaults';

  -- Bound it: a malformed or wild setting must not be able to multiply every
  -- rating change by an arbitrary factor.
  RETURN LEAST(2.0, GREATEST(1.0, COALESCE(v_mult, 1.15)));
END;
$$ LANGUAGE plpgsql STABLE;
