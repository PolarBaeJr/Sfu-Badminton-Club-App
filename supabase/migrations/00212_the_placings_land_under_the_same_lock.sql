-- ===========================================================================
-- 00212 — THE PLACINGS LAND UNDER THE SAME LOCK AS THE FLIP
-- ===========================================================================
--
-- 00209 fenced the completion flip; 00211 made it re-check the winners. Both
-- closed the gap between what finalizeEvent READ and what it flipped. Neither
-- closed the gap between what it read and what it WROTE, because the position
-- and points writes were issued from the application over PostgREST, each its
-- own transaction, before the RPC was called at all:
--
--   A: computes placings from the field  (champion = X)
--     |    B: computes placings from the same field, concurrently
--     |    B: writes X first, 100 points
--   A: writes X first, 100 points        (idempotent so far -- same answer)
--     |    B: flips the event to completed. Field unchanged, X still active,
--     |       so nothing refuses. Correct.
--   A: calls the flip, gets 'event_status: completed', and STOPS.
--
-- That interleaving is benign only while both callers compute the same answer.
-- They do not have to: an entry can be disqualified between A's read and B's,
-- so B's positions are one ladder and A's are another, and the rows end up a
-- MIX of the two -- a champion from one and a runner-up from the other -- with
-- the event completed and nothing anywhere saying so. No later read can undo
-- it, because both halves look individually valid.
--
-- finalize.ts carried a comment saying the lock could not be made to span the
-- read and the write without moving assignPositionsAndPoints into plpgsql:
-- bracket arithmetic, the third-place playoff split, pool standings. THAT IS
-- STILL TRUE OF THE READ AND IS NOT WHAT THIS DOES. The computation stays in
-- TypeScript. Only its RESULT crosses, as data, and the writing of that result
-- is what moves under the lock. A caller still computes unfenced -- it just can
-- no longer half-commit what it computed, and if the field moved underneath it
-- the existing checks refuse before any of it lands.
--
-- ATOMICITY IS THE ENTIRE POINT, so note the two exit styles below. Every
-- refusal REACHABLE BEFORE THE WRITES returns a row, as it always did. Every
-- fault discovered DURING them raises instead: this function's callers reach it
-- through PostgREST, where a normal return commits the transaction -- so a
-- refusal returned after a partial write would persist exactly the mixed state
-- the migration exists to prevent.
--
-- The 4-argument form is dropped for the reason 00211 dropped the 3-argument
-- one: an un-redeployed caller must not be able to complete an event by a route
-- that skips the writes. Nothing on production calls any form -- 00209, 00211
-- and this are all inside the same unreleased range.
-- ===========================================================================

DROP FUNCTION IF EXISTS public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[]);

CREATE OR REPLACE FUNCTION public.complete_event_under_field_lock(
  p_event_id uuid, p_is_pair boolean, p_field uuid[], p_won uuid[],
  p_positions jsonb, p_points jsonb, p_clear uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_status     text;
  v_arrived    integer;
  v_open       integer;
  v_exited     text;
  v_want       integer;
  v_got        integer;
BEGIN
  IF p_event_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_event_id and p_is_pair may not be null';
  END IF;
  -- NULL is a caller that did not read its field; an empty array is a caller
  -- that read an empty field. Only the first is a fault, and it must not be
  -- able to degrade into an unchecked completion. Every other argument is held
  -- to the same rule: a caller with nothing to write passes '{}', never NULL.
  IF p_field IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_field may not be null';
  END IF;
  IF p_won IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_won may not be null';
  END IF;
  IF p_positions IS NULL OR p_points IS NULL OR p_clear IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_positions, p_points and p_clear may not be null';
  END IF;
  IF jsonb_typeof(p_positions) <> 'object' OR jsonb_typeof(p_points) <> 'object' THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_positions and p_points must be json objects of entry id -> number';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.tournament_id
    INTO v_status, v_tournament
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status <> 'live' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  IF p_is_pair THEN
    SELECT count(*) INTO v_arrived FROM tournament_pairs
     WHERE event_id = p_event_id
       AND status::TEXT NOT IN ('withdrawn', 'disqualified')
       AND NOT (id = ANY (p_field));
  ELSE
    SELECT count(*) INTO v_arrived FROM tournament_participants
     WHERE event_id = p_event_id
       AND status::TEXT NOT IN ('withdrawn', 'disqualified')
       AND NOT (id = ANY (p_field));
  END IF;
  IF v_arrived > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'field_changed',
                              'arrived', v_arrived);
  END IF;

  -- THE WINNERS, RE-READ UNDER THE LOCK. Deliberately NOT folded into the query
  -- above: that one counts entries the caller did not know about, this one
  -- re-checks entries it did. Same lock, different question.
  IF array_length(p_won, 1) IS NOT NULL THEN
    IF p_is_pair THEN
      SELECT string_agg(id::TEXT || ' (' || status::TEXT || ')', ', ')
        INTO v_exited FROM tournament_pairs
       WHERE event_id = p_event_id AND id = ANY (p_won)
         AND status::TEXT IN ('withdrawn', 'disqualified');
    ELSE
      SELECT string_agg(id::TEXT || ' (' || status::TEXT || ')', ', ')
        INTO v_exited FROM tournament_participants
       WHERE event_id = p_event_id AND id = ANY (p_won)
         AND status::TEXT IN ('withdrawn', 'disqualified');
    END IF;
    IF v_exited IS NOT NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'winner_exited',
                                'winners', v_exited);
    END IF;
  END IF;

  SELECT count(*) INTO v_open FROM tournament_matches
   WHERE event_id = p_event_id
     AND status::TEXT NOT IN ('completed', 'walkover', 'voided', 'bye')
     AND COALESCE(is_bye, FALSE) = FALSE;
  IF v_open > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'matches_incomplete',
                              'incomplete', v_open);
  END IF;

  -- ---- past this line every fault RAISES, so a partial write cannot commit ----

  -- Every write is qualified by event_id as well as id. The ids are computed by
  -- the caller and this function is SECURITY DEFINER, so without that a caller
  -- passing an id from a DIFFERENT event would silently repaint a row in a
  -- tournament it was never finalising.
  --
  -- Row counts are compared against what was asked for. An id that matches
  -- nothing updates nothing, which without this check is a placing that
  -- silently fails to land while the event still completes -- the exact shape
  -- of half-written standings.
  v_want := (SELECT count(*) FROM jsonb_object_keys(p_positions));
  IF v_want > 0 THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs t SET final_position = (v.value)::int
        FROM jsonb_each_text(p_positions) AS v(key, value)
       WHERE t.id = v.key::uuid AND t.event_id = p_event_id;
    ELSE
      UPDATE tournament_participants t SET final_position = (v.value)::int
        FROM jsonb_each_text(p_positions) AS v(key, value)
       WHERE t.id = v.key::uuid AND t.event_id = p_event_id;
    END IF;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_want THEN
      RAISE EXCEPTION 'complete_event_under_field_lock: % of % final_position writes matched no row in event %',
                      v_want - v_got, v_want, p_event_id;
    END IF;
  END IF;

  v_want := (SELECT count(*) FROM jsonb_object_keys(p_points));
  IF v_want > 0 THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs t SET points = (v.value)::int
        FROM jsonb_each_text(p_points) AS v(key, value)
       WHERE t.id = v.key::uuid AND t.event_id = p_event_id;
    ELSE
      UPDATE tournament_participants t SET points = (v.value)::int
        FROM jsonb_each_text(p_points) AS v(key, value)
       WHERE t.id = v.key::uuid AND t.event_id = p_event_id;
    END IF;
    GET DIAGNOSTICS v_got = ROW_COUNT;
    IF v_got <> v_want THEN
      RAISE EXCEPTION 'complete_event_under_field_lock: % of % points writes matched no row in event %',
                      v_want - v_got, v_want, p_event_id;
    END IF;
  END IF;

  -- The clear is NOT row-count checked, and that asymmetry is deliberate. It
  -- names rows that must STOP holding a placing; a row that is gone already
  -- holds none, so a short count is the goal reached by another route. The two
  -- writes above name rows that must START holding one, where a short count is
  -- a placing lost.
  IF array_length(p_clear, 1) IS NOT NULL THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs SET final_position = NULL, points = NULL
       WHERE event_id = p_event_id AND id = ANY (p_clear);
    ELSE
      UPDATE tournament_participants SET final_position = NULL, points = NULL
       WHERE event_id = p_event_id AND id = ANY (p_clear);
    END IF;
  END IF;

  UPDATE tournament_events
     SET status = 'completed', updated_at = NOW()
   WHERE id = p_event_id;

  RETURN jsonb_build_object('ok', TRUE, 'event_id', p_event_id,
                            'tournament_id', v_tournament);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[], jsonb, jsonb, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[], jsonb, jsonb, uuid[]) TO service_role;

DO $verify$
DECLARE
  v_t      UUID;
  v_e      UUID;
  v_p1     UUID; v_p2 UUID; v_p3 UUID;
  v_e1     UUID; v_e2 UUID; v_e3 UUID;
  v_res    JSONB;
  v_n      INT;
  -- atomicity probe
  v_raised BOOLEAN := FALSE;
  v_a_pos  INT;
  v_a_stat TEXT;
  -- refusal-before-writes probe
  v_r_ref  TEXT;
  v_r_pos  INT;
  -- happy path
  v_h_ok   BOOLEAN := FALSE;
  v_h_pos  INT; v_h_pts INT;
  v_h_cpos INT; v_h_cpts INT;
  v_h_stat TEXT;
BEGIN
  -- 1. The 4-argument form is GONE, not merely shadowed. An overload left in
  --    place would let an un-redeployed caller complete an event by the route
  --    that writes nothing, which is the failure being closed.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00212: expected exactly one complete_event_under_field_lock, found %', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND pg_get_function_identity_arguments(p.oid) =
           'p_event_id uuid, p_is_pair boolean, p_field uuid[], p_won uuid[], p_positions jsonb, p_points jsonb, p_clear uuid[]')
  THEN
    RAISE EXCEPTION '00212: the surviving overload is not the 7-argument form';
  END IF;

  -- 2. Grants, and the field key -- both would pass silently if the body were
  --    rewritten without them.
  IF has_function_privilege('anon', 'public.complete_event_under_field_lock(uuid,boolean,uuid[],uuid[],jsonb,jsonb,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '00212: anon can execute the completion flip';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_event_under_field_lock(uuid,boolean,uuid[],uuid[],jsonb,jsonb,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '00212: service_role cannot execute the completion flip';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' IN p.prosrc) > 0)
  THEN
    RAISE EXCEPTION '00212: the completion flip no longer takes the field key';
  END IF;

  -- 3. THE BEHAVIOUR, in three directions. A guard that wrote nothing ever, or
  --    refused everything, would pass any one of them alone.
  BEGIN
    INSERT INTO players (email, first_name) VALUES ('_f212a@invalid.test','WriteA') RETURNING id INTO v_p1;
    INSERT INTO players (email, first_name) VALUES ('_f212b@invalid.test','WriteB') RETURNING id INTO v_p2;
    INSERT INTO players (email, first_name) VALUES ('_f212c@invalid.test','WriteC') RETURNING id INTO v_p3;
    INSERT INTO tournaments (name, start_date) VALUES ('_f212 probe', CURRENT_DATE) RETURNING id INTO v_t;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'live') RETURNING id INTO v_e;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_e, v_p1, 'checked_in') RETURNING id INTO v_e1;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_e, v_p2, 'checked_in') RETURNING id INTO v_e2;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_e, v_p3, 'checked_in') RETURNING id INTO v_e3;

    -- 3a. A FAULT DURING THE WRITES ROLLS BACK THE WRITES. This is the whole
    --     migration. One placing is real and one names a row that is not in
    --     this event; the real one must not survive, or the event has half a
    --     ladder written by a call that failed.
    BEGIN
      v_res := complete_event_under_field_lock(
        v_e, FALSE, ARRAY[v_e1, v_e2, v_e3], ARRAY[v_e1],
        jsonb_build_object(v_e1::TEXT, 1, gen_random_uuid()::TEXT, 2),
        '{}'::jsonb, '{}'::uuid[]);
    EXCEPTION WHEN others THEN
      v_raised := TRUE;
    END;
    SELECT final_position INTO v_a_pos FROM tournament_participants WHERE id = v_e1;
    SELECT status::TEXT   INTO v_a_stat FROM tournament_events WHERE id = v_e;

    -- 3b. A REFUSAL BEFORE THE WRITES WRITES NOTHING. Same call shape, but the
    --     field check fires first: e3 is active and absent from p_field.
    v_res := complete_event_under_field_lock(
      v_e, FALSE, ARRAY[v_e1, v_e2], ARRAY[v_e1],
      jsonb_build_object(v_e1::TEXT, 1, v_e2::TEXT, 2),
      jsonb_build_object(v_e1::TEXT, 100, v_e2::TEXT, 75), '{}'::uuid[]);
    v_r_ref := v_res->>'reason';
    SELECT final_position INTO v_r_pos FROM tournament_participants WHERE id = v_e1;

    -- 3c. THE HAPPY PATH LANDS ALL FOUR: positions, points, the clear, and the
    --     flip. e3 is given a stale placing first so the clear has something to
    --     take away.
    UPDATE tournament_participants SET final_position = 9, points = 5 WHERE id = v_e3;
    v_res := complete_event_under_field_lock(
      v_e, FALSE, ARRAY[v_e1, v_e2, v_e3], ARRAY[v_e1],
      jsonb_build_object(v_e1::TEXT, 1, v_e2::TEXT, 2),
      jsonb_build_object(v_e1::TEXT, 100, v_e2::TEXT, 75), ARRAY[v_e3]);
    v_h_ok := COALESCE((v_res->>'ok')::boolean, FALSE);
    SELECT final_position, points INTO v_h_pos,  v_h_pts  FROM tournament_participants WHERE id = v_e1;
    SELECT final_position, points INTO v_h_cpos, v_h_cpts FROM tournament_participants WHERE id = v_e3;
    SELECT status::TEXT INTO v_h_stat FROM tournament_events WHERE id = v_e;

    RAISE EXCEPTION 'rollback probe 212';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback probe 212' THEN RAISE; END IF;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION '00212: a placing naming a row outside the event was accepted silently';
  END IF;
  IF v_a_pos IS NOT NULL THEN
    RAISE EXCEPTION '00212: a failed call left final_position % written -- the writes are not atomic with the flip', v_a_pos;
  END IF;
  IF v_a_stat IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION '00212: a failed call moved the event to %', v_a_stat;
  END IF;

  IF v_r_ref IS DISTINCT FROM 'field_changed' THEN
    RAISE EXCEPTION '00212: an event whose field grew was not refused (reason %)',
                    COALESCE(v_r_ref, 'none -- it completed');
  END IF;
  IF v_r_pos IS NOT NULL THEN
    RAISE EXCEPTION '00212: a refused call still wrote final_position %', v_r_pos;
  END IF;

  IF NOT v_h_ok THEN
    RAISE EXCEPTION '00212: a well-formed completion was refused, so the guard refuses everything';
  END IF;
  IF v_h_pos IS DISTINCT FROM 1 OR v_h_pts IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION '00212: the champion finished with position %, points % -- expected 1, 100', v_h_pos, v_h_pts;
  END IF;
  IF v_h_cpos IS NOT NULL OR v_h_cpts IS NOT NULL THEN
    RAISE EXCEPTION '00212: p_clear left a stale placing behind (position %, points %)', v_h_cpos, v_h_cpts;
  END IF;
  IF v_h_stat IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION '00212: the event did not complete (status %)', v_h_stat;
  END IF;

  RAISE NOTICE '00212 verified: one 7-argument overload on the field key; placings, points and clears land in the same transaction as the flip, a refusal writes nothing, and a fault mid-write rolls the whole call back';
END
$verify$;

NOTIFY pgrst, 'reload schema';
