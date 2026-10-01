-- ============================================================
-- 00276_registration_and_checkin_windows.sql: registration and check-in
-- windows.
--
-- NOT a migration. Every statement runs inside one transaction that
-- ends in ROLLBACK, so it leaves nothing behind and is safe to point at
-- a database that has 00276 applied:
--
--   docker exec -i supabase_db_cli psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/tests/00276_registration_and_checkin_windows.sql
--
-- WHAT IT PROVES
-- --------------
-- A. A member's own entry is refused before the registration window opens and
--    after it closes, and allowed inside it.
-- B. The exec's add path ignores the window.
-- C. The tournament's window applies when the event sets none, and the event's
--    own bound overrides the tournament's.
-- D. A member's own check-in (null actor) is refused outside the check-in
--    window; an exec's check-in (non-null actor) is not; somebody already
--    checked in still gets `already` from a repeat scan.
-- E. The per-row CHECKs refuse a window that closes before it opens.
--
-- now() is fixed inside one transaction, so every window here is set relative
-- to it and moved with an UPDATE between calls.
-- ============================================================

BEGIN;
SET LOCAL client_min_messages = notice;

INSERT INTO players (id, email, first_name) VALUES
 ('cccccccc-0276-4000-8000-000000000001','window-harness-1@example.invalid','WindowOne'),
 ('cccccccc-0276-4000-8000-000000000002','window-harness-2@example.invalid','WindowTwo'),
 ('cccccccc-0276-4000-8000-000000000003','window-harness-3@example.invalid','WindowThree'),
 ('cccccccc-0276-4000-8000-000000000009','window-harness-exec@example.invalid','WindowExec');
INSERT INTO ratings (player_id, singles_elo, doubles_elo)
SELECT id, 1000, 1000 FROM players WHERE id::text LIKE 'cccccccc-0276-4000-8000-%'
ON CONFLICT (player_id) DO NOTHING;

INSERT INTO tournaments (id, name, start_date) VALUES
 ('cccccccc-0276-4000-8000-0000000000a1', 'window harness', CURRENT_DATE);

INSERT INTO tournament_events (id, tournament_id, event_type, format, status) VALUES
 ('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-0000000000a1', 'open_singles', 'single_elimination', 'registration'),
 ('cccccccc-0276-4000-8000-0000000000e2', 'cccccccc-0276-4000-8000-0000000000a1', 'open_singles', 'round_robin', 'checkin');

-- ------------------------------------------------------------
-- A. Self-entry against the event's own window
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
BEGIN
  UPDATE tournament_events SET registration_opens_at = now() + interval '1 hour'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e1';
  v_res := enter_tournament_event('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-000000000001', 1000, false);
  IF v_res->>'reason' IS DISTINCT FROM 'registration_not_open' OR v_res->>'opens_at' IS NULL THEN
    RAISE EXCEPTION 'A1: entry before the window opened returned %', v_res;
  END IF;

  UPDATE tournament_events
     SET registration_opens_at = now() - interval '2 hours',
         registration_closes_at = now() - interval '1 hour'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e1';
  v_res := enter_tournament_event('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-000000000001', 1000, false);
  IF v_res->>'reason' IS DISTINCT FROM 'registration_window_closed' OR v_res->>'closes_at' IS NULL THEN
    RAISE EXCEPTION 'A2: entry after the window closed returned %', v_res;
  END IF;

  -- The close bound is inclusive: closing exactly now is closed.
  UPDATE tournament_events SET registration_closes_at = now()
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e1';
  v_res := enter_tournament_event('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-000000000001', 1000, false);
  IF v_res->>'reason' IS DISTINCT FROM 'registration_window_closed' THEN
    RAISE EXCEPTION 'A3: entry at the closing instant returned %', v_res;
  END IF;

  UPDATE tournament_events SET registration_closes_at = now() + interval '1 hour'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e1';
  v_res := enter_tournament_event('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-000000000001', 1000, false);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'A4: entry inside the window returned %', v_res;
  END IF;
  RAISE NOTICE 'A ok: refused before, refused after, admitted inside';
END $$;

-- ------------------------------------------------------------
-- B. The exec's add path ignores the window
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
BEGIN
  UPDATE tournament_events
     SET registration_opens_at = now() + interval '1 hour', registration_closes_at = now() + interval '2 hours'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e1';
  v_res := add_participants_under_field_lock('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-000000000009',
    '[{"player_id":"cccccccc-0276-4000-8000-000000000002","elo_before":1000}]'::jsonb);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'B1: an exec add outside the window returned %', v_res;
  END IF;
  RAISE NOTICE 'B ok: an exec adds outside the window';
END $$;

-- ------------------------------------------------------------
-- C. Tournament fallback, and the event overriding it
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
BEGIN
  UPDATE tournament_events SET registration_opens_at = NULL, registration_closes_at = NULL
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e1';
  UPDATE tournaments SET registration_closes_at = now() - interval '1 minute'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000a1';
  v_res := enter_tournament_event('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-000000000003', 1000, false);
  IF v_res->>'reason' IS DISTINCT FROM 'registration_window_closed' THEN
    RAISE EXCEPTION 'C1: the tournament close did not apply: %', v_res;
  END IF;

  -- The event extends its own close; the tournament's stays in place for the rest.
  UPDATE tournament_events SET registration_closes_at = now() + interval '1 hour'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e1';
  v_res := enter_tournament_event('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-000000000003', 1000, false);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'C2: the event close did not override the tournament: %', v_res;
  END IF;

  -- One bound from each row: the tournament's open, the event's close.
  UPDATE tournaments SET registration_closes_at = NULL, registration_opens_at = now() + interval '30 minutes'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000a1';
  v_res := enter_tournament_event('cccccccc-0276-4000-8000-0000000000e1', 'cccccccc-0276-4000-8000-000000000009', 1000, false);
  IF v_res->>'reason' IS DISTINCT FROM 'registration_not_open' THEN
    RAISE EXCEPTION 'C3: the tournament open did not apply under an event close: %', v_res;
  END IF;
  UPDATE tournaments SET registration_opens_at = NULL WHERE id = 'cccccccc-0276-4000-8000-0000000000a1';
  RAISE NOTICE 'C ok: tournament fallback, event override, mixed bounds';
END $$;

-- ------------------------------------------------------------
-- D. Check-in
-- ------------------------------------------------------------
DO $$
DECLARE
  v_res  jsonb;
  v_p1   uuid;
  v_p2   uuid;
BEGIN
  INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
    ('cccccccc-0276-4000-8000-0000000000e2', 'cccccccc-0276-4000-8000-000000000001', 1000, 'registered')
    RETURNING id INTO v_p1;
  INSERT INTO tournament_participants (event_id, player_id, elo_before, status) VALUES
    ('cccccccc-0276-4000-8000-0000000000e2', 'cccccccc-0276-4000-8000-000000000002', 1000, 'registered')
    RETURNING id INTO v_p2;

  -- Tournament-level check-in window not yet open.
  UPDATE tournaments SET checkin_opens_at = now() + interval '1 hour'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000a1';
  v_res := set_field_entry_status(v_p1, false, 'checked_in', NULL);
  IF v_res->>'reason' IS DISTINCT FROM 'checkin_not_open' OR v_res->>'event_status' IS DISTINCT FROM 'checkin' THEN
    RAISE EXCEPTION 'D1: self check-in before the window returned %', v_res;
  END IF;

  -- An exec checks somebody in regardless.
  v_res := set_field_entry_status(v_p2, false, 'checked_in', 'cccccccc-0276-4000-8000-000000000009');
  IF (v_res->>'ok')::boolean IS NOT TRUE OR (v_res->>'already')::boolean THEN
    RAISE EXCEPTION 'D2: an exec check-in outside the window returned %', v_res;
  END IF;

  -- Somebody already checked in scanning again still hears `already`.
  v_res := set_field_entry_status(v_p2, false, 'checked_in', NULL);
  IF (v_res->>'ok')::boolean IS NOT TRUE OR NOT (v_res->>'already')::boolean THEN
    RAISE EXCEPTION 'D3: a repeat scan by a checked-in entrant returned %', v_res;
  END IF;

  -- The event's own close overrides; past it, a self check-in is refused.
  UPDATE tournaments SET checkin_opens_at = NULL WHERE id = 'cccccccc-0276-4000-8000-0000000000a1';
  UPDATE tournament_events SET checkin_closes_at = now() - interval '1 minute'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e2';
  v_res := set_field_entry_status(v_p1, false, 'checked_in', NULL);
  IF v_res->>'reason' IS DISTINCT FROM 'checkin_window_closed' OR v_res->>'closes_at' IS NULL THEN
    RAISE EXCEPTION 'D4: self check-in after the window returned %', v_res;
  END IF;

  -- Inside the window it lands.
  UPDATE tournament_events SET checkin_opens_at = now() - interval '1 hour', checkin_closes_at = now() + interval '1 hour'
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e2';
  v_res := set_field_entry_status(v_p1, false, 'checked_in', NULL);
  IF (v_res->>'ok')::boolean IS NOT TRUE OR (v_res->>'already')::boolean THEN
    RAISE EXCEPTION 'D5: self check-in inside the window returned %', v_res;
  END IF;

  -- A no-show with a null actor is never gated.
  UPDATE tournament_events SET checkin_opens_at = now() + interval '1 hour', checkin_closes_at = NULL
   WHERE id = 'cccccccc-0276-4000-8000-0000000000e2';
  v_res := set_field_entry_status(v_p1, false, 'no_show', NULL);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'D6: a no-show outside the window returned %', v_res;
  END IF;
  RAISE NOTICE 'D ok: self check-in gated both ways, exec and repeat scan and no-show are not';
END $$;

-- ------------------------------------------------------------
-- E. The per-row CHECKs
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE tournaments SET checkin_opens_at = now(), checkin_closes_at = now()
     WHERE id = 'cccccccc-0276-4000-8000-0000000000a1';
    RAISE EXCEPTION 'E1: a tournament window closing as it opens was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE tournament_events SET registration_opens_at = now(), registration_closes_at = now() - interval '1 minute'
     WHERE id = 'cccccccc-0276-4000-8000-0000000000e1';
    RAISE EXCEPTION 'E2: an event window closing before it opens was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'E ok: both CHECKs refuse an inverted window';
END $$;

ROLLBACK;
