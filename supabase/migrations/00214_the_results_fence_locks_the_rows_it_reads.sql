-- 00214  The results fence locks the rows it reads
--
-- 00213 added a re-read: finalisation snapshots every match result before it
-- computes the ladder, hands that snapshot to complete_event_under_field_lock,
-- and the function re-reads the same shape under the event's advisory lock and
-- refuses if it moved.
--
-- That re-read is a CHECK, not a FENCE, and the external review was right to
-- call it so. The advisory lock serialises only the writers that take it, and
-- the three paths that edit a recorded result do not take it -- they are plain
-- PostgREST UPDATEs on tournament_matches:
--
--   apps/admin/src/lib/tournament-actions/results.ts:1398  score correction
--   apps/admin/src/lib/tournament-actions/results.ts:756   void
--                                        (and the undo path alongside it)
--
-- Under READ COMMITTED the re-read does see anything an editor committed
-- BEFORE it -- that part works. What nothing stopped was an editor committing
-- AFTER the re-read and before this transaction's COMMIT. 00213 shrank that
-- window from several PostgREST round trips to microseconds; it did not close
-- it, and a window that small is worse than an honest one, because it will
-- present as a standings bug nobody can reproduce.
--
-- THE FIX is one statement, and it needs no change to results.ts:
--
--   PERFORM 1 FROM tournament_matches WHERE event_id = p_event_id
--     FOR NO KEY UPDATE;
--
-- FOR NO KEY UPDATE is precisely the row lock an ordinary UPDATE acquires, so
-- it conflicts with all three paths without their cooperation. Placed before
-- the open-match count and the fingerprint, it makes everything downstream a
-- read of rows this transaction holds.
--
-- WHY NOT SERIALISE THE EDITS INSTEAD. The audit offered that as the other
-- option: route every result edit through a function that takes the same
-- advisory lock. It is a larger change across several call sites, and it only
-- works if every future writer remembers to join in. The row lock is enforced
-- by the storage engine and covers writers that have never heard of it.
--
-- HONESTY ABOUT THE VERIFICATION. Every other guard on this branch was proved
-- by mutation: neuter it, watch a test go red. That method CANNOT prove a row
-- lock. A single-session DO block always acquires the lock; the in-memory test
-- harness models no contention at all; delete the line below and the verifier
-- here and all three suites stay green. Recording this as "mutation-tested"
-- would be exactly the vacuous verification the rest of this branch exists to
-- remove.
--
-- The real evidence is a two-session test run by hand on staging, kept in
-- docs/sensitive/ alongside this migration: session 1 holds an open
-- transaction that has UPDATEd a match; session 2 calls this function with a
-- pre-update snapshot and must BLOCK rather than return; session 1 commits;
-- session 2 unblocks and returns reason 'results_changed' with the event still
-- live. Then the same pair with this line removed, where session 2 does not
-- block and completes with stale standings. The source assertion in the
-- verifier below is a regression tripwire for a future rewrite that drops the
-- line -- it is not, and must not be read as, proof that the lock works.
--
-- THE ONE THING A ROW LOCK CANNOT DO is block an INSERT of a new match; it
-- locks rows, not the range. That is covered in practice because every match
-- insert in the app stamps draw_generation_id (brackets.ts:1013, :1391, :1919)
-- and trg_tournament_match_generation takes the advisory lock for any stamped
-- insert. An unstamped insert would return early from that trigger and take no
-- lock -- there is no such caller today, and the open-match count now runs
-- under the row lock, so a new OPEN match would still be refused.

DROP FUNCTION IF EXISTS public.complete_event_under_field_lock(uuid, boolean, uuid[], uuid[], jsonb, jsonb, uuid[], jsonb);

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

  -- THE MATCH ROWS THEMSELVES, LOCKED (00214). Everything above this line is
  -- fenced by the advisory lock, and an advisory lock only serialises writers
  -- that take it. The three result-editing paths do not: a score correction
  -- (results.ts enterMatchResult), a void and an undo all reach
  -- tournament_matches as plain PostgREST UPDATEs, each its own transaction,
  -- none of them calling a function that takes hashtext('tournament_event_field').
  -- So 00213's re-read below was a check, not a fence -- an editor could commit
  -- in the window between it and this transaction's COMMIT, and the standings
  -- would be written from the result it replaced.
  --
  -- FOR NO KEY UPDATE is exactly the lock mode an ordinary UPDATE takes on a
  -- row, so it conflicts with those three paths whether or not they know this
  -- lock exists:
  --
  --   editor already in flight -> this blocks until it commits, then the
  --     re-read below sees the NEW result and refuses;
  --   editor arrives afterwards -> it blocks until this commits, so the
  --     snapshot this finalised from is the one that was true.
  --
  -- NO KEY rather than plain UPDATE because the placings only need to exclude
  -- writers, not foreign-key referencers; and no NOWAIT, because blocking for a
  -- moment is the whole mechanism -- NOWAIT would turn a clean 'results_changed'
  -- refusal into a hard error the desk cannot read.
  --
  -- Taken BEFORE the open-match count, not just before the fingerprint, so a
  -- match inserted concurrently is counted under the lock too.
  --
  -- LOCK ORDER. This transaction takes: advisory -> tournament_events row ->
  -- tournament_matches rows -> tournament_participants/tournament_pairs rows.
  -- A deadlock needs some other transaction holding an entry row and then
  -- waiting on a match row. apply_tournament_match_rating and
  -- reverse_tournament_match_rating both take FOR UPDATE on their match as
  -- their FIRST statement, before touching tournament_participants, so they
  -- order the same way and cannot cycle. Every other function that writes both
  -- tables takes the advisory lock first and is therefore serialised with this
  -- one wholesale. The one exception is merge_players, which updates entries
  -- and then matches again late in its run; an admin merging two members at the
  -- exact moment an event is finalised can deadlock. Postgres detects that and
  -- aborts one side with 40P01 -- both are single transactions, so the loser
  -- rolls back whole. That is a clean, rare, self-announcing failure and is
  -- accepted rather than papered over.
  PERFORM 1 FROM tournament_matches WHERE event_id = p_event_id FOR NO KEY UPDATE;

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
  -- row-lock probe (00214)
  v_lk_e   UUID; v_lk_p1 UUID; v_lk_p2 UUID; v_lk_m UUID;
  v_lk_pre TEXT; v_lk_post TEXT;
BEGIN
  -- 1. The 7-argument form is GONE, not merely shadowed. An overload left in
  --    place would let an un-redeployed caller complete an event by the route
  --    that never re-reads the results, which is the failure being closed.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock';
  IF v_n <> 1 THEN
    RAISE EXCEPTION '00214: expected exactly one complete_event_under_field_lock, found %', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND pg_get_function_identity_arguments(p.oid) =
           'p_event_id uuid, p_is_pair boolean, p_field uuid[], p_won uuid[], p_positions jsonb, p_points jsonb, p_clear uuid[], p_results jsonb')
  THEN
    RAISE EXCEPTION '00214: the surviving overload is not the 8-argument form';
  END IF;

  -- 2. Grants on BOTH functions, and the field key. The snapshot reads match
  --    data as SECURITY DEFINER, so it is held to the same rule as the flip.
  IF has_function_privilege('anon', 'public.complete_event_under_field_lock(uuid,boolean,uuid[],uuid[],jsonb,jsonb,uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '00214: anon can execute the completion flip';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_event_under_field_lock(uuid,boolean,uuid[],uuid[],jsonb,jsonb,uuid[],jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '00214: service_role cannot execute the completion flip';
  END IF;
  IF has_function_privilege('anon', 'public.event_results_fingerprint(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.event_results_fingerprint(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00214: the results snapshot is executable by a browser role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.event_results_fingerprint(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00214: service_role cannot execute the results snapshot';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' IN p.prosrc) > 0)
  THEN
    RAISE EXCEPTION '00214: the completion flip no longer takes the field key';
  END IF;
  -- The row lock, as a REGRESSION TRIPWIRE only. Matched as the WHOLE
  -- statement, not the bare phrase: prosrc includes the function's own
  -- comments, which discuss FOR NO KEY UPDATE at length, so a phrase match
  -- passes with the statement deleted. Mutation testing caught exactly that
  -- here -- the first version of this check was vacuous. It catches a future rewrite
  -- that drops the line; it is not evidence that the lock works, and probe 3f
  -- below is what actually observes it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND position('PERFORM 1 FROM tournament_matches WHERE event_id = p_event_id FOR NO KEY UPDATE;' IN p.prosrc) > 0)
  THEN
    RAISE EXCEPTION '00214: the completion flip no longer locks the match rows it reads';
  END IF;
  -- ...and it has to come BEFORE both reads, or it fences nothing they saw.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='complete_event_under_field_lock'
       AND position('PERFORM 1 FROM tournament_matches WHERE event_id = p_event_id FOR NO KEY UPDATE;' IN p.prosrc)
           < position('event_results_fingerprint(p_event_id)' IN p.prosrc)
       AND position('PERFORM 1 FROM tournament_matches WHERE event_id = p_event_id FOR NO KEY UPDATE;' IN p.prosrc)
           < position('INTO v_open FROM tournament_matches' IN p.prosrc))
  THEN
    RAISE EXCEPTION '00214: the row lock is taken after the reads it is supposed to fence';
  END IF;

  -- 3. THE BEHAVIOUR. A fence that refuses everything and a fence that refuses
  --    nothing both pass any single direction, so all four run.
  BEGIN
    INSERT INTO players (email, first_name) VALUES ('_f214a@invalid.test','ResA') RETURNING id INTO v_p1;
    INSERT INTO players (email, first_name) VALUES ('_f214b@invalid.test','ResB') RETURNING id INTO v_p2;
    INSERT INTO tournaments (name, start_date) VALUES ('_f214 probe', CURRENT_DATE) RETURNING id INTO v_t;
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

    -- 3f. THE LOCK IS ACTUALLY TAKEN, observed rather than grepped. A row held
    --     by FOR NO KEY UPDATE carries the locking transaction in its xmax; an
    --     untouched tuple carries 0. Reading xmax either side of one call is
    --     the only way a single session can see a row lock at all -- it cannot
    --     see the blocking, which is why the two-session staging transcript in
    --     docs/sensitive/ is the real evidence and this is a floor under it.
    INSERT INTO players (email, first_name) VALUES ('_f214lk1@invalid.test','LkA') RETURNING id INTO v_lk_p1;
    INSERT INTO players (email, first_name) VALUES ('_f214lk2@invalid.test','LkB') RETURNING id INTO v_lk_p2;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'live') RETURNING id INTO v_lk_e;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_lk_e, v_lk_p1, 'checked_in') RETURNING id INTO v_e1;
    INSERT INTO tournament_participants (event_id, player_id, status)
      VALUES (v_lk_e, v_lk_p2, 'checked_in') RETURNING id INTO v_e2;
    INSERT INTO tournament_matches (event_id, round_number, bracket_position, status,
                                    participant_a_id, participant_b_id,
                                    winner_participant_id, loser_participant_id, scores)
      VALUES (v_lk_e, 1, 1, 'completed', v_e1, v_e2, v_e1, v_e2, '[{"a":21,"b":15}]'::jsonb)
      RETURNING id INTO v_lk_m;
    SELECT xmax::TEXT INTO v_lk_pre FROM tournament_matches WHERE id = v_lk_m;
    v_snap := event_results_fingerprint(v_lk_e);
    PERFORM complete_event_under_field_lock(
      v_lk_e, FALSE, ARRAY[v_e1, v_e2], ARRAY[v_e1],
      jsonb_build_object(v_e1::TEXT, 1, v_e2::TEXT, 2),
      jsonb_build_object(v_e1::TEXT, 100, v_e2::TEXT, 75), '{}'::uuid[], v_snap);
    SELECT xmax::TEXT INTO v_lk_post FROM tournament_matches WHERE id = v_lk_m;

    RAISE EXCEPTION 'rollback probe 214';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback probe 214' THEN RAISE; END IF;
  END;

  IF v_zero IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION '00214: an event with no matches snapshots as % -- a null there disables the fence', COALESCE(v_zero::TEXT, 'NULL');
  END IF;

  IF v_c_ref IS DISTINCT FROM 'results_changed' THEN
    RAISE EXCEPTION '00214: a corrected match result was not refused (reason %)',
                    COALESCE(v_c_ref, 'none -- it completed');
  END IF;
  IF v_c_move IS NULL THEN
    RAISE EXCEPTION '00214: the refusal did not name the match that moved';
  END IF;
  IF v_c_pos IS NOT NULL THEN
    RAISE EXCEPTION '00214: a refused call still wrote final_position %', v_c_pos;
  END IF;
  IF v_c_stat IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION '00214: a refused call moved the event to %', v_c_stat;
  END IF;

  IF v_v_ref IS DISTINCT FROM 'results_changed' THEN
    RAISE EXCEPTION '00214: voiding a settled match mid-finalisation was not refused (reason %)',
                    COALESCE(v_v_ref, 'none -- it completed');
  END IF;
  IF v_v_pos IS NOT NULL THEN
    RAISE EXCEPTION '00214: the voided-match refusal still wrote final_position %', v_v_pos;
  END IF;

  IF NOT v_raised THEN
    RAISE EXCEPTION '00214: a call passing no results snapshot was accepted';
  END IF;

  IF NOT v_h_ok THEN
    RAISE EXCEPTION '00214: an unchanged event was refused, so the fence refuses everything';
  END IF;
  IF v_h_pos IS DISTINCT FROM 1 OR v_h_pts IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION '00214: the champion finished with position %, points % -- expected 1, 100', v_h_pos, v_h_pts;
  END IF;
  IF v_h_stat IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION '00214: the event did not complete (status %)', v_h_stat;
  END IF;

  IF v_lk_pre IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION '00214: the probe match was already locked before the call (xmax %) -- the observation below would prove nothing', v_lk_pre;
  END IF;
  IF v_lk_post IS NULL OR v_lk_post = '0' THEN
    RAISE EXCEPTION '00214: the completion flip left the match row unlocked (xmax %) -- the fence is still a check', COALESCE(v_lk_post, 'NULL');
  END IF;

  RAISE NOTICE '00214 verified: one 8-argument overload; a corrected result and a voided match both refuse by name and write nothing, a missing snapshot is a fault, and an unchanged event still finalises; and the flip leaves the match rows locked (xmax 0 -> %), taken before both reads', v_lk_post;
END
$verify$;

NOTIFY pgrst, 'reload schema';

