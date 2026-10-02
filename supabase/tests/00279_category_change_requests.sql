-- ============================================================
-- 00279_category_change_requests.sql: a category change after play is a
-- request, and approve_pair_category_request settles one.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00279 applied:
--
--   docker exec -i supabase_db_cli psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/00279_category_change_requests.sql
--
-- WHAT IT PROVES
-- --------------
-- A. Approve: the team's category changes, the request is approved with the
--    actor and a time, and the answer names the team, the event and both
--    categories.
-- B. Double approve: a second approve of the same request is not_pending
--    and writes nothing.
-- C. Stale: the team's category moved after the request was made, so the
--    approve is stale_category and writes nothing.
-- D. Unknown: the category asked for is no longer one of the event's, so the
--    approve is unknown_category and writes nothing.
-- E. One pending request per team: a second pending row is a unique
--    violation, and a settled one does not count.
-- F. A finalised event is event_completed; a missing request is not_found.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name) VALUES
 ('eeeeeeee-0279-4000-8000-000000000009','category-harness-exec@example.invalid','MemberExec');

INSERT INTO tournaments (id, name, start_date) VALUES
 ('eeeeeeee-0279-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE);

INSERT INTO tournament_events
  (id, tournament_id, event_type, format, placement_bonus_enabled, external_event, format_config)
VALUES
  ('eeeeeeee-0279-4000-8000-0000000000e1', 'eeeeeeee-0279-4000-8000-0000000000a1',
   'mixed_doubles', 'staged', false, true,
   '{"version":1,"categories":[{"key":"mens","label":"Men''s"},{"key":"womens","label":"Women''s"},{"key":"mixed","label":"Mixed"}],"stages":[{"key":"groups"}]}');

CREATE TEMP TABLE harness (k text PRIMARY KEY, v uuid);

DO $$
DECLARE
  e1 uuid := 'eeeeeeee-0279-4000-8000-0000000000e1';
BEGIN
  INSERT INTO pg_temp.harness VALUES
    ('a', add_external_tournament_pair_v2(e1, 'Alder Finch', 'Birch Wren', NULL, 'Team Kestrel', 'mens')),
    ('b', add_external_tournament_pair_v2(e1, 'Cedar Lark', 'Dogwood Teal', NULL, 'Team Osprey', 'mens')),
    ('c', add_external_tournament_pair_v2(e1, 'Elm Heron', 'Fir Robin', NULL, 'Team Harrier', 'mixed')),
    ('d', add_external_tournament_pair_v2(e1, 'Gum Swift', 'Hazel Owl', NULL, 'Team Merlin', 'womens'));
END $$;

-- ------------------------------------------------------------
-- A. Approve, and B. approve again
-- ------------------------------------------------------------
DO $$
DECLARE
  e1    uuid := 'eeeeeeee-0279-4000-8000-0000000000e1';
  exec_ uuid := 'eeeeeeee-0279-4000-8000-000000000009';
  pa    uuid := (SELECT v FROM pg_temp.harness WHERE k = 'a');
  req   uuid;
  v_res jsonb;
  r     record;
BEGIN
  INSERT INTO tournament_category_requests (event_id, pair_id, from_category, to_category, reason, requested_by)
  VALUES (e1, pa, 'mens', 'womens', 'Entered under the wrong category', exec_)
  RETURNING id INTO req;

  v_res := approve_pair_category_request(req, exec_);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A1: approve returned %', v_res; END IF;
  IF v_res->>'pair_id' <> pa::text OR v_res->>'event_id' <> e1::text
     OR v_res->>'tournament_id' <> 'eeeeeeee-0279-4000-8000-0000000000a1'
     OR v_res->>'from' <> 'mens' OR v_res->>'to' <> 'womens'
     OR v_res->>'requested_by' <> exec_::text THEN
    RAISE EXCEPTION 'A2: the answer is wrong: %', v_res;
  END IF;
  IF (SELECT team_category FROM tournament_pairs WHERE id = pa) IS DISTINCT FROM 'womens' THEN
    RAISE EXCEPTION 'A3: the category did not change';
  END IF;
  SELECT * INTO r FROM tournament_category_requests WHERE id = req;
  IF r.status <> 'approved' OR r.resolved_by IS DISTINCT FROM exec_ OR r.resolved_at IS NULL THEN
    RAISE EXCEPTION 'A4: the request is %/%/%', r.status, r.resolved_by, r.resolved_at;
  END IF;

  v_res := approve_pair_category_request(req, exec_);
  IF (v_res->>'ok')::boolean OR v_res->>'reason' <> 'not_pending' OR v_res->>'status' <> 'approved' THEN
    RAISE EXCEPTION 'B1: a second approve returned %', v_res;
  END IF;
  IF (SELECT team_category FROM tournament_pairs WHERE id = pa) IS DISTINCT FROM 'womens' THEN
    RAISE EXCEPTION 'B2: the second approve moved the category';
  END IF;
END $$;

-- ------------------------------------------------------------
-- C. Stale category
-- ------------------------------------------------------------
DO $$
DECLARE
  e1    uuid := 'eeeeeeee-0279-4000-8000-0000000000e1';
  exec_ uuid := 'eeeeeeee-0279-4000-8000-000000000009';
  pb    uuid := (SELECT v FROM pg_temp.harness WHERE k = 'b');
  req   uuid;
  v_res jsonb;
BEGIN
  INSERT INTO tournament_category_requests (event_id, pair_id, from_category, to_category, reason, requested_by)
  VALUES (e1, pb, 'mens', 'mixed', 'One of them is a woman', exec_)
  RETURNING id INTO req;
  UPDATE tournament_pairs SET team_category = 'womens' WHERE id = pb;

  v_res := approve_pair_category_request(req, exec_);
  IF (v_res->>'ok')::boolean OR v_res->>'reason' <> 'stale_category' THEN
    RAISE EXCEPTION 'C1: a stale approve returned %', v_res;
  END IF;
  IF (SELECT team_category FROM tournament_pairs WHERE id = pb) IS DISTINCT FROM 'womens' THEN
    RAISE EXCEPTION 'C2: the stale approve moved the category';
  END IF;
  IF (SELECT status FROM tournament_category_requests WHERE id = req) <> 'pending' THEN
    RAISE EXCEPTION 'C3: the stale approve settled the request';
  END IF;
END $$;

-- ------------------------------------------------------------
-- D. Unknown category
-- ------------------------------------------------------------
DO $$
DECLARE
  e1    uuid := 'eeeeeeee-0279-4000-8000-0000000000e1';
  exec_ uuid := 'eeeeeeee-0279-4000-8000-000000000009';
  pc    uuid := (SELECT v FROM pg_temp.harness WHERE k = 'c');
  req   uuid;
  v_res jsonb;
BEGIN
  INSERT INTO tournament_category_requests (event_id, pair_id, from_category, to_category, reason, requested_by)
  VALUES (e1, pc, 'mixed', 'open', 'Moved to the open category', exec_)
  RETURNING id INTO req;

  v_res := approve_pair_category_request(req, exec_);
  IF (v_res->>'ok')::boolean OR v_res->>'reason' <> 'unknown_category' THEN
    RAISE EXCEPTION 'D1: an unknown category returned %', v_res;
  END IF;
  IF (SELECT team_category FROM tournament_pairs WHERE id = pc) IS DISTINCT FROM 'mixed' THEN
    RAISE EXCEPTION 'D2: the unknown category was written';
  END IF;
  IF (SELECT status FROM tournament_category_requests WHERE id = req) <> 'pending' THEN
    RAISE EXCEPTION 'D3: the unknown category settled the request';
  END IF;

  -- Unset is always a category the event can take.
  UPDATE tournament_category_requests SET status = 'cancelled', resolved_at = now() WHERE id = req;
  INSERT INTO tournament_category_requests (event_id, pair_id, from_category, to_category, reason, requested_by)
  VALUES (e1, pc, 'mixed', NULL, 'Not known yet', exec_)
  RETURNING id INTO req;
  v_res := approve_pair_category_request(req, exec_);
  IF NOT (v_res->>'ok')::boolean OR (SELECT team_category FROM tournament_pairs WHERE id = pc) IS NOT NULL THEN
    RAISE EXCEPTION 'D4: approving Unset returned %', v_res;
  END IF;
END $$;

-- ------------------------------------------------------------
-- E. One pending request per team
-- ------------------------------------------------------------
DO $$
DECLARE
  e1    uuid := 'eeeeeeee-0279-4000-8000-0000000000e1';
  exec_ uuid := 'eeeeeeee-0279-4000-8000-000000000009';
  pd    uuid := (SELECT v FROM pg_temp.harness WHERE k = 'd');
  refused boolean := false;
BEGIN
  INSERT INTO tournament_category_requests (event_id, pair_id, from_category, to_category, reason, requested_by)
  VALUES (e1, pd, 'womens', 'mixed', 'First ask', exec_);
  BEGIN
    INSERT INTO tournament_category_requests (event_id, pair_id, from_category, to_category, reason, requested_by)
    VALUES (e1, pd, 'womens', 'mens', 'Second ask', exec_);
  EXCEPTION WHEN unique_violation THEN
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'E1: a second pending request was accepted'; END IF;

  UPDATE tournament_category_requests SET status = 'declined', resolved_by = exec_, resolved_at = now()
   WHERE pair_id = pd AND status = 'pending';
  INSERT INTO tournament_category_requests (event_id, pair_id, from_category, to_category, reason, requested_by)
  VALUES (e1, pd, 'womens', 'mens', 'Asked again after the decline', exec_);
  IF (SELECT count(*) FROM tournament_category_requests WHERE pair_id = pd) <> 2 THEN
    RAISE EXCEPTION 'E2: a declined request blocked a new one';
  END IF;
END $$;

-- ------------------------------------------------------------
-- F. A finalised event, and a request that does not exist
-- ------------------------------------------------------------
DO $$
DECLARE
  e1    uuid := 'eeeeeeee-0279-4000-8000-0000000000e1';
  exec_ uuid := 'eeeeeeee-0279-4000-8000-000000000009';
  pd    uuid := (SELECT v FROM pg_temp.harness WHERE k = 'd');
  req   uuid := (SELECT id FROM tournament_category_requests WHERE pair_id = pd AND status = 'pending');
  v_res jsonb;
BEGIN
  UPDATE tournament_events SET status = 'completed' WHERE id = e1;
  v_res := approve_pair_category_request(req, exec_);
  IF (v_res->>'ok')::boolean OR v_res->>'reason' <> 'event_completed' THEN
    RAISE EXCEPTION 'F1: a finalised event returned %', v_res;
  END IF;
  IF (SELECT team_category FROM tournament_pairs WHERE id = pd) IS DISTINCT FROM 'womens' THEN
    RAISE EXCEPTION 'F2: a finalised event had its category moved';
  END IF;

  v_res := approve_pair_category_request(gen_random_uuid(), exec_);
  IF (v_res->>'ok')::boolean OR v_res->>'reason' <> 'not_found' THEN
    RAISE EXCEPTION 'F3: a missing request returned %', v_res;
  END IF;

  RAISE NOTICE '00279 harness: approve, double approve, stale, unknown, one pending, finalised and missing all behave.';
END $$;

ROLLBACK;
