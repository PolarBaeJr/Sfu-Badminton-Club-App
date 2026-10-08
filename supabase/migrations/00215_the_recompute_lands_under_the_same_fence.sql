-- 00215  The recompute lands under the same fence
--
-- 00212 moved finalisation's placings under the event lock. 00213 made it
-- re-read the results it placed from. 00214 made that re-read a real fence by
-- locking the match rows. All three protect ONE of the two paths that write
-- final_position and points.
--
-- The other one is the CORRECTION path, and it was left entirely unfenced:
--
--   apps/admin/src/lib/tournament-actions/finalize.ts  recomputeEventStandings
--     -> reads the placings
--     -> reads the matches and computes a new ladder
--     -> writes it with three plain PostgREST UPDATEs (writePlacements)
--
-- No advisory lock, no row lock, no re-read. Its only caller,
-- recomputeStandingsAfterCorrection (results.ts), runs it AFTER the corrective
-- mutation has already committed, also outside any lock. So:
--
--   A: officer corrects a result on completed event E
--   A: reads the matches, computes ladder M1 (champion = X)
--     |    B: officer voids the final of the same event
--     |    B: reads the matches, finds no champion, clears the whole field
--   A: writes M1
--
-- X is champion again, holding final_position and points, on an event whose
-- deciding match no longer has a result. Nothing errors. Both officers are told
-- their action landed. Placement bonuses read placings by
-- `final_position IS NOT NULL` with no status filter, so a later bonus run pays
-- the restored champion.
--
-- This is the same defect 00213 closed one path over, and it is closed the same
-- way: the caller passes what it computed FROM, and the write happens only if
-- that is still what the matches say. The snapshot is built by
-- event_results_fingerprint (00213) on both sides, so there is no digest format
-- for TypeScript to get wrong.
--
-- WHAT THIS DELIBERATELY DOES *NOT* CHECK, and why the asymmetry with
-- complete_event_under_field_lock is correct rather than an oversight.
--
--   * p_field (an entry ARRIVED). Finalisation refuses on growth because an
--     entrant who appears before the flip must be placed. This event is already
--     completed -- an entry arriving into it holds no placing and changes no
--     ladder, so refusing on it would block a correction for a reason that has
--     nothing to do with the correction.
--
--   * p_won (a placed winner LEFT). This is the one that looks like a gap and
--     is not, and the discriminator is the END STATE under a refusal:
--
--       finalisation refuses -> nothing has been written. The event stays
--         live, no placing exists, and the officer is told to void or replay.
--         Refusing is strictly safe.
--
--       a recompute refuses -> the event is ALREADY completed and the stale
--         standings are ALREADY standing. Refusing leaves the disqualified
--         entry holding first place with no remedy reachable from the console,
--         because void/replay does not apply to a completed event. Refusing is
--         WORSE than writing.
--
--     That is the same "one predicate, two policies" split the champion-
--     undetermined case takes in finalize.ts: finalisation refuses because
--     nothing is written yet; the recompute CLEARS because something wrong is
--     standing. The read-side guard in assignPositionsAndPoints already throws
--     when a placed winner has exited, so adding the check here would not make
--     anyone safer -- it would only change which message the officer reads
--     while the stale placing survives either way.
--
--   * The open-match count. Finalisation must not complete an event with a
--     match still in play. A recompute is not completing anything; it is
--     restating the standings of an event that already completed, and an event
--     cannot have reached that state with an open match.
--
-- WHAT IT DOES REQUIRE is that the event is still `completed`. The TypeScript
-- side returns early for any other status, but that read holds no lock through
-- to the write, so the status is re-asserted here for the same reason 00209
-- re-asserts `live`.
--
-- HONESTY ABOUT THE VERIFICATION, carried forward from 00214. The row lock
-- below cannot be proved by a single-session DO block or by the in-memory test
-- harness -- both would stay green with the line deleted. The source assertion
-- in the verifier is a regression tripwire, and probe 4f observes the lock's
-- effect (xmax set on the match rows) rather than asserting the statement
-- exists. Real contention evidence is the two-session procedure in
-- docs/sensitive/00214-TWO-SESSION-LOCK-EVIDENCE.md, which applies verbatim to
-- this function.

CREATE OR REPLACE FUNCTION public.rewrite_event_placings_under_field_lock(
  p_event_id uuid, p_is_pair boolean,
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
  v_want       integer;
  v_got        integer;
  v_results    jsonb;
  v_moved      text;
BEGIN
  IF p_event_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'rewrite_event_placings_under_field_lock: p_event_id and p_is_pair may not be null';
  END IF;
  -- A caller with nothing to write passes '{}' and '{}'::uuid[], never NULL --
  -- the same rule every argument of the completion flip is held to. NULL can
  -- only mean a caller that failed to compute something, and it must not be
  -- able to degrade into an unchecked write.
  IF p_positions IS NULL OR p_points IS NULL OR p_clear IS NULL THEN
    RAISE EXCEPTION 'rewrite_event_placings_under_field_lock: p_positions, p_points and p_clear may not be null';
  END IF;
  IF jsonb_typeof(p_positions) <> 'object' OR jsonb_typeof(p_points) <> 'object' THEN
    RAISE EXCEPTION 'rewrite_event_placings_under_field_lock: p_positions and p_points must be json objects of entry id -> number';
  END IF;
  -- An event with no matches snapshots as '{}', so NULL here can only mean a
  -- caller that never took a snapshot. Letting it through would make the fence
  -- opt-out by omission, which is how a fence stops being one.
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'object' THEN
    RAISE EXCEPTION 'rewrite_event_placings_under_field_lock: p_results must be the object returned by event_results_fingerprint';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.tournament_id
    INTO v_status, v_tournament
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  -- Only a completed event has standings to restate. A live one gets them when
  -- it is finalised, and writing a ladder into a live event would put placings
  -- on a field that can still change.
  IF v_status <> 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  -- THE MATCH ROWS THEMSELVES, LOCKED (00214's statement, same reasoning).
  -- The three paths that edit a recorded result -- score correction, void and
  -- undo -- are plain PostgREST UPDATEs that take no advisory lock, so the
  -- re-read below would be a check rather than a fence without this. FOR NO KEY
  -- UPDATE is exactly the lock mode an ordinary UPDATE takes, so it conflicts
  -- with them whether or not they know this lock exists.
  --
  -- LOCK ORDER is identical to complete_event_under_field_lock's: advisory ->
  -- tournament_events row -> tournament_matches rows -> entry rows. The two
  -- functions therefore cannot deadlock against each other, and the analysis in
  -- 00214 of every other writer of both tables carries over unchanged.
  PERFORM 1 FROM tournament_matches WHERE event_id = p_event_id FOR NO KEY UPDATE;

  -- THE RESULTS, RE-READ UNDER THE LOCK. This is the whole migration. A
  -- concurrent correction or void leaves no trace in the entry tables and no
  -- open match, so nothing else here can see it.
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
  -- tournament it was never recomputing.
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
      RAISE EXCEPTION 'rewrite_event_placings_under_field_lock: % of % final_position writes matched no row in event %',
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
      RAISE EXCEPTION 'rewrite_event_placings_under_field_lock: % of % points writes matched no row in event %',
                      v_want - v_got, v_want, p_event_id;
    END IF;
  END IF;

  -- Not row-count checked, and the asymmetry is the same one 00212 explains:
  -- this names rows that must STOP holding a placing, so a row that is gone
  -- already holds none and a short count is the goal reached by another route.
  -- The two writes above name rows that must START holding one, where a short
  -- count is a placing lost.
  IF array_length(p_clear, 1) IS NOT NULL THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs SET final_position = NULL, points = NULL
       WHERE event_id = p_event_id AND id = ANY (p_clear);
    ELSE
      UPDATE tournament_participants SET final_position = NULL, points = NULL
       WHERE event_id = p_event_id AND id = ANY (p_clear);
    END IF;
  END IF;

  -- The status is NOT touched. The event was completed before this call and is
  -- completed after it; a recompute restates the standings of a finished event,
  -- it does not finish one.
  RETURN jsonb_build_object('ok', TRUE, 'event_id', p_event_id,
                            'tournament_id', v_tournament);
END;
$function$;

REVOKE ALL ON FUNCTION public.rewrite_event_placings_under_field_lock(uuid, boolean, jsonb, jsonb, uuid[], jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rewrite_event_placings_under_field_lock(uuid, boolean, jsonb, jsonb, uuid[], jsonb) TO service_role;

DO $verify$
DECLARE
  v_t      UUID;
  v_e      UUID;
  v_live   UUID;
  v_p1     UUID; v_p2 UUID;
  v_e1     UUID; v_e2 UUID;
  v_m      UUID;
  v_res    JSONB;
  v_snap   JSONB;
  v_n      INT;
  -- corrected-result probe
  v_c_ref  TEXT;
  v_c_move TEXT;
  v_c_pos  INT;
  -- clear-the-field probe (the championIsUndetermined branch)
  v_z_ok   BOOLEAN := FALSE;
  v_z_pos  INT; v_z_pts INT;
  -- happy path
  v_h_ok   BOOLEAN := FALSE;
  v_h_pos  INT; v_h_pts INT;
  v_h_stat TEXT;
  -- a live event is refused
  v_l_ref  TEXT;
  -- null-argument probe
  v_raised BOOLEAN := FALSE;
  -- cross-event write probe
  v_x_raised BOOLEAN := FALSE;
  -- row-lock probe, on its OWN event and match
  v_lk_e   UUID; v_lk_p UUID; v_lk_e1 UUID; v_lk_m UUID;
  v_lk_pre TEXT; v_lk_post TEXT;
BEGIN
  -- 1. SHAPE AND GRANTS. One overload only -- a second would be a route that
  --    writes placings without carrying a snapshot, which is the failure being
  --    closed.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='rewrite_event_placings_under_field_lock';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00215: expected exactly one rewrite_event_placings_under_field_lock, found %', v_n;
  END IF;
  IF has_function_privilege('anon', 'public.rewrite_event_placings_under_field_lock(uuid,boolean,jsonb,jsonb,uuid[],jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rewrite_event_placings_under_field_lock(uuid,boolean,jsonb,jsonb,uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '00215: a browser role can rewrite placings';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.rewrite_event_placings_under_field_lock(uuid,boolean,jsonb,jsonb,uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '00215: service_role cannot rewrite placings';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='rewrite_event_placings_under_field_lock'
       AND position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' IN p.prosrc) > 0)
  THEN
    RAISE EXCEPTION '00215: the recompute does not take the field key';
  END IF;
  -- The row lock, as a REGRESSION TRIPWIRE ONLY, and matched as the whole
  -- statement rather than the phrase -- prosrc carries this function's own
  -- comments, which discuss FOR NO KEY UPDATE, so a phrase match would pass
  -- with the statement deleted. 00214 shipped that vacuous version first and
  -- mutation testing caught it; this is the corrected form. Probe 4f observes
  -- the effect.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='rewrite_event_placings_under_field_lock'
       AND position('PERFORM 1 FROM tournament_matches WHERE event_id = p_event_id FOR NO KEY UPDATE;' IN p.prosrc) > 0
       AND position('PERFORM 1 FROM tournament_matches WHERE event_id = p_event_id FOR NO KEY UPDATE;' IN p.prosrc)
           < position('v_results := event_results_fingerprint(p_event_id);' IN p.prosrc))
  THEN
    RAISE EXCEPTION '00215: the recompute does not lock the match rows before re-reading them';
  END IF;

  -- 2. THE BEHAVIOUR. A fence that refuses everything and a fence that refuses
  --    nothing both pass any single direction, so both are exercised.
  BEGIN
    INSERT INTO players (email, first_name) VALUES ('_f215a@invalid.test','RecA') RETURNING id INTO v_p1;
    INSERT INTO players (email, first_name) VALUES ('_f215b@invalid.test','RecB') RETURNING id INTO v_p2;
    INSERT INTO tournaments (name, start_date) VALUES ('_f215 probe', CURRENT_DATE) RETURNING id INTO v_t;
    -- COMPLETED, because that is the only status this function writes into.
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'completed') RETURNING id INTO v_e;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'live') RETURNING id INTO v_live;
    INSERT INTO tournament_participants (event_id, player_id, status, final_position, points)
      VALUES (v_e, v_p1, 'checked_in', 1, 100) RETURNING id INTO v_e1;
    INSERT INTO tournament_participants (event_id, player_id, status, final_position, points)
      VALUES (v_e, v_p2, 'checked_in', 2, 75) RETURNING id INTO v_e2;
    INSERT INTO tournament_matches (event_id, round_number, bracket_position, status,
                                    participant_a_id, participant_b_id,
                                    winner_participant_id, loser_participant_id, scores)
      VALUES (v_e, 1, 1, 'completed', v_e1, v_e2, v_e1, v_e2, '[{"a":21,"b":15}]'::jsonb)
      RETURNING id INTO v_m;

    -- 2a. A RESULT THAT MOVED UNDER THE CALLER IS REFUSED, AND NOTHING IS
    --     WRITTEN. This is the concrete sequence: officer A computed a ladder
    --     from the old result, officer B voided the final in between. The match
    --     stays settled and no entry moves, so every entry-side check passes.
    v_snap := event_results_fingerprint(v_e);
    UPDATE tournament_matches SET status = 'voided',
           winner_participant_id = NULL, loser_participant_id = NULL
     WHERE id = v_m;
    v_res := rewrite_event_placings_under_field_lock(
      v_e, FALSE,
      jsonb_build_object(v_e1::TEXT, 1, v_e2::TEXT, 2),
      jsonb_build_object(v_e1::TEXT, 100, v_e2::TEXT, 75),
      '{}'::uuid[], v_snap);
    v_c_ref  := v_res ->> 'reason';
    v_c_move := v_res ->> 'matches_moved';
    SELECT final_position INTO v_c_pos FROM tournament_participants WHERE id = v_e1;

    -- 2b. THE CLEAR BRANCH. With the final voided the event has no champion,
    --     and the recompute's job is to take the placings AWAY. A fence that
    --     only ever refuses would strand the stale champion, so this direction
    --     has to be proved as well as the refusal above.
    v_snap := event_results_fingerprint(v_e);
    v_res := rewrite_event_placings_under_field_lock(
      v_e, FALSE, '{}'::jsonb, '{}'::jsonb, ARRAY[v_e1, v_e2], v_snap);
    v_z_ok := COALESCE((v_res ->> 'ok')::BOOLEAN, FALSE);
    SELECT final_position, points INTO v_z_pos, v_z_pts FROM tournament_participants WHERE id = v_e1;

    -- 2c. AND IT STILL WRITES. Restore the result and recompute normally: an
    --     unchanged snapshot must land the ladder and leave the event
    --     completed.
    UPDATE tournament_matches SET status = 'completed',
           winner_participant_id = v_e1, loser_participant_id = v_e2
     WHERE id = v_m;
    v_snap := event_results_fingerprint(v_e);
    v_res := rewrite_event_placings_under_field_lock(
      v_e, FALSE,
      jsonb_build_object(v_e1::TEXT, 1, v_e2::TEXT, 2),
      jsonb_build_object(v_e1::TEXT, 100, v_e2::TEXT, 75),
      '{}'::uuid[], v_snap);
    v_h_ok := COALESCE((v_res ->> 'ok')::BOOLEAN, FALSE);
    SELECT final_position, points INTO v_h_pos, v_h_pts FROM tournament_participants WHERE id = v_e1;
    SELECT status::TEXT INTO v_h_stat FROM tournament_events WHERE id = v_e;

    -- 2c-bis. THE ROW LOCK, OBSERVED, on an event this transaction has not
    --     touched. xmax is non-zero on a row the current transaction holds a
    --     lock on -- but v_m has been through two calls already, so its xmax is
    --     set before any third call and reading it would prove nothing. A fresh
    --     event is the only way the before/after pair means anything.
    INSERT INTO players (email, first_name) VALUES ('_f215c@invalid.test','RecC') RETURNING id INTO v_lk_p;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'completed') RETURNING id INTO v_lk_e;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_lk_e, v_lk_p, 'checked_in') RETURNING id INTO v_lk_e1;
    INSERT INTO tournament_matches (event_id, round_number, bracket_position, status,
                                    participant_a_id, winner_participant_id, is_bye)
      VALUES (v_lk_e, 1, 1, 'completed', v_lk_e1, v_lk_e1, TRUE) RETURNING id INTO v_lk_m;
    SELECT COALESCE(xmax::TEXT,'0') INTO v_lk_pre FROM tournament_matches WHERE id = v_lk_m;
    v_snap := event_results_fingerprint(v_lk_e);
    v_res := rewrite_event_placings_under_field_lock(
      v_lk_e, FALSE, jsonb_build_object(v_lk_e1::TEXT, 1),
      jsonb_build_object(v_lk_e1::TEXT, 100), '{}'::uuid[], v_snap);
    SELECT COALESCE(xmax::TEXT,'0') INTO v_lk_post FROM tournament_matches WHERE id = v_lk_m;

    -- 2d. A LIVE EVENT IS REFUSED. Placings on a live event would be written
    --     onto a field that can still change, and finalisation is the path for
    --     that.
    v_res := rewrite_event_placings_under_field_lock(
      v_live, FALSE, '{}'::jsonb, '{}'::jsonb, '{}'::uuid[], '{}'::jsonb);
    v_l_ref := v_res ->> 'reason';

    -- 2e. A CALL CARRYING NO SNAPSHOT IS A FAULT, not a write. Without this the
    --     fence is opt-out by omission.
    BEGIN
      v_res := rewrite_event_placings_under_field_lock(
        v_e, FALSE, '{}'::jsonb, '{}'::jsonb, '{}'::uuid[], NULL);
    EXCEPTION WHEN others THEN
      v_raised := TRUE;
    END;

    -- 2f. AN ID FROM ANOTHER EVENT MATCHES NO ROW AND RAISES, rather than
    --     silently writing nothing while the caller is told it succeeded.
    BEGIN
      v_snap := event_results_fingerprint(v_e);
      v_res := rewrite_event_placings_under_field_lock(
        v_e, FALSE, jsonb_build_object(gen_random_uuid()::TEXT, 1),
        '{}'::jsonb, '{}'::uuid[], v_snap);
    EXCEPTION WHEN others THEN
      v_x_raised := TRUE;
    END;

    RAISE EXCEPTION 'rollback probe 215';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback probe 215' THEN RAISE; END IF;
  END;

  IF v_c_ref IS DISTINCT FROM 'results_changed' THEN
    RAISE EXCEPTION '00215: a match voided under the caller was not refused (reason %)',
                    COALESCE(v_c_ref, 'none -- it wrote');
  END IF;
  IF v_c_move IS NULL THEN
    RAISE EXCEPTION '00215: the refusal did not name the match that moved';
  END IF;
  IF v_c_pos IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '00215: a refused call changed final_position to %', COALESCE(v_c_pos::TEXT,'NULL');
  END IF;

  IF NOT v_z_ok THEN
    RAISE EXCEPTION '00215: clearing the placings of an event with no champion was refused';
  END IF;
  IF v_z_pos IS NOT NULL OR v_z_pts IS NOT NULL THEN
    RAISE EXCEPTION '00215: the clear left position %, points % standing',
                    COALESCE(v_z_pos::TEXT,'NULL'), COALESCE(v_z_pts::TEXT,'NULL');
  END IF;

  IF NOT v_h_ok THEN
    RAISE EXCEPTION '00215: an unchanged event was refused, so the fence refuses everything';
  END IF;
  IF v_h_pos IS DISTINCT FROM 1 OR v_h_pts IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION '00215: the recompute wrote position %, points % -- expected 1, 100',
                    COALESCE(v_h_pos::TEXT,'NULL'), COALESCE(v_h_pts::TEXT,'NULL');
  END IF;
  IF v_h_stat IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION '00215: the recompute changed the event status to %', v_h_stat;
  END IF;

  IF v_l_ref IS DISTINCT FROM 'event_status' THEN
    RAISE EXCEPTION '00215: a live event accepted a placings rewrite (reason %)',
                    COALESCE(v_l_ref, 'none -- it wrote');
  END IF;

  IF NOT v_raised THEN
    RAISE EXCEPTION '00215: a call passing no results snapshot was accepted';
  END IF;
  IF NOT v_x_raised THEN
    RAISE EXCEPTION '00215: a placing for an id outside the event was accepted';
  END IF;

  IF v_lk_pre IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION '00215: the probe match was already locked before the call (xmax %) -- the observation below would prove nothing', v_lk_pre;
  END IF;
  IF v_lk_post IS NULL OR v_lk_post = '0' THEN
    RAISE EXCEPTION '00215: the rewrite left the match rows unlocked (xmax %) -- the fence is still a check', COALESCE(v_lk_post, 'NULL');
  END IF;

  RAISE NOTICE '00215 verified: a result that moved under the caller refuses by name and writes nothing, a champion-less event still clears, an unchanged one still writes and stays completed, a live event and a missing snapshot are both refused, and the call leaves the match rows locked (xmax 0 -> %)', v_lk_post;
END
$verify$;

NOTIFY pgrst, 'reload schema';
