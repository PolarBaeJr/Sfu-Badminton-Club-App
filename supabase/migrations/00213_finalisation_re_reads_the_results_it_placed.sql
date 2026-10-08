-- ===========================================================================
-- 00213 — FINALISATION RE-READS THE RESULTS IT PLACED FROM
-- ===========================================================================
--
-- 00209 fenced the completion flip against a field that GREW. 00211 fenced it
-- against a winner that LEFT. 00212 moved the placings themselves under the
-- lock so a refused or faulted call cannot half-write a ladder. All three fence
-- the ENTRIES. None of them fences the RESULTS the placings were computed
-- from, and the placings come from the matches, not from the entries:
--
--   A: reads the matches, computes the ladder    (champion = X, from match M)
--     |    B: corrects M -- the score was entered backwards, Y actually won
--     |       M stays 'completed'. No entry withdrew. No entry arrived.
--   A: calls the flip. Field unchanged. p_won holds X, and X is still active.
--   A: writes X as champion and completes the event.
--
-- Every existing check passes, because every existing check is asking about
-- entries. The one match check there IS -- the open-match count -- cannot see
-- this either: a corrected result leaves the match `completed`, and a VOID sets
-- it to `voided`, which that count explicitly excludes as settled. So voiding
-- the final mid-finalisation is likewise invisible: the ladder still crowns
-- whoever the voided match said won.
--
-- WHAT THIS ADDS is the same protocol one layer down. The caller passes what it
-- computed FROM, not only who it computed ABOUT, and the flip happens only if
-- that is still what the matches say.
--
-- WHY A JSONB SNAPSHOT AND NOT AN md5 OR A TIMESTAMP WATERMARK.
--
--   * A watermark was the cheap option and it is not available: there is no
--     updated_at maintenance trigger on tournament_matches (the only trigger is
--     trg_tournament_match_generation). The column is whatever a caller
--     happened to set, so a fence reading it would pass for writers that do not
--     touch it -- vacuous, and silently so.
--   * An md5 over string_agg is a NULL trap. loser_pair_id is NULL on every
--     singles match and 'x' || NULL is NULL, so the digest collapses to NULL
--     for essentially every event, `<>` against NULL is never true, and the
--     fence opens for all input forever. jsonb_build_object turns a SQL NULL
--     into a json null instead, which compares.
--   * jsonb objects are canonicalised by key, so the aggregate needs no
--     ORDER BY to be stable across snapshots -- string_agg would, and getting
--     that wrong shows up as spurious refusals on ordinary finalisations.
--
-- It also says WHICH match moved, which a digest cannot.
--
-- THE COLUMN SET IS DELIBERATELY NARROW: what a placing can be computed from,
-- and nothing that merely moves during play. court, scheduled_time,
-- ready_player_ids, elo_snapshot, result_entered_by/at, time_exceeded,
-- updated_at and the per-match format settings are all excluded -- any of them
-- changing mid-finalisation would refuse a finalisation that is perfectly
-- correct, and a fence that cries wolf gets worked around.
--
-- The 7-argument form is dropped for the reason 00212 dropped the 6, and 00211
-- the 3: an un-redeployed caller must not be able to complete an event by a
-- route that skips the new check. Nothing on production calls any form --
-- 00209, 00211, 00212 and this are all inside the same unreleased range.
-- ===========================================================================

-- THE SNAPSHOT. Both sides call THIS, so there is no digest format to keep in
-- agreement between TypeScript and plpgsql -- the caller never builds one, it
-- only carries one. A parity bug is not possible by construction.
CREATE OR REPLACE FUNCTION public.event_results_fingerprint(p_event_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    jsonb_object_agg(m.id::TEXT, jsonb_build_object(
      'st', m.status::TEXT,
      'wp', m.winner_participant_id,
      'wr', m.winner_pair_id,
      'lp', m.loser_participant_id,
      'lr', m.loser_pair_id,
      'sc', m.scores,
      'wo', m.walkover_winner,
      'by', m.is_bye,
      'th', m.is_third_place,
      'rn', m.round_number,
      'bp', m.bracket_position,
      'ph', m.phase,
      'pa', m.participant_a_id,
      'pb', m.participant_b_id,
      'ra', m.pair_a_id,
      'rb', m.pair_b_id,
      'dg', m.draw_generation_id
    )),
    -- An event with no matches has an EMPTY snapshot, not a null one. Without
    -- this the aggregate returns NULL, and NULL IS DISTINCT FROM NULL is false,
    -- so the fence would quietly stop fencing exactly when it is cheapest to.
    '{}'::jsonb)
  FROM tournament_matches m
  WHERE m.event_id = p_event_id;
$function$;

REVOKE ALL ON FUNCTION public.event_results_fingerprint(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_results_fingerprint(uuid) TO service_role;

DROP FUNCTION IF EXISTS public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[], jsonb, jsonb, uuid[]);

CREATE OR REPLACE FUNCTION public.complete_event_under_field_lock(
  p_event_id uuid, p_is_pair boolean, p_field uuid[], p_won uuid[],
  p_positions jsonb, p_points jsonb, p_clear uuid[], p_results jsonb
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
  v_results    jsonb;
  v_moved      text;
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
  -- Same rule as p_field, and for the same reason: an event with no matches
  -- passes '{}', so NULL can only mean a caller that never took a snapshot.
  -- Letting that through would make the new fence opt-out by omission.
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'object' THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_results must be the object returned by event_results_fingerprint';
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

  -- THE RESULTS, RE-READ UNDER THE LOCK (00213). The count above asks whether
  -- the matches are FINISHED; this asks whether they still SAY what the caller
  -- placed from. A corrected winner and a voided final both leave that count at
  -- zero, which is why it cannot stand in for this.
  v_results := event_results_fingerprint(p_event_id);
  IF v_results IS DISTINCT FROM p_results THEN
    SELECT string_agg(k, ', ') INTO v_moved FROM (
      SELECT k FROM jsonb_object_keys(v_results || p_results) AS k
       WHERE (v_results -> k) IS DISTINCT FROM (p_results -> k)
       ORDER BY k LIMIT 5) s;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'results_changed',
                              'matches_moved', v_moved);
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

REVOKE ALL ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[], jsonb, jsonb, uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[], jsonb, jsonb, uuid[], jsonb) TO service_role;

DO $verify$
DECLARE
  v_t      UUID;
  v_e      UUID;
  v_empty  UUID;
  v_p1     UUID; v_p2 UUID;
  v_e1     UUID; v_e2 UUID;
  v_m      UUID;
  v_res    JSONB;
  v_snap   JSONB;
  v_n      INT;
  -- the empty-event snapshot
  v_zero   JSONB;
  -- corrected-result probe
  v_c_ref  TEXT;
  v_c_move TEXT;
  v_c_pos  INT;
  v_c_stat TEXT;
  -- voided-final probe
  v_v_ref  TEXT;
  v_v_pos  INT;
  -- null-argument probe
  v_raised BOOLEAN := FALSE;
  -- happy path
  v_h_ok   BOOLEAN := FALSE;
  v_h_pos  INT; v_h_pts INT;
  v_h_stat TEXT;
BEGIN
  -- 1. The 7-argument form is GONE, not merely shadowed. An overload left in
  --    place would let an un-redeployed caller complete an event by the route
  --    that never re-reads the results, which is the failure being closed.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00213: expected exactly one complete_event_under_field_lock, found %', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND pg_get_function_identity_arguments(p.oid) =
           'p_event_id uuid, p_is_pair boolean, p_field uuid[], p_won uuid[], p_positions jsonb, p_points jsonb, p_clear uuid[], p_results jsonb')
  THEN
    RAISE EXCEPTION '00213: the surviving overload is not the 8-argument form';
  END IF;

  -- 2. Grants on BOTH functions, and the field key. The snapshot reads match
  --    data as SECURITY DEFINER, so it is held to the same rule as the flip.
  IF has_function_privilege('anon', 'public.complete_event_under_field_lock(uuid,boolean,uuid[],uuid[],jsonb,jsonb,uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '00213: anon can execute the completion flip';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_event_under_field_lock(uuid,boolean,uuid[],uuid[],jsonb,jsonb,uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '00213: service_role cannot execute the completion flip';
  END IF;
  IF has_function_privilege('anon', 'public.event_results_fingerprint(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.event_results_fingerprint(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00213: the results snapshot is executable by a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.event_results_fingerprint(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00213: service_role cannot execute the results snapshot';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' IN p.prosrc) > 0)
  THEN
    RAISE EXCEPTION '00213: the completion flip no longer takes the field key';
  END IF;

  -- 3. THE BEHAVIOUR. A fence that refuses everything and a fence that refuses
  --    nothing both pass any single direction, so all four run.
  BEGIN
    INSERT INTO players (email, first_name) VALUES ('_f213a@invalid.test','ResA') RETURNING id INTO v_p1;
    INSERT INTO players (email, first_name) VALUES ('_f213b@invalid.test','ResB') RETURNING id INTO v_p2;
    INSERT INTO tournaments (name, start_date) VALUES ('_f213 probe', CURRENT_DATE) RETURNING id INTO v_t;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'live') RETURNING id INTO v_e;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'live') RETURNING id INTO v_empty;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_e, v_p1, 'checked_in') RETURNING id INTO v_e1;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_e, v_p2, 'checked_in') RETURNING id INTO v_e2;
    INSERT INTO tournament_matches (event_id, round_number, bracket_position, status,
                                    participant_a_id, participant_b_id,
                                    winner_participant_id, loser_participant_id, scores)
      VALUES (v_e, 1, 1, 'completed', v_e1, v_e2, v_e1, v_e2, '[{"a":21,"b":15}]'::jsonb)
      RETURNING id INTO v_m;

    -- 3a. AN EVENT WITH NO MATCHES SNAPSHOTS AS {}, NOT NULL. If the aggregate
    --     were left to return NULL, the comparison below would be NULL IS
    --     DISTINCT FROM NULL -- false -- and the fence would silently stop
    --     fencing on the cheapest events to get wrong.
    v_zero := event_results_fingerprint(v_empty);

    -- 3b. A CORRECTED RESULT IS REFUSED. This is the whole migration: the score
    --     was entered backwards and fixed while the ladder was being computed.
    --     The match stays 'completed' throughout, no entry moves, and every
    --     pre-existing check therefore passes.
    v_snap := event_results_fingerprint(v_e);
    UPDATE tournament_matches
       SET winner_participant_id = v_e2, loser_participant_id = v_e1
     WHERE id = v_m;
    v_res := complete_event_under_field_lock(
      v_e, FALSE, ARRAY[v_e1, v_e2], ARRAY[v_e1],
      jsonb_build_object(v_e1::TEXT, 1, v_e2::TEXT, 2),
      jsonb_build_object(v_e1::TEXT, 100, v_e2::TEXT, 75), '{}'::uuid[], v_snap);
    v_c_ref  := v_res->>'reason';
    v_c_move := v_res->>'matches_moved';
    SELECT final_position INTO v_c_pos FROM tournament_participants WHERE id = v_e1;
    SELECT status::TEXT   INTO v_c_stat FROM tournament_events WHERE id = v_e;

    -- 3c. A VOIDED MATCH IS REFUSED. Separate from 3b because 'voided' is one
    --     of the statuses the open-match count treats as SETTLED -- so voiding
    --     the final mid-finalisation leaves that count at zero and is invisible
    --     to every check that predates this one.
    UPDATE tournament_matches
       SET winner_participant_id = v_e1, loser_participant_id = v_e2
     WHERE id = v_m;
    v_snap := event_results_fingerprint(v_e);
    UPDATE tournament_matches SET status = 'voided' WHERE id = v_m;
    v_res := complete_event_under_field_lock(
      v_e, FALSE, ARRAY[v_e1, v_e2], ARRAY[v_e1],
      jsonb_build_object(v_e1::TEXT, 1, v_e2::TEXT, 2),
      jsonb_build_object(v_e1::TEXT, 100, v_e2::TEXT, 75), '{}'::uuid[], v_snap);
    v_v_ref := v_res->>'reason';
    SELECT final_position INTO v_v_pos FROM tournament_participants WHERE id = v_e1;

    -- 3d. A CALLER THAT TOOK NO SNAPSHOT IS A FAULT, not a completion. Without
    --     this the new argument would be opt-out by omission.
    UPDATE tournament_matches SET status = 'completed' WHERE id = v_m;
    BEGIN
      v_res := complete_event_under_field_lock(
        v_e, FALSE, ARRAY[v_e1, v_e2], ARRAY[v_e1],
        '{}'::jsonb, '{}'::jsonb, '{}'::uuid[], NULL);
    EXCEPTION WHEN others THEN
      v_raised := TRUE;
    END;

    -- 3e. AN UNCHANGED EVENT STILL FINALISES. The other failure mode is a fence
    --     that refuses every finalisation, and it looks exactly like success in
    --     a probe that only checks refusals.
    v_snap := event_results_fingerprint(v_e);
    v_res := complete_event_under_field_lock(
      v_e, FALSE, ARRAY[v_e1, v_e2], ARRAY[v_e1],
      jsonb_build_object(v_e1::TEXT, 1, v_e2::TEXT, 2),
      jsonb_build_object(v_e1::TEXT, 100, v_e2::TEXT, 75), '{}'::uuid[], v_snap);
    v_h_ok := COALESCE((v_res->>'ok')::boolean, FALSE);
    SELECT final_position, points INTO v_h_pos, v_h_pts FROM tournament_participants WHERE id = v_e1;
    SELECT status::TEXT INTO v_h_stat FROM tournament_events WHERE id = v_e;

    RAISE EXCEPTION 'rollback probe 213';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback probe 213' THEN RAISE; END IF;
  END;

  IF v_zero IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION '00213: an event with no matches snapshots as % -- a null there disables the fence', COALESCE(v_zero::TEXT, 'NULL');
  END IF;

  IF v_c_ref IS DISTINCT FROM 'results_changed' THEN
    RAISE EXCEPTION '00213: a corrected match result was not refused (reason %)',
                    COALESCE(v_c_ref, 'none -- it completed');
  END IF;
  IF v_c_move IS NULL THEN
    RAISE EXCEPTION '00213: the refusal did not name the match that moved';
  END IF;
  IF v_c_pos IS NOT NULL THEN
    RAISE EXCEPTION '00213: a refused call still wrote final_position %', v_c_pos;
  END IF;
  IF v_c_stat IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION '00213: a refused call moved the event to %', v_c_stat;
  END IF;

  IF v_v_ref IS DISTINCT FROM 'results_changed' THEN
    RAISE EXCEPTION '00213: voiding a settled match mid-finalisation was not refused (reason %)',
                    COALESCE(v_v_ref, 'none -- it completed');
  END IF;
  IF v_v_pos IS NOT NULL THEN
    RAISE EXCEPTION '00213: the voided-match refusal still wrote final_position %', v_v_pos;
  END IF;

  IF NOT v_raised THEN
    RAISE EXCEPTION '00213: a call passing no results snapshot was accepted';
  END IF;

  IF NOT v_h_ok THEN
    RAISE EXCEPTION '00213: an unchanged event was refused, so the fence refuses everything';
  END IF;
  IF v_h_pos IS DISTINCT FROM 1 OR v_h_pts IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION '00213: the champion finished with position %, points % -- expected 1, 100', v_h_pos, v_h_pts;
  END IF;
  IF v_h_stat IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION '00213: the event did not complete (status %)', v_h_stat;
  END IF;

  RAISE NOTICE '00213 verified: one 8-argument overload; a corrected result and a voided match both refuse by name and write nothing, a missing snapshot is a fault, and an unchanged event still finalises';
END
$verify$;

NOTIFY pgrst, 'reload schema';
