-- ============================================================
-- 00068 — the compression mean ignores provisional players
--
-- 00067 moved soft compression's target from the ladder floor to the club
-- average, but took that average over EVERY ratings row. A provisional player
-- has not established a rating yet — they sit at the floor until they have
-- played enough matches — so including them drags the target down toward the
-- floor, which is most of what 00067 set out to stop. At the current roster
-- that skew is severe: most rows are provisional and sitting at 400.
--
-- The average now covers established players only, per discipline, because a
-- player can be established at singles and provisional at doubles.
--
-- FALLBACK, and why it is not the baseline:
-- A brand-new club has no established players, so the filtered AVG is NULL. The
-- obvious COALESCE target is v_baseline, but that would silently restore the
-- exact floor-compression behaviour 00067 removed — the bug would come back
-- precisely when nobody could see it. Instead it falls back to the unfiltered
-- mean, so the behaviour degrades to "toward the average of everyone" rather
-- than to "toward the floor". Only if the ratings table is genuinely empty does
-- it reach the baseline, and at that point there is nothing to compress.
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
    UPDATE ratings SET
      singles_elo = v_baseline, doubles_elo = v_baseline,
      singles_provisional = TRUE, doubles_provisional = TRUE,
      singles_matches_played = 0, doubles_matches_played = 0,
      singles_k_factor = 80, doubles_k_factor = 64,
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

COMMENT ON FUNCTION public.activate_season(uuid, text, numeric) IS
  'Activates a season. elo_policy: carry (leave ratings alone), soft (compress toward the average of ESTABLISHED players, never below the tier the player earned), full (reset everyone to the ladder floor and mark provisional). Previous ratings are archived to season_final_ratings before anything is written, so a rollover is recoverable.';
