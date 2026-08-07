-- ============================================================
-- 00067 — soft compression pulls toward the club average, not the floor
--
-- The settings panel has always described this as
--   "Soft compression — Pull every rating toward the average at season end"
--   "How strongly season-end ratings are pulled toward the average (0 to 1)"
-- but the code compressed toward rating_defaults.default_elo, which is the
-- ladder FLOOR (400 today) and the value a brand-new player starts at. The
-- club's actual mean is well above it, so every season quietly deflated the
-- whole ladder toward the floor rather than tightening it around the middle.
--
-- Two different concepts had been sharing one setting:
--   * default_elo — where a new player starts. Also the origin the tier bands
--     are measured from.
--   * the compression target — the point ratings converge on at season end.
--
-- This splits them. The tier floor below still measures from default_elo,
-- deliberately: a tier is defined as a band above the ladder floor, and moving
-- that origin would silently renumber everyone's tier. Only the compression
-- TARGET moves to the mean.
--
-- Effect at the current spread (min 400, max 1423, mean 782) with factor 0.1:
--   before:  1423 -> 1320   (pulled toward 400)
--   after:   1423 -> 1359   (pulled toward 782)
--   before:   400 ->  400   (already at the target; unchanged)
--   after:    400 ->  438   (pulled UP toward the mean — this is the point)
--
-- The mean is computed BEFORE the update, into a variable. Reading it inline
-- would make it a moving target as rows are rewritten.
--
-- The mean is taken over every ratings row, which is what "the club average"
-- plainly means and what the panel promises. Note that provisional players sit
-- at the floor and so pull the mean down; if that turns out to be undesirable,
-- restrict the two SELECTs below to singles_provisional = FALSE rather than
-- reintroducing a separate baseline setting.
-- ============================================================

-- The parameter DEFAULTS must be repeated verbatim. CREATE OR REPLACE cannot
-- drop them ("cannot remove parameter defaults from existing function"), and
-- omitting them fails the whole migration — caught by running this against
-- staging first.
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
  -- Separate means: singles and doubles are independent ladders and their
  -- distributions differ, so one shared average would drag one of them.
  v_singles_mean numeric;
  v_doubles_mean numeric;
BEGIN
  IF p_elo_policy NOT IN ('carry', 'soft', 'full') THEN
    RAISE EXCEPTION 'invalid elo policy: %', p_elo_policy;
  END IF;

  -- The bottom of the ladder. Same key a new player starts at, because it is
  -- the same concept: where an unrated player sits. Still the origin for tier
  -- bands and still the target for a FULL reset — only soft compression stops
  -- using it as its convergence point.
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

    -- Snapshot the means before anything is rewritten. COALESCE covers an empty
    -- ratings table, where AVG returns NULL and every arithmetic result below
    -- would become NULL — wiping the ladder instead of compressing it.
    SELECT COALESCE(AVG(singles_elo), v_baseline), COALESCE(AVG(doubles_elo), v_baseline)
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
    UPDATE ratings SET
      singles_elo = v_baseline, doubles_elo = v_baseline,
      singles_provisional = TRUE, doubles_provisional = TRUE,
      singles_matches_played = 0, doubles_matches_played = 0,
      singles_k_factor = 80, doubles_k_factor = 64,
      updated_at = NOW();
  ELSIF p_elo_policy = 'soft' THEN
    -- The GREATEST(...) term is the tier floor: nobody drops below the bottom
    -- of the tier they earned. It is still measured from v_baseline — tiers are
    -- bands above the ladder floor, and re-basing them on a mean that moves
    -- every season would renumber everyone's tier each rollover.
    --
    -- The second term is the compression itself, now converging on the mean.
    -- Because the floor only ever raises the result, a player BELOW the mean is
    -- pulled up by the compression and left there, which is the behaviour the
    -- settings panel has always described.
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

COMMENT ON FUNCTION public.activate_season(uuid, text, numeric) IS
  'Activates a season. elo_policy: carry (leave ratings alone), soft (compress toward the CLUB AVERAGE, never below the tier the player earned), full (reset everyone to the ladder floor and mark provisional). Previous ratings are archived to season_final_ratings before anything is written, so a rollover is recoverable.';
