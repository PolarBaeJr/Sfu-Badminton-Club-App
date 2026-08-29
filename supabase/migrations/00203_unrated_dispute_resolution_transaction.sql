-- 00203: one transaction for the unrated dispute resolutions (F-002 residual)
--
-- THE FINDING. Void and Convert-to-casual are each three or four separate
-- round trips from the admin server: read the match, mutate it, write the
-- note, write the audit row — and, when they are reached through a dispute,
-- close the dispute afterwards. Every gap between those trips is a place the
-- request can die, and each one leaves a different partial state:
--
--   died after the mutation      the match is changed with NO audit row saying
--                                who changed it or why. The one thing the
--                                console cannot reconstruct afterwards.
--   died after the audit row     the dispute stays open against a match that
--                                has already been dealt with.
--
-- 00188 and 00192 made that survivable rather than correct: the dispute claim
-- bound the retry to one actor and one resolution, and convertMatchToCasual
-- grew four arms so a retry could tell how much of the conversion had already
-- landed. Those arms are still right, and they are carried over here verbatim
-- — prod holds rows in every one of those states. What changes is that they
-- stop being the ONLY defence, because there is no longer a window for a new
-- row to land in one.
--
-- WHAT MOVES. The whole of voidMatch, the whole of convertMatchToCasual, and
-- the unrated half of resolveDispute become three SQL functions. One
-- transaction each. The match mutation, the admin note and the audit row
-- commit together or not at all, and the dispute close joins them when the
-- caller came in through a dispute.
--
-- WHY THE ROW LOCK REPLACES THE CLAIM. claim_dispute_for_resolution existed to
-- stop a second admin starting the other resolution while the first was
-- mid-flight, across a gap that no longer exists: the dispute is held FOR
-- UPDATE from before the status is read until the transaction ends. A second
-- admin now blocks on that lock and finds status = 'resolved' when it clears,
-- which is the same answer the claim gave, taken at the only moment it can be
-- taken correctly.
--
-- It is left in the database, uncalled. Dropping a signature the running image
-- still references is what made 00200 order-fragile, and this migration must
-- be applicable before the image that stops calling it.
--
-- COST, STATED PLAINLY. held_by_other and type_conflict lose their bespoke
-- messages. A second admin used to be told "Another admin is resolving this
-- dispute right now"; they are now told it is already resolved, because by the
-- time they are told anything, it is. The type_conflict message existed to
-- warn that a mutation might have landed under a different resolution — a
-- state that this migration makes unreachable.
--
-- LOCK ORDER: disputes -> matches, the same order resolve_dispute_rated
-- already takes (00193). Nothing here locks in the other direction.
--
-- Neither reverse_match_result nor apply_match_result writes to disputes, so
-- nesting them under a held dispute lock cannot deadlock against it or
-- overwrite the close below. Both of apply_match_result's participant guards
-- are gated on auth.uid() IS NOT NULL and these functions are reached only by
-- service_role, exactly as the TypeScript that called it directly was.

BEGIN;

-- ============================================================================
-- void_club_match
-- ============================================================================
--
-- The club Void, not the tournament one. tournaments/results.ts has its own
-- voidMatch behind tournaments.results.void.write; it is a different table and
-- is not in scope here.

CREATE OR REPLACE FUNCTION public.void_club_match(
  p_match_id uuid,
  p_actor_id uuid,
  p_reason   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match matches;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF v_match IS NULL THEN
    RAISE EXCEPTION 'Match not found';
  END IF;

  -- Only a confirmed match has Elo applied. A disputed or pending match never
  -- applied any, and reverse_match_result RAISEs on anything but confirmed —
  -- so the guard is load-bearing, not defensive.
  IF v_match.result_status = 'confirmed' THEN
    PERFORM reverse_match_result(p_match_id);
  END IF;

  -- reverse_match_result already sets 'voided' on the path above. Repeated
  -- unconditionally because the other paths reach here without it.
  UPDATE matches SET result_status = 'voided', updated_at = NOW() WHERE id = p_match_id;

  -- `admin_note` on the match row is deliberately NOT written: it moved to
  -- match_admin_notes in 00117 because every signed-in member could read it
  -- off the match row and, since 00114, receive it over Realtime.
  --
  -- This throws if it fails, and that is the change. The TypeScript it
  -- replaces could not throw here — the void was already committed by this
  -- point, so a throw would have skipped the audit row and left an UNAUDITED
  -- VOID. In one transaction that reasoning inverts: a throw takes the void
  -- with it, and there is no partial state left to be honest about.
  INSERT INTO match_admin_notes (match_id, note, author_id, updated_at)
  VALUES (p_match_id, p_reason, p_actor_id, NOW())
  ON CONFLICT (match_id) DO UPDATE
    SET note       = EXCLUDED.note,
        author_id  = EXCLUDED.author_id,
        updated_at = NOW();

  -- note_recorded is kept in the payload because rows written before this
  -- migration carry it and the shape should not fork. It is now always true:
  -- if this row is visible, the note beside it is too.
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (p_actor_id, 'match_voided', 'match', p_match_id,
          jsonb_build_object('note_recorded', true), p_reason);

  RETURN jsonb_build_object('ok', true, 'note_recorded', true);
END;
$function$;

-- ============================================================================
-- convert_club_match_to_casual
-- ============================================================================

CREATE OR REPLACE FUNCTION public.convert_club_match_to_casual(
  p_match_id uuid,
  p_actor_id uuid,
  p_reason   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match         matches;
  v_flags_written boolean;
  v_settled       boolean;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id FOR UPDATE;
  IF v_match IS NULL THEN
    RAISE EXCEPTION 'Match not found';
  END IF;

  -- THE BRANCH KEYS ON HOW MUCH OF THE CONVERSION HAS ALREADY LANDED, NOT ON
  -- result_status ALONE. Transcribed arm for arm from convertMatchToCasualImpl,
  -- because prod holds rows in each of these states and this function is now
  -- the only thing that can move them.
  --
  -- Branching on live result_status alone was the 00192 trap: a retry of a
  -- conversion that had reached 'confirmed' would read 'confirmed' and take
  -- the reversal path, ending with the dispute closed as converted_to_casual
  -- against a voided match with the rating reversed back out.
  --
  -- The single transaction does NOT make these arms redundant. It closes the
  -- window for NEW partial rows; it does nothing for the ones already there.
  v_flags_written := (v_match.event_type = 'casual' AND v_match.rated_flag = false);
  v_settled       := (v_match.result_status IN ('confirmed', 'voided'));

  IF v_flags_written AND v_settled THEN
    -- Already all the way there. Falls through to the note and the audit row,
    -- which are what the failed attempt never reached — hence not a RETURN.
    NULL;

  ELSIF v_match.result_status = 'voided' THEN
    -- Elo already reversed, by an earlier attempt of this conversion or by a
    -- prior void. Only the classification is missing. Re-confirming here would
    -- double head-to-head.
    UPDATE matches
       SET rated_flag = false, event_type = 'casual', updated_at = NOW()
     WHERE id = p_match_id;

  ELSIF v_match.result_status = 'confirmed' THEN
    -- Elo was applied. Reverse it — which also marks the match voided. The
    -- "voided + casual flags" outcome for an already-confirmed match is kept
    -- deliberately, to avoid re-firing the on_match_confirmed stats trigger.
    PERFORM reverse_match_result(p_match_id);
    UPDATE matches
       SET rated_flag = false, event_type = 'casual', updated_at = NOW()
     WHERE id = p_match_id;

  ELSE
    -- Never confirmed (disputed / pending): no Elo yet. Record it as a
    -- completed casual match. apply_match_result skips Elo for event_type
    -- 'casual' but still confirms the result and updates head-to-head once.
    --
    -- A match that was ALWAYS casual and is only now being disputed reaches
    -- here rather than the first arm: its flags are written but it is not
    -- settled, so it still needs confirming.
    UPDATE matches
       SET rated_flag    = false,
           event_type    = 'casual',
           result_status = 'pending_confirmation',
           updated_at    = NOW()
     WHERE id = p_match_id;

    PERFORM apply_match_result(p_match_id, p_actor_id);
  END IF;

  -- One write for every arm — the exec typed one reason and there is one place
  -- it belongs. See void_club_match for why this may now throw.
  INSERT INTO match_admin_notes (match_id, note, author_id, updated_at)
  VALUES (p_match_id, p_reason, p_actor_id, NOW())
  ON CONFLICT (match_id) DO UPDATE
    SET note       = EXCLUDED.note,
        author_id  = EXCLUDED.author_id,
        updated_at = NOW();

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (p_actor_id, 'match_converted_casual', 'match', p_match_id,
          jsonb_build_object('note_recorded', true), p_reason);

  RETURN jsonb_build_object('ok', true, 'note_recorded', true);
END;
$function$;

-- ============================================================================
-- resolve_dispute_unrated
-- ============================================================================
--
-- The counterpart to resolve_dispute_rated (00193), for the two resolutions
-- that apply no rating. It CALLS the two functions above rather than
-- duplicating them, so there is exactly one implementation of Void and one of
-- Convert whether the operator reached it from /disputes or from /matches.

CREATE OR REPLACE FUNCTION public.resolve_dispute_unrated(
  p_dispute_id      uuid,
  p_actor_id        uuid,
  p_resolution_type dispute_resolution,
  p_resolution_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_dispute disputes;
BEGIN
  IF p_resolution_type NOT IN ('voided', 'converted_to_casual') THEN
    RAISE EXCEPTION 'resolve_dispute_unrated handles voided and converted_to_casual only, not %', p_resolution_type;
  END IF;

  -- The note is the reason of record for both the match note and the audit
  -- row, and neither column is worth writing empty.
  IF p_resolution_note IS NULL OR btrim(p_resolution_note) = '' THEN
    RAISE EXCEPTION 'A resolution note is required';
  END IF;

  SELECT * INTO v_dispute FROM disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'Dispute not found';
  END IF;

  -- THE IDEMPOTENCE KEY, read through the row lock before anything is written,
  -- exactly as resolve_dispute_rated reads it. This is what replaces
  -- claim_dispute_for_resolution: a second operator blocks here rather than
  -- racing to claim, and finds the work done.
  IF v_dispute.status = 'resolved' THEN
    RETURN jsonb_build_object('applied', false, 'already_resolved', true);
  END IF;

  IF p_resolution_type = 'voided' THEN
    PERFORM void_club_match(v_dispute.match_id, p_actor_id, p_resolution_note);
  ELSE
    PERFORM convert_club_match_to_casual(v_dispute.match_id, p_actor_id, p_resolution_note);
  END IF;

  -- No claimed_by fence on this UPDATE. The fence existed because the close
  -- was a separate round trip that could outlive a 15 minute claim TTL; the
  -- row lock taken above is held until this transaction commits, so there is
  -- no second writer to fence against.
  -- The claim fields are CLEARED, not just left behind. Two reasons, and the
  -- second is a live defect and not hygiene:
  --
  --   1. A resolved dispute that still carries claimed_resolution_type = X
  --      while resolution_type = Y is a row that contradicts itself for
  --      anybody reading it later.
  --
  --   2. During the rolling deploy this is a correctness fence. The OLD image
  --      closes the dispute from TypeScript with `.eq('claimed_by', admin.id)`.
  --      Sequence: old-image admin A claims (status -> under_review,
  --      claimed_by = A) and stalls mid-void; new-image admin B calls this
  --      function, takes the row lock, sees under_review, converts the match
  --      to casual and closes. A's stale close then runs — and if claimed_by
  --      were still A it would MATCH, silently overwriting resolution_type
  --      with A's. The dispute would then name a resolution that is not what
  --      happened to the match. Clearing claimed_by makes A's update match
  --      zero rows, which is A's existing ExpectedError ("took too long ...
  --      picked up by another admin") — the accurate message.
  --
  -- This does NOT fix the double MATCH mutation in that same window: A's void
  -- already committed before its close was refused. That remains a deploy
  -- constraint of the same shape as F-005 — drain the old image before
  -- applying — and the runbook is what carries it, not this function.
  UPDATE disputes
     SET status                  = 'resolved',
         resolution_type         = p_resolution_type,
         resolution_note         = p_resolution_note,
         resolved_by             = p_actor_id,
         resolved_at             = NOW(),
         claimed_by              = NULL,
         claimed_at              = NULL,
         claimed_resolution_type = NULL,
         updated_at              = NOW()
   WHERE id = p_dispute_id;

  -- Written HERE and not by the caller, which is the F-002 point: the dispute
  -- resolution is audited in the same transaction that performs it. The
  -- rated path still writes its dispute_resolved row from TypeScript — that
  -- asymmetry is real and deliberate, and it is recorded rather than papered
  -- over: this migration is scoped to the unrated pair.
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, new_value, reason)
  VALUES (p_actor_id, 'dispute_resolved', 'dispute', p_dispute_id,
          jsonb_build_object('resolution_type', p_resolution_type), p_resolution_note);

  RETURN jsonb_build_object('applied', true, 'already_resolved', false);
END;
$function$;

-- ============================================================================
-- Grants
-- ============================================================================
--
-- service_role only. All three take an actor id as a parameter and enforce no
-- capability of their own — the console's requireCapability gates
-- ('matches.void.write', 'matches.convert.write', 'disputes.resolve.write')
-- remain the authorisation boundary, so an anon- or authenticated-executable
-- form of any of these would be a self-service void.

REVOKE ALL ON FUNCTION public.void_club_match(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.convert_club_match_to_casual(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_dispute_unrated(uuid, uuid, dispute_resolution, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.void_club_match(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.convert_club_match_to_casual(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_dispute_unrated(uuid, uuid, dispute_resolution, text) TO service_role;

-- ============================================================================
-- Verify
-- ============================================================================
--
-- A CENSUS, NOT A FRAGMENT GREP. Codex rejected the fragment form in round 9
-- for good reason: "this string appears somewhere in the file" survives almost
-- any mutation that matters. Every row below states the FULL expected count of
-- a construct across a whole function body, so a duplicated audit insert, a
-- dropped note write, a lost row lock, or an extra call to the Elo machinery
-- each fail a specific number rather than sliding past a boolean.
--
-- The four conversion arms are NOT asserted here. Arm SELECTION is behaviour,
-- and a structural count cannot tell a correct arm from a transposed one; it
-- is covered by the staging harness that walks a real match through each of
-- the four partial states.

DO $verify$
DECLARE
  r        RECORD;
  v_def    TEXT;
  v_count  INTEGER;
  v_sig    TEXT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- proname,                       args,                              lock, note, audit, reverse, apply
      ('void_club_match',               'uuid, uuid, text',                   1,    1,     1,       1,     0),
      ('convert_club_match_to_casual',  'uuid, uuid, text',                   1,    1,     1,       1,     1),
      ('resolve_dispute_unrated',       'uuid, uuid, dispute_resolution, text', 1,  0,     1,       0,     0)
    ) AS t(proname, args, n_lock, n_note, n_audit, n_reverse, n_apply)
  LOOP
    v_sig := 'public.' || r.proname || '(' || r.args || ')';

    -- Exactly one function of this name: an accidental overload would leave
    -- PostgREST resolving the call by argument shape rather than by intent.
    SELECT COUNT(*) INTO v_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.proname;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '00203: expected exactly 1 % , found %', r.proname, v_count;
    END IF;

    v_def := pg_get_functiondef(v_sig::regprocedure);

    v_count := (SELECT COUNT(*) FROM regexp_matches(v_def, 'FOR UPDATE', 'g'));
    IF v_count <> r.n_lock THEN
      RAISE EXCEPTION '00203: % takes % row locks, expected %', r.proname, v_count, r.n_lock;
    END IF;

    v_count := (SELECT COUNT(*) FROM regexp_matches(v_def, 'INSERT INTO match_admin_notes', 'g'));
    IF v_count <> r.n_note THEN
      RAISE EXCEPTION '00203: % writes % match notes, expected %', r.proname, v_count, r.n_note;
    END IF;

    v_count := (SELECT COUNT(*) FROM regexp_matches(v_def, 'INSERT INTO audit_logs', 'g'));
    IF v_count <> r.n_audit THEN
      RAISE EXCEPTION '00203: % writes % audit rows, expected %', r.proname, v_count, r.n_audit;
    END IF;

    v_count := (SELECT COUNT(*) FROM regexp_matches(v_def, 'PERFORM reverse_match_result', 'g'));
    IF v_count <> r.n_reverse THEN
      RAISE EXCEPTION '00203: % calls reverse_match_result % times, expected %', r.proname, v_count, r.n_reverse;
    END IF;

    v_count := (SELECT COUNT(*) FROM regexp_matches(v_def, 'PERFORM apply_match_result', 'g'));
    IF v_count <> r.n_apply THEN
      RAISE EXCEPTION '00203: % calls apply_match_result % times, expected %', r.proname, v_count, r.n_apply;
    END IF;

    -- SECURITY DEFINER with a pinned search_path, or the function runs as the
    -- caller and the grant census below means nothing.
    IF NOT (v_def LIKE '%SECURITY DEFINER%') THEN
      RAISE EXCEPTION '00203: % is not SECURITY DEFINER', r.proname;
    END IF;
    IF NOT (v_def LIKE '%search_path%') THEN
      RAISE EXCEPTION '00203: % has no pinned search_path', r.proname;
    END IF;

    -- GRANT CENSUS. Reading proacl directly rather than
    -- information_schema.role_table_grants, which reports grants that do not
    -- exist. A NULL proacl is the default-privileges case and means PUBLIC
    -- holds EXECUTE — the most dangerous outcome, so it is named, not skipped.
    IF (SELECT proacl FROM pg_proc WHERE oid = v_sig::regprocedure) IS NULL THEN
      RAISE EXCEPTION '00203: % has default privileges, so PUBLIC can execute it', r.proname;
    END IF;
    IF has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '00203: anon can execute %', r.proname;
    END IF;
    IF has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '00203: authenticated can execute %', r.proname;
    END IF;
    IF NOT has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '00203: service_role cannot execute %', r.proname;
    END IF;
  END LOOP;

  -- The dispute entry point must reach BOTH match functions, or one resolution
  -- silently does the other one's work.
  v_def := pg_get_functiondef('public.resolve_dispute_unrated(uuid, uuid, dispute_resolution, text)'::regprocedure);
  IF v_def NOT LIKE '%PERFORM void_club_match%' THEN
    RAISE EXCEPTION '00203: resolve_dispute_unrated never calls void_club_match';
  END IF;
  IF v_def NOT LIKE '%PERFORM convert_club_match_to_casual%' THEN
    RAISE EXCEPTION '00203: resolve_dispute_unrated never calls convert_club_match_to_casual';
  END IF;

  -- The close must CLEAR the claim, not merely stop reading it. All three
  -- fields, because the old image's close fences on claimed_by and anybody
  -- reading the row later reads claimed_resolution_type. A grep for the
  -- assignment, not for the column name: the column name appears in the
  -- comment above the UPDATE either way.
  IF v_def !~ 'claimed_by\s*=\s*NULL' THEN
    RAISE EXCEPTION '00203: the dispute close does not clear claimed_by, so a stale old-image close still matches it';
  END IF;
  IF v_def !~ 'claimed_at\s*=\s*NULL' THEN
    RAISE EXCEPTION '00203: the dispute close does not clear claimed_at';
  END IF;
  IF v_def !~ 'claimed_resolution_type\s*=\s*NULL' THEN
    RAISE EXCEPTION '00203: the dispute close does not clear claimed_resolution_type, so a resolved row can contradict itself';
  END IF;

  -- Left in place on purpose. The running image still calls it, and this
  -- migration has to be applicable before that image is replaced.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'claim_dispute_for_resolution'
  ) THEN
    RAISE EXCEPTION '00203: claim_dispute_for_resolution was dropped; the deployed image still calls it';
  END IF;

  RAISE NOTICE '00203 verify: 3 functions, locks/notes/audits/callees and grants all as specified';
END;
$verify$;

-- Three new functions PostgREST has never seen. Without this the console's
-- first call to any of them 404s until the cache happens to refresh.
NOTIFY pgrst, 'reload schema';

COMMIT;
