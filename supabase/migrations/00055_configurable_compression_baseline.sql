-- ============================================================
-- 00055_configurable_compression_baseline.sql — the ladder
-- floor and the tier size stop being magic numbers
--
-- activate_season hardcoded 400 (the floor every rating is
-- compressed toward, and the value a full reset writes) and 200
-- (the tier band nobody drops below). Both are club policy, not
-- constants, and the club wants to change them — tiers in
-- particular are likely to be reworked.
--
-- 400 was already editable as rating_defaults.default_elo, and
-- that key was already the starting rating for a new player.
-- Reusing it rather than minting a second key keeps ONE value
-- for one concept: the bottom of the ladder. A second key would
-- be the same "one rule, two implementations" trap that has cost
-- this codebase repeatedly.
--
-- tier_size is genuinely new, so it is seeded at 200 — today's
-- behaviour — and nothing moves until someone edits it.
-- ============================================================

UPDATE platform_settings
   SET value = value || jsonb_build_object('tier_size', 200)
 WHERE key = 'season_settings'
   AND NOT value ? 'tier_size';

-- ============================================================
-- activate_season — same formula, values from settings
--
-- Body reproduced verbatim apart from the two substitutions; the
-- snapshot, the active-flag swap and the 'full' branch's
-- provisional/k-factor resets are unchanged.
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
  v_baseline integer;
  v_tier integer;
BEGIN
  IF p_elo_policy NOT IN ('carry', 'soft', 'full') THEN
    RAISE EXCEPTION 'invalid elo policy: %', p_elo_policy;
  END IF;

  -- The bottom of the ladder. Same key a new player starts at, because it is
  -- the same idea — reusing it means the floor can never disagree with itself.
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
      singles_elo = v_baseline, doubles_elo = v_baseline,
      singles_provisional = TRUE, doubles_provisional = TRUE,
      singles_matches_played = 0, doubles_matches_played = 0,
      singles_k_factor = 80, doubles_k_factor = 64,
      updated_at = NOW();
  ELSIF p_elo_policy = 'soft' THEN
    -- The GREATEST(...) term is the tier floor: nobody drops below the bottom
    -- of the tier they earned.
    UPDATE ratings SET
      singles_elo = GREATEST(
        v_baseline + v_tier * GREATEST(0, FLOOR((singles_elo - v_baseline) / v_tier::numeric))::int,
        ROUND(v_baseline + (singles_elo - v_baseline) * (1 - v_factor))::int
      ),
      doubles_elo = GREATEST(
        v_baseline + v_tier * GREATEST(0, FLOOR((doubles_elo - v_baseline) / v_tier::numeric))::int,
        ROUND(v_baseline + (doubles_elo - v_baseline) * (1 - v_factor))::int
      ),
      updated_at = NOW();
  END IF;
END;
$function$;
