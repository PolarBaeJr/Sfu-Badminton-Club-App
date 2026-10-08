-- ============================================================
-- 00275_event_points_table.sql: each event can set its own points, each
-- tournament its own bonuses.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00275 applied:
--
--   docker exec -i supabase_db_cli psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/00275_event_points_table.sql
--
-- WHAT IT PROVES
-- --------------
-- The verify block checks the columns and constraints exist. This file drives
-- them: a legacy event takes a points table and NULL, a staged event refuses
-- one, a table that is not an object with a byPlace list is refused, and a
-- tournament's bonus amounts must be an object.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO tournaments (id, name, start_date) VALUES
 ('cccccccc-0275-4000-8000-0000000000a1', 'points harness', CURRENT_DATE);

INSERT INTO tournament_events
  (id, tournament_id, event_type, format, placement_bonus_enabled, external_event, format_config)
VALUES
  ('cccccccc-0275-4000-8000-0000000000e1', 'cccccccc-0275-4000-8000-0000000000a1',
   'mens_singles', 'single_elimination', true, false, NULL),
  ('cccccccc-0275-4000-8000-0000000000e2', 'cccccccc-0275-4000-8000-0000000000a1',
   'mixed_doubles', 'staged', false, true, '{"version":1,"stages":[{"key":"groups"}]}');

-- ------------------------------------------------------------
-- A. A legacy event takes a table, and goes back to NULL
-- ------------------------------------------------------------
DO $$
BEGIN
  UPDATE tournament_events
     SET points_config = '{"byPlace":[50,30,20],"rest":5,"participation":0,"perWin":0}'
   WHERE id = 'cccccccc-0275-4000-8000-0000000000e1';
  IF (SELECT points_config->'byPlace'->>0 FROM tournament_events
       WHERE id = 'cccccccc-0275-4000-8000-0000000000e1') IS DISTINCT FROM '50' THEN
    RAISE EXCEPTION 'A1: the points table did not land';
  END IF;
  UPDATE tournament_events SET points_config = NULL WHERE id = 'cccccccc-0275-4000-8000-0000000000e1';
END $$;

-- ------------------------------------------------------------
-- B. Refused shapes
-- ------------------------------------------------------------
DO $$
DECLARE
  v_case text;
  v_cases text[][] := ARRAY[
    ['B1 staged event', 'cccccccc-0275-4000-8000-0000000000e2', '{"byPlace":[],"participation":1,"perWin":3}'],
    ['B2 not an object', 'cccccccc-0275-4000-8000-0000000000e1', '[100,75]'],
    ['B3 no byPlace', 'cccccccc-0275-4000-8000-0000000000e1', '{"participation":1,"perWin":3}'],
    ['B4 byPlace not a list', 'cccccccc-0275-4000-8000-0000000000e1', '{"byPlace":100,"participation":0,"perWin":0}']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_cases, 1) LOOP
    v_case := v_cases[i][1];
    BEGIN
      UPDATE tournament_events SET points_config = v_cases[i][3]::jsonb WHERE id = v_cases[i][2]::uuid;
      RAISE EXCEPTION '%: was accepted', v_case;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- C. A tournament's bonus amounts
-- ------------------------------------------------------------
DO $$
BEGIN
  UPDATE tournaments SET placement_bonus_amounts = '{"singles_champion":40,"doubles_thirdplace":0}'
   WHERE id = 'cccccccc-0275-4000-8000-0000000000a1';
  IF (SELECT placement_bonus_amounts->>'singles_champion' FROM tournaments
       WHERE id = 'cccccccc-0275-4000-8000-0000000000a1') IS DISTINCT FROM '40' THEN
    RAISE EXCEPTION 'C1: the amounts did not land';
  END IF;
  BEGIN
    UPDATE tournaments SET placement_bonus_amounts = '[40]' WHERE id = 'cccccccc-0275-4000-8000-0000000000a1';
    RAISE EXCEPTION 'C2: a list was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  UPDATE tournaments SET placement_bonus_amounts = NULL WHERE id = 'cccccccc-0275-4000-8000-0000000000a1';
END $$;

-- ------------------------------------------------------------
-- D. The club settings carry both third-place keys
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM platform_settings
     WHERE key = 'tournament_bonuses'
       AND NOT (value ? 'singles_thirdplace' AND value ? 'doubles_thirdplace')
  ) THEN
    RAISE EXCEPTION 'D1: tournament_bonuses lacks a third-place key';
  END IF;
  RAISE NOTICE '00275 event points table: all cases passed';
END $$;

ROLLBACK;
