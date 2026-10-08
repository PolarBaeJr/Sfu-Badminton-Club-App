-- ============================================================
-- 00274_external_pair_category.sql: an external team is entered with its
-- category.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00274 applied:
--
--   psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/00274_external_pair_category.sql
--
-- WHAT IT PROVES
-- --------------
-- The migration's verify block checks the function exists with the right
-- grants. This file drives it: a listed category lands on the row, no
-- category leaves the column NULL, an unknown key or a non-staged event is
-- refused and takes the new pair with it, a config without a categories list
-- accepts the default keys, and the 00269 function still works on its own.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO tournaments (id, name, start_date) VALUES
 ('cccccccc-0274-4000-8000-0000000000a1', 'category harness', CURRENT_DATE);

-- S: staged, two listed categories. D: staged, no categories list.
-- R: an external round robin.
INSERT INTO tournament_events
  (id, tournament_id, event_type, format, placement_bonus_enabled, external_event, format_config)
VALUES
  ('cccccccc-0274-4000-8000-0000000000e1', 'cccccccc-0274-4000-8000-0000000000a1',
   'mixed_doubles', 'staged', false, true,
   '{"version":1,"categories":[{"key":"mens","label":"Men''s"},{"key":"womens","label":"Women''s"}],"stages":[{"key":"groups"}]}'),
  ('cccccccc-0274-4000-8000-0000000000e2', 'cccccccc-0274-4000-8000-0000000000a1',
   'mixed_doubles', 'staged', false, true,
   '{"version":1,"stages":[{"key":"groups"}]}'),
  ('cccccccc-0274-4000-8000-0000000000e3', 'cccccccc-0274-4000-8000-0000000000a1',
   'mixed_doubles', 'round_robin', false, true, NULL);

-- ------------------------------------------------------------
-- A. A listed category lands; none leaves the column NULL
-- ------------------------------------------------------------
DO $$
DECLARE
  v uuid;
  r record;
BEGIN
  v := add_external_tournament_pair_v2('cccccccc-0274-4000-8000-0000000000e1',
                                       'Alder Finch', 'Birch Wren', NULL, 'Team Kestrel', ' womens ');
  SELECT * INTO r FROM tournament_pairs WHERE id = v;
  IF r.team_category IS DISTINCT FROM 'womens' THEN
    RAISE EXCEPTION 'A1: team_category is %, not womens', r.team_category;
  END IF;
  IF r.pair_name <> 'Team Kestrel' OR r.player1_id IS NOT NULL THEN
    RAISE EXCEPTION 'A1: the 00269 row is wrong: % %', r.pair_name, r.player1_id;
  END IF;

  v := add_external_tournament_pair_v2('cccccccc-0274-4000-8000-0000000000e1',
                                       'Cedar Lark', 'Dogwood Teal', NULL, NULL, NULL);
  SELECT * INTO r FROM tournament_pairs WHERE id = v;
  IF r.team_category IS NOT NULL THEN
    RAISE EXCEPTION 'A2: no category stored %', r.team_category;
  END IF;

  v := add_external_tournament_pair_v2('cccccccc-0274-4000-8000-0000000000e1',
                                       'Elm Heron', 'Fir Robin', NULL, NULL, '   ');
  SELECT * INTO r FROM tournament_pairs WHERE id = v;
  IF r.team_category IS NOT NULL THEN
    RAISE EXCEPTION 'A3: a blank category stored %', r.team_category;
  END IF;
END $$;

-- ------------------------------------------------------------
-- B. Refusals, each taking the new pair with it
-- ------------------------------------------------------------
CREATE FUNCTION pg_temp.refuses(p_label text, p_event uuid, p_a text, p_b text, p_cat text, p_code text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  ok boolean := false;
BEGIN
  BEGIN
    PERFORM add_external_tournament_pair_v2(p_event, p_a, p_b, NULL, NULL, p_cat);
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_code THEN ok := true;
    ELSE RAISE EXCEPTION '%: wrong error % (%)', p_label, SQLSTATE, SQLERRM;
    END IF;
  END;
  IF NOT ok THEN RAISE EXCEPTION '%: was accepted', p_label; END IF;
END $$;

DO $$
BEGIN
  PERFORM pg_temp.refuses('B1 unknown key', 'cccccccc-0274-4000-8000-0000000000e1', 'Gum Swift', 'Hazel Owl', 'mixed', '23514');
  PERFORM pg_temp.refuses('B2 not staged', 'cccccccc-0274-4000-8000-0000000000e3', 'Gum Swift', 'Hazel Owl', 'mens', '23514');
  PERFORM pg_temp.refuses('B3 00269 refusal still applies', 'cccccccc-0274-4000-8000-0000000000e1', 'Gum Swift', 'gum swift', 'mens', '23514');
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tournament_pairs WHERE external1_name = 'Gum Swift') THEN
    RAISE EXCEPTION 'B: a refused category left its pair behind';
  END IF;
END $$;

-- ------------------------------------------------------------
-- C. A config with no categories list takes the default keys
-- ------------------------------------------------------------
DO $$
DECLARE
  v uuid;
BEGIN
  v := add_external_tournament_pair_v2('cccccccc-0274-4000-8000-0000000000e2',
                                       'Ivy Jay', 'Kelp Loon', NULL, NULL, 'mixed');
  IF (SELECT team_category FROM tournament_pairs WHERE id = v) IS DISTINCT FROM 'mixed' THEN
    RAISE EXCEPTION 'C1: default category mixed not stored';
  END IF;
  PERFORM pg_temp.refuses('C2 not a default key', 'cccccccc-0274-4000-8000-0000000000e2', 'Larch Merlin', 'Maple Nuthatch', 'open', '23514');
END $$;

-- ------------------------------------------------------------
-- D. The 00269 function still works on its own
-- ------------------------------------------------------------
DO $$
DECLARE
  v uuid;
BEGIN
  v := add_external_tournament_pair('cccccccc-0274-4000-8000-0000000000e3', 'Oak Petrel', 'Pine Quail', NULL);
  IF v IS NULL OR (SELECT team_category FROM tournament_pairs WHERE id = v) IS NOT NULL THEN
    RAISE EXCEPTION 'D1: the 00269 function did not write its pair';
  END IF;
END $$;

-- ------------------------------------------------------------
-- E. Grants
-- ------------------------------------------------------------
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.add_external_tournament_pair_v2(uuid,text,text,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.add_external_tournament_pair_v2(uuid,text,text,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'E: add_external_tournament_pair_v2 is callable by members';
  END IF;
  RAISE NOTICE '00274 external pair category: all cases passed';
END $$;

ROLLBACK;
