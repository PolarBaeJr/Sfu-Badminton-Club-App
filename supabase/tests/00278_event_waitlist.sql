-- ============================================================
-- 00278_event_waitlist.sql: the per-event waitlist.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00278 applied:
--
--   docker exec -i supabase_db_cli psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/00278_event_waitlist.sql
--
-- WHAT IT PROVES
-- --------------
-- A. Singles, capacity 2, automatic: a third member joins the waitlist, a
--    fourth cannot enter past them once a place frees (waitlist_queue), and
--    the fill enters the third with a notification. Joining an event with
--    room and nobody waiting is refused (event_has_room).
-- B. Manual mode: joining is allowed with room; the desk promotes a named
--    row; a named promote into a full event is refused and writes nothing.
-- C. Doubles: with one pair and an odd number of loose entrants, one more
--    solo entrant takes no extra slot and is admitted.
-- D. The switch: off with somebody waiting is refused; an external event
--    cannot have a waitlist.
-- E. A member at the entry cap is skipped, not promoted, and told so.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name) VALUES
 ('dddddddd-0278-4000-8000-000000000001','waitlist-harness-1@example.invalid','MemberA'),
 ('dddddddd-0278-4000-8000-000000000002','waitlist-harness-2@example.invalid','MemberB'),
 ('dddddddd-0278-4000-8000-000000000003','waitlist-harness-3@example.invalid','MemberC'),
 ('dddddddd-0278-4000-8000-000000000004','waitlist-harness-4@example.invalid','MemberD'),
 ('dddddddd-0278-4000-8000-000000000005','waitlist-harness-5@example.invalid','MemberE'),
 ('dddddddd-0278-4000-8000-000000000006','waitlist-harness-6@example.invalid','MemberF'),
 ('dddddddd-0278-4000-8000-000000000009','waitlist-harness-exec@example.invalid','MemberExec');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'dddddddd-0278-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date) VALUES
 ('dddddddd-0278-4000-8000-0000000000a1', 'Team Kestrel Open', CURRENT_DATE);

INSERT INTO tournament_events (id, tournament_id, event_type, format, status, max_participants) VALUES
 ('dddddddd-0278-4000-8000-0000000000e1', 'dddddddd-0278-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'registration', 2),
 ('dddddddd-0278-4000-8000-0000000000e2', 'dddddddd-0278-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'registration', 1),
 ('dddddddd-0278-4000-8000-0000000000e3', 'dddddddd-0278-4000-8000-0000000000a1', 'open_doubles', 'single_elimination', 'registration', 2);

-- ------------------------------------------------------------
-- A. Singles, capacity 2, automatic
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
  e1 uuid := 'dddddddd-0278-4000-8000-0000000000e1';
  t  uuid := 'dddddddd-0278-4000-8000-0000000000a1';
BEGIN
  v_res := set_event_waitlist(e1, true, true, 'dddddddd-0278-4000-8000-000000000009');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A0: switching the waitlist on returned %', v_res; END IF;

  -- Room and nobody waiting: enter instead.
  v_res := join_event_waitlist(e1, 'dddddddd-0278-4000-8000-000000000003', false);
  IF v_res->>'reason' IS DISTINCT FROM 'event_has_room' THEN
    RAISE EXCEPTION 'A1: joining an event with room returned %', v_res;
  END IF;

  PERFORM enter_tournament_event(e1, 'dddddddd-0278-4000-8000-000000000001', 1000, false);
  PERFORM enter_tournament_event(e1, 'dddddddd-0278-4000-8000-000000000002', 1000, false);

  v_res := enter_tournament_event(e1, 'dddddddd-0278-4000-8000-000000000003', 1000, false);
  IF v_res->>'reason' IS DISTINCT FROM 'event_full' OR (v_res->>'waitlist')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'A2: a full event with a waitlist returned %', v_res;
  END IF;

  v_res := join_event_waitlist(e1, 'dddddddd-0278-4000-8000-000000000003', false);
  IF NOT (v_res->>'ok')::boolean OR (v_res->>'position')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'A3: joining a full event returned %', v_res;
  END IF;

  v_res := join_event_waitlist(e1, 'dddddddd-0278-4000-8000-000000000003', false);
  IF v_res->>'reason' IS DISTINCT FROM 'already_waiting' THEN
    RAISE EXCEPTION 'A4: joining twice returned %', v_res;
  END IF;

  -- A place frees, through the untouched withdraw function.
  v_res := withdraw_from_tournament_event(e1, 'dddddddd-0278-4000-8000-000000000001');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A5: withdraw returned %', v_res; END IF;

  -- Somebody else cannot take it past the queue.
  v_res := enter_tournament_event(e1, 'dddddddd-0278-4000-8000-000000000004', 1000, false);
  IF v_res->>'reason' IS DISTINCT FROM 'waitlist_queue' THEN
    RAISE EXCEPTION 'A6: entering past a waiting member returned %', v_res;
  END IF;

  v_res := fill_event_from_waitlist(e1, NULL, NULL);
  IF NOT (v_res->>'ok')::boolean OR jsonb_array_length(v_res->'promoted') <> 1
     OR v_res->'promoted'->0->>'player_id' <> 'dddddddd-0278-4000-8000-000000000003' THEN
    RAISE EXCEPTION 'A7: the fill returned %', v_res;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM tournament_participants
     WHERE event_id = e1 AND player_id = 'dddddddd-0278-4000-8000-000000000003'
       AND status = 'registered' AND elo_before = 1000
       AND id = (v_res->'promoted'->0->>'participant_id')::uuid
  ) THEN
    RAISE EXCEPTION 'A8: the promoted member has no participant row';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tournament_event_waitlist
     WHERE event_id = e1 AND player_id = 'dddddddd-0278-4000-8000-000000000003'
       AND status = 'promoted' AND promoted_participant_id IS NOT NULL AND resolved_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A9: the waitlist row was not marked promoted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM notifications
     WHERE player_id = 'dddddddd-0278-4000-8000-000000000003'
       AND type = 'general' AND title = 'You are in'
       AND metadata->>'kind' = 'waitlist_promoted' AND metadata->>'event_id' = e1::text
       AND metadata->>'tournament_id' = t::text
       AND body LIKE '%Open Singles%Team Kestrel Open%'
  ) THEN
    RAISE EXCEPTION 'A10: no promotion notification';
  END IF;

  -- Full again, and the fill is a quiet no-op.
  v_res := fill_event_from_waitlist(e1, NULL, NULL);
  IF NOT (v_res->>'ok')::boolean OR jsonb_array_length(v_res->'promoted') <> 0 THEN
    RAISE EXCEPTION 'A11: a fill with nobody waiting returned %', v_res;
  END IF;

  -- Leaving: the member's own.
  v_res := join_event_waitlist(e1, 'dddddddd-0278-4000-8000-000000000004', false);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A12: join returned %', v_res; END IF;
  v_res := leave_event_waitlist(e1, 'dddddddd-0278-4000-8000-000000000004');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'A13: leave returned %', v_res; END IF;
  v_res := leave_event_waitlist(e1, 'dddddddd-0278-4000-8000-000000000004');
  IF v_res->>'reason' IS DISTINCT FROM 'not_waiting' THEN RAISE EXCEPTION 'A14: leaving twice returned %', v_res; END IF;

  RAISE NOTICE 'A passed: join, queue, fill, notification, leave';
END;
$$;

-- ------------------------------------------------------------
-- B. Manual mode and the named promote
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
  v_w   uuid;
  e2 uuid := 'dddddddd-0278-4000-8000-0000000000e2';
BEGIN
  v_res := set_event_waitlist(e2, true, false, 'dddddddd-0278-4000-8000-000000000009');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'B0: %', v_res; END IF;

  -- Manual mode takes a join even with room.
  v_res := join_event_waitlist(e2, 'dddddddd-0278-4000-8000-000000000005', false);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'B1: a manual-mode join with room returned %', v_res; END IF;
  v_w := (v_res->>'waitlist_id')::uuid;
  -- now() is fixed inside one transaction; in real use each join is its own.
  UPDATE tournament_event_waitlist SET joined_at = now() - interval '1 minute' WHERE id = v_w;

  -- The member is still waiting: a manual join promotes nobody.
  IF jsonb_array_length(v_res->'promoted') <> 0 THEN RAISE EXCEPTION 'B2: manual join promoted %', v_res; END IF;

  -- A second member joins; the desk fills the one place by name, out of order.
  v_res := join_event_waitlist(e2, 'dddddddd-0278-4000-8000-000000000006', false);
  IF (v_res->>'position')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'B3: position %', v_res; END IF;

  v_res := fill_event_from_waitlist(e2, 'dddddddd-0278-4000-8000-000000000009', (v_res->>'waitlist_id')::uuid);
  IF NOT (v_res->>'ok')::boolean OR v_res->'promoted'->0->>'player_id' <> 'dddddddd-0278-4000-8000-000000000006' THEN
    RAISE EXCEPTION 'B4: the named promote returned %', v_res;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tournament_participants
     WHERE event_id = e2 AND player_id = 'dddddddd-0278-4000-8000-000000000006'
       AND added_by = 'dddddddd-0278-4000-8000-000000000009'
  ) THEN
    RAISE EXCEPTION 'B5: the promoted row does not name the desk';
  END IF;

  -- Now full: the named promote is refused and the row stays waiting.
  v_res := fill_event_from_waitlist(e2, 'dddddddd-0278-4000-8000-000000000009', v_w);
  IF v_res->>'reason' IS DISTINCT FROM 'event_full' THEN RAISE EXCEPTION 'B6: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM tournament_event_waitlist WHERE id = v_w AND status = 'waiting') THEN
    RAISE EXCEPTION 'B7: a refused promote moved the row';
  END IF;

  -- The desk removes them; a second removal is not_waiting.
  v_res := remove_from_event_waitlist(v_w, 'dddddddd-0278-4000-8000-000000000009');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'B8: %', v_res; END IF;
  v_res := remove_from_event_waitlist(v_w, 'dddddddd-0278-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'not_waiting' THEN RAISE EXCEPTION 'B9: %', v_res; END IF;

  RAISE NOTICE 'B passed: manual join, named promote, full refusal, removal';
END;
$$;

-- ------------------------------------------------------------
-- C. Doubles: an odd loose count admits one more solo
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
  e3 uuid := 'dddddddd-0278-4000-8000-0000000000e3';
  v_loose uuid;
BEGIN
  -- One pair and two loose entrants: 1 + CEIL(2/2) = 2 slots, full.
  INSERT INTO tournament_pairs (event_id, player1_id, player2_id, status)
  VALUES (e3, 'dddddddd-0278-4000-8000-000000000001', 'dddddddd-0278-4000-8000-000000000002', 'registered');
  INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
    (e3, 'dddddddd-0278-4000-8000-000000000003', 1000, 'registered'),
    (e3, 'dddddddd-0278-4000-8000-000000000004', 1000, 'registered');

  v_res := set_event_waitlist(e3, true, true, 'dddddddd-0278-4000-8000-000000000009');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'C0: %', v_res; END IF;

  v_res := join_event_waitlist(e3, 'dddddddd-0278-4000-8000-000000000005', true);
  IF NOT (v_res->>'ok')::boolean OR (v_res->>'position')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'C1: joining a full doubles event returned %', v_res;
  END IF;

  -- One loose entrant withdraws: 1 + CEIL(1/2) = 2 slots, and one more solo
  -- makes 1 + CEIL(2/2) = 2, so the place is real.
  SELECT id INTO v_loose FROM tournament_participants
   WHERE event_id = e3 AND player_id = 'dddddddd-0278-4000-8000-000000000004';
  v_res := set_field_entry_status(v_loose, false, 'withdrawn', 'dddddddd-0278-4000-8000-000000000009');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'C2: %', v_res; END IF;

  v_res := fill_event_from_waitlist(e3, NULL, NULL);
  IF jsonb_array_length(v_res->'promoted') <> 1 THEN RAISE EXCEPTION 'C3: the doubles fill returned %', v_res; END IF;

  -- Now 1 pair + 2 loose = 2 slots: a further solo would make 3.
  v_res := join_event_waitlist(e3, 'dddddddd-0278-4000-8000-000000000006', true);
  IF NOT (v_res->>'ok')::boolean OR jsonb_array_length(v_res->'promoted') <> 0 THEN
    RAISE EXCEPTION 'C4: the next solo was not queued: %', v_res;
  END IF;

  RAISE NOTICE 'C passed: doubles slot arithmetic';
END;
$$;

-- ------------------------------------------------------------
-- D. The switch
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
BEGIN
  -- e3 has MemberF waiting.
  v_res := set_event_waitlist('dddddddd-0278-4000-8000-0000000000e3', false, true, 'dddddddd-0278-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'waitlist_not_empty' THEN RAISE EXCEPTION 'D1: %', v_res; END IF;

  INSERT INTO tournament_events (id, tournament_id, event_type, format, status, external_event, placement_bonus_enabled, rated)
  VALUES ('dddddddd-0278-4000-8000-0000000000e4', 'dddddddd-0278-4000-8000-0000000000a1', 'open_doubles', 'round_robin', 'registration', true, false, false);
  v_res := set_event_waitlist('dddddddd-0278-4000-8000-0000000000e4', true, true, 'dddddddd-0278-4000-8000-000000000009');
  IF v_res->>'reason' IS DISTINCT FROM 'external_event' THEN RAISE EXCEPTION 'D2: %', v_res; END IF;

  -- Off on an event nobody waits for is fine.
  v_res := set_event_waitlist('dddddddd-0278-4000-8000-0000000000e2', false, true, 'dddddddd-0278-4000-8000-000000000009');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'D3: %', v_res; END IF;

  RAISE NOTICE 'D passed: the switch refuses what it should';
END;
$$;

-- ------------------------------------------------------------
-- E. The entry cap at promotion time
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
  e1 uuid := 'dddddddd-0278-4000-8000-0000000000e1';
BEGIN
  -- MemberE waits for e1 (full), then is entered in e3 by the fill above and
  -- the tournament's cap drops to one.
  v_res := join_event_waitlist(e1, 'dddddddd-0278-4000-8000-000000000005', false);
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'E0: %', v_res; END IF;
  UPDATE tournaments SET max_events_per_player = 1 WHERE id = 'dddddddd-0278-4000-8000-0000000000a1';

  v_res := withdraw_from_tournament_event(e1, 'dddddddd-0278-4000-8000-000000000002');
  IF NOT (v_res->>'ok')::boolean THEN RAISE EXCEPTION 'E1: %', v_res; END IF;

  v_res := fill_event_from_waitlist(e1, NULL, NULL);
  IF jsonb_array_length(v_res->'promoted') <> 0 OR v_res->'skipped'->0->>'reason' IS DISTINCT FROM 'entry_cap' THEN
    RAISE EXCEPTION 'E2: a capped member was not skipped: %', v_res;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tournament_event_waitlist
     WHERE event_id = e1 AND player_id = 'dddddddd-0278-4000-8000-000000000005'
       AND status = 'skipped' AND reason = 'entry_cap'
  ) OR NOT EXISTS (
    SELECT 1 FROM notifications
     WHERE player_id = 'dddddddd-0278-4000-8000-000000000005' AND metadata->>'kind' = 'waitlist_skipped'
  ) THEN
    RAISE EXCEPTION 'E3: the skip was not recorded or not told';
  END IF;

  RAISE NOTICE 'E passed: the cap is re-counted at promotion';
END;
$$;

ROLLBACK;
