-- ============================================================
-- 00275: EACH EVENT CAN SET ITS OWN POINTS, EACH TOURNAMENT ITS OWN BONUSES
--
-- Ladder points were two tables written into finalize.ts: a knockout paid
-- 100/75/50/40, 25 to the rest of the last eight and 10 to everyone else; a
-- round robin paid 1 to take part and 3 a win. A staged event (00272) already
-- carries its own table in format_config.points. This gives the legacy formats
-- the same, and lets a tournament pay placement bonuses other than the club's.
--
-- WHAT CHANGES.
--   * tournament_events.points_config jsonb: the ladder points table of a
--     legacy event, { byPlace: [..], rest, participation, perWin }, as
--     formatPointsSchema in packages/shared validates it. NULL means the
--     format's default, which is exactly what finalize.ts paid before. Never
--     set on a staged event, whose table lives in format_config.points.
--   * tournaments.placement_bonus_amounts jsonb: amounts this tournament pays
--     instead of the club's (platform_settings.tournament_bonuses), in the same
--     flat keys (singles_champion, doubles_thirdplace, ...). A key left out
--     takes the club's amount; NULL means the club's amounts throughout.
--   * platform_settings.tournament_bonuses gains singles_thirdplace and
--     doubles_thirdplace where it lacks them, at 16 and 14: the amounts the code
--     already pays when the keys are absent (PLACEMENT_BONUSES), so no payout
--     moves. The Ratings page draws a field only when its key is in the row, so
--     without this the two new third-place fields would never appear. A value
--     already in the row wins.
--
-- WHY NOTHING ELSE. Points are written by the app at finalisation and read by
-- get_leaderboard as stored, so no function changes. Images update before
-- migrations run: the app reads both columns off select('*') rows, so an
-- image ahead of this file pays the defaults and refuses only a write that
-- names a column the database lacks ("Run migration 00275 first").
-- ============================================================

BEGIN;

ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS points_config jsonb;

COMMENT ON COLUMN public.tournament_events.points_config IS
  'The ladder points table of a legacy-format event (00275): { byPlace, rest, participation, perWin }, as formatPointsSchema in packages/shared validates it. NULL pays the format''s default. Always NULL on a staged event, whose table is format_config.points.';

ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_points_config_shape;
ALTER TABLE public.tournament_events ADD CONSTRAINT tournament_events_points_config_shape
  CHECK (points_config IS NULL OR (
    format <> 'staged'
    AND jsonb_typeof(points_config) = 'object'
    AND COALESCE(jsonb_typeof(points_config->'byPlace'), '') = 'array'
  ));

ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS placement_bonus_amounts jsonb;

COMMENT ON COLUMN public.tournaments.placement_bonus_amounts IS
  'Placement bonus amounts this tournament pays instead of the club''s (00275), in the flat keys of platform_settings.tournament_bonuses. A missing key takes the club''s amount; NULL means the club''s amounts throughout.';

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_placement_bonus_amounts_shape;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_placement_bonus_amounts_shape
  CHECK (placement_bonus_amounts IS NULL OR jsonb_typeof(placement_bonus_amounts) = 'object');

UPDATE public.platform_settings
   SET value = jsonb_build_object('singles_thirdplace', 16, 'doubles_thirdplace', 14) || value
 WHERE key = 'tournament_bonuses'
   AND jsonb_typeof(value) = 'object'
   AND NOT (value ? 'singles_thirdplace' AND value ? 'doubles_thirdplace');

-- ============================================================
-- VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_bad text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournament_events'
       AND column_name = 'points_config' AND data_type = 'jsonb' AND is_nullable = 'YES'
  ) THEN
    v_bad := array_append(v_bad, 'tournament_events.points_config is missing or not nullable jsonb');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournaments'
       AND column_name = 'placement_bonus_amounts' AND data_type = 'jsonb' AND is_nullable = 'YES'
  ) THEN
    v_bad := array_append(v_bad, 'tournaments.placement_bonus_amounts is missing or not nullable jsonb');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tournament_events_points_config_shape'
       AND conrelid = 'public.tournament_events'::regclass AND contype = 'c'
  ) THEN
    v_bad := array_append(v_bad, 'tournament_events_points_config_shape is missing');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tournaments_placement_bonus_amounts_shape'
       AND conrelid = 'public.tournaments'::regclass AND contype = 'c'
  ) THEN
    v_bad := array_append(v_bad, 'tournaments_placement_bonus_amounts_shape is missing');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.platform_settings
     WHERE key = 'tournament_bonuses' AND jsonb_typeof(value) = 'object'
       AND NOT (value ? 'singles_thirdplace' AND value ? 'doubles_thirdplace')
  ) THEN
    v_bad := array_append(v_bad, 'tournament_bonuses still lacks a third-place key');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00275 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00275 verified: points_config and placement_bonus_amounts are in place, and the bonus settings carry both third-place keys.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
