-- ===========================================================================
-- 00211 — A CHAMPION WHO LEFT CANNOT BE CROWNED
-- ===========================================================================
--
-- 00209 put the completion flip behind the field fence. Its field check asks:
-- is there an active entry in this event that was NOT in the field the caller
-- computed positions from? Growth is refused; SHRINKAGE IS DELIBERATELY
-- ALLOWED, because a withdrawn entry needs no placing.
--
-- That allowance is right for an entry that LOST and wrong for one that WON,
-- and the difference is a live defect:
--
--   finalizeEvent reads the winners' status and finds them all active
--     |                       (finalize.ts, inside assignPositionsAndPoints)
--     |   an admin disqualifies the champion X through set_field_entry_status
--     |   -- correctly, under the same fence, committing cleanly
--     v
--   finalizeEvent writes X's final_position = 1 and 100 points, then flips the
--   event to completed. The field check counts only ACTIVE entries missing
--   from the old field, so exited X is not counted and nothing refuses.
--
-- The application-side guard cannot close this on its own: it is a read, and it
-- holds no lock through to the flip. So the flip re-checks it, which is the
-- protocol this function already uses for the field — THE CALLER PASSES WHAT IT
-- WORKED FROM, AND THE FLIP HAPPENS ONLY IF THAT IS STILL TRUE.
--
-- p_won is the set of entries holding a placing they WON: the champion, and the
-- winner of the third-place playoff. Not every match winner — an entry that won
-- in round one and then withdrew is the ordinary case and must still finalise.
-- Empty for round robin, whose standings already exclude exited entries.
--
-- The 3-argument form is DROPPED rather than left beside this one. An overload
-- would let a caller that has not been redeployed keep completing events with
-- no winner check at all, silently, which is the failure being closed. Nothing
-- on production calls either form yet: 00209 introduced the function in this
-- same unreleased range.
-- ===========================================================================

DROP FUNCTION IF EXISTS public.complete_event_under_field_lock(uuid, boolean, uuid[]);

CREATE OR REPLACE FUNCTION public.complete_event_under_field_lock(
  p_event_id uuid, p_is_pair boolean, p_field uuid[], p_won uuid[]
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
BEGIN
  IF p_event_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_event_id and p_is_pair may not be null';
  END IF;
  -- NULL is a caller that did not read its field; an empty array is a caller
  -- that read an empty field. Only the first is a fault, and it must not be
  -- able to degrade into an unchecked completion. p_won is held to the same
  -- rule for the same reason -- a round robin passes '{}', never NULL.
  IF p_field IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_field may not be null';
  END IF;
  IF p_won IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_won may not be null';
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

  UPDATE tournament_events
     SET status = 'completed', updated_at = NOW()
   WHERE id = p_event_id;

  RETURN jsonb_build_object('ok', TRUE, 'event_id', p_event_id,
                            'tournament_id', v_tournament);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[]) TO service_role;

DO $verify$
DECLARE
  v_t    UUID;
  v_e    UUID;
  v_p1   UUID;
  v_p2   UUID;
  v_e1   UUID;
  v_e2   UUID;
  v_res  JSONB;
  v_ref  TEXT;
  v_ok   BOOLEAN := FALSE;
  v_stat TEXT;
  v_n    INT;
BEGIN
  -- 1. The 3-argument form is GONE, not merely shadowed. An overload left in
  --    place is the whole failure mode this migration is closing.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00211: expected exactly one complete_event_under_field_lock, found %', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid, p_is_pair boolean, p_field uuid[], p_won uuid[]')
  THEN
    RAISE EXCEPTION '00211: the surviving overload is not the 4-argument form';
  END IF;

  -- 2. Grants, and the field key -- both would pass silently if the body were
  --    rewritten without them.
  IF has_function_privilege('anon', 'public.complete_event_under_field_lock(uuid,boolean,uuid[],uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '00211: anon can execute the completion flip';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_event_under_field_lock(uuid,boolean,uuid[],uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '00211: service_role cannot execute the completion flip';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' IN p.prosrc) > 0)
  THEN
    RAISE EXCEPTION '00211: the completion flip no longer takes the field key';
  END IF;

  -- 3. THE BEHAVIOUR. A disqualified champion is refused; the same event with
  --    the same disqualification completes fine once the loser is the one who
  --    left. Both directions, because a function that refused EVERYTHING would
  --    pass a one-sided check.
  BEGIN
    INSERT INTO players (email, first_name) VALUES ('_f211a@invalid.test','WonA') RETURNING id INTO v_p1;
    INSERT INTO players (email, first_name) VALUES ('_f211b@invalid.test','WonB') RETURNING id INTO v_p2;
    INSERT INTO tournaments (name, start_date) VALUES ('_f211 probe', CURRENT_DATE) RETURNING id INTO v_t;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'live') RETURNING id INTO v_e;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_e, v_p1, 'disqualified') RETURNING id INTO v_e1;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_e, v_p2, 'checked_in') RETURNING id INTO v_e2;

    -- The champion is the disqualified one. This is the defect.
    v_res := complete_event_under_field_lock(v_e, FALSE, ARRAY[v_e1, v_e2], ARRAY[v_e1]);
    v_ref := v_res->>'reason';
    SELECT status::TEXT INTO v_stat FROM tournament_events WHERE id = v_e;

    -- Same event, same disqualification, but the entry that left only ever
    -- LOST -- the ordinary withdrawal, which must still finalise.
    v_res := complete_event_under_field_lock(v_e, FALSE, ARRAY[v_e1, v_e2], ARRAY[v_e2]);
    v_ok  := COALESCE((v_res->>'ok')::boolean, FALSE);

    RAISE EXCEPTION 'rollback probe 211';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback probe 211' THEN RAISE; END IF;
  END;

  IF v_ref IS DISTINCT FROM 'winner_exited' THEN
    RAISE EXCEPTION '00211: a disqualified champion was not refused (reason %)',
                    COALESCE(v_ref, 'none -- the event completed');
  END IF;
  IF v_stat IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION '00211: a refused completion still moved the event to %', v_stat;
  END IF;
  IF NOT v_ok THEN
    RAISE EXCEPTION '00211: an ordinary withdrawal of a LOSER was refused, so the guard refuses everything';
  END IF;

  RAISE NOTICE '00211 verified: one 4-argument overload on the field key; a disqualified champion is refused and the event stays live, while a loser who left still finalises';
END
$verify$;

NOTIFY pgrst, 'reload schema';
