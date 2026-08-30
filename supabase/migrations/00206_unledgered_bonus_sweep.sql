-- 00206 — the post-cutover sweep for un-ledgered placement bonuses (F-003)
--
-- WHAT THIS IS FOR
--
-- F-003 says durable placement-bonus idempotency is a SEV-1 requirement, and
-- codex ruled 00190 NOT RESOLVED because it bounds "already paid" by comparing
-- tournament_events.updated_at against schema_migrations.applied_at for 00188.
-- Both halves of that comparison are the wrong quantity: applied_at is when the
-- DATABASE changed, not when ledger-aware application code deployed, and
-- updated_at is mutable (a draw-lock action bumps it with no completed-status
-- guard). 00191 already closed the third half, the nullable case.
--
-- THE PART OF THE RULING THAT REWRITING THE PREDICATE CANNOT FIX
--
-- 00189, 00190 and 00191 are one-shot backfills that run in Step 1 of the
-- cutover. The sequence codex describes -- old code pays an event, its
-- best-effort audit insert fails, so nothing records the payment -- happens at
-- T1 AFTER those backfills have already run. No predicate inside them can mark
-- an event that is paid after they finish. Sharpening the cutoff would have
-- been motion without effect.
--
-- What actually covers that window is a sweep that runs AFTER the last old
-- container is gone. That is this function, and Step 3b of
-- docs/sensitive/PROD-CUTOVER-00177-00205.md is where it is sequenced.
--
-- 00191's header rejected "a re-runnable reconciliation function" because a
-- mechanism an operator has to remember to fire lets a migration CLAIM a
-- closure it does not have. That objection is respected here rather than
-- overridden: this file claims nothing. The function does not close F-003 by
-- existing. The runbook step closes it by running, and the function is written
-- to report what it did so that a step which was skipped is visible as an empty
-- result rather than invisible as a silent success.
--
-- MEASURED ON A FRESH PROD SNAPSHOT, 2026-08-29
--
-- Staging was restored from prod by the 04:00 refresh and then had 00177-00205
-- applied to it in order -- which is exactly the prod cutover. On that tree:
--
--   completed + bonus_enabled events   2
--   legacy markers present             2
--   per-subject grant rows             0
--   this sweep would newly mark        0
--   events with updated_at >= cutoff   0
--
-- The last line is why the cutoff has never actually excluded anything on a
-- prod-shaped database: 00188 is applied during the cutover, so every event
-- that already exists is below it. The cutoff's weakness is real but it only
-- bites on a host where 00188 landed long before the code did. The sweep
-- marking zero rows there is the point -- it means adopting the unbounded rule
-- moves no data, and changes only what the rule IS.

-- WHEN IT IS CORRECT TO RUN THIS, WHICH IS NARROWER THAN IT LOOKS
--
-- Only in the drained cutover window: after the last pre-ledger admin container
-- is gone and before draws are unlocked. That is the ONLY moment when "no
-- per-subject grants" reliably means "paid by code that could not record it".
--
-- Afterwards the rule stops being safe, because a legitimate bonus pass that
-- awards ZERO bonuses also writes no grant rows and is indistinguishable from a
-- legacy payment. Running the sweep then permanently marks those events as
-- already-paid and every later bonus pass on them is silently refused.
--
-- The function's whole safety argument is "nobody calls it except at cutover" --
-- there is no scheduled caller and no application caller, and nothing in the
-- database enforces that. So, for whoever finds this later and thinks it looks
-- like a way to check bonus state: it is not a query. It writes, and what it
-- writes is not meant to be undone by anything except a human deleting rows by
-- hand. Read the state instead -- SELECT from tournament_bonus_grants.

BEGIN;

-- The sweep. No timestamp anywhere: an event that is completed, has bonuses
-- enabled, and carries no per-subject grant at all is an event whose payment
-- state cannot be proven from data. For an irreversible rating movement,
-- "cannot prove it was not paid" has to be answered the same way as "assume it
-- was" -- a false refusal is recoverable by a human deleting one row, and a
-- false negative doubles every bonus on the event.
CREATE OR REPLACE FUNCTION public.sweep_unledgered_bonus_events()
-- The OUT parameters are deliberately NOT called event_id/event_name. A plpgsql
-- OUT parameter is an ordinary variable everywhere in the body, so `event_id`
-- would collide with the column of the same name in the INSERT's ON CONFLICT
-- target list and the whole function fails to plan with "column reference
-- event_id is ambiguous".
RETURNS TABLE (marked_event_id uuid, marked_event_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- NOT A QUERY. This writes, and it is only correct inside the cutover window
  -- when no pre-ledger container is still running. Outside that window it marks
  -- legitimately zero-bonus events as already-paid, and every later bonus pass
  -- on them is refused. See the migration header before invoking it by hand.
  RETURN QUERY
  WITH marked AS (
    INSERT INTO public.tournament_bonus_grants
      (event_id, kind, subject_id, requested_bonus, applied_delta, granted_at)
    SELECT e.id, 'event_legacy_paid', e.id, 0, 0, NOW()
      FROM public.tournament_events e
     WHERE e.status = 'completed'
       AND e.placement_bonus_enabled
       AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bonus_grants g
              WHERE g.event_id = e.id
                AND g.kind IN ('rating', 'participant_credit')
           )
    -- Idempotent: re-running is how an operator confirms the sweep is quiet,
    -- and it must not error on the events a previous run already marked.
    ON CONFLICT (event_id, kind, subject_id) DO NOTHING
    RETURNING tournament_bonus_grants.event_id AS id
  )
  -- tournament_events has no name column; event_type is what identifies an
  -- event to a human reading the sweep's output.
  SELECT m.id, e.event_type::text
    FROM marked m
    JOIN public.tournament_events e ON e.id = m.id
   ORDER BY e.event_type;
END;
$fn$;

-- service_role only, like every other reader and writer of this ledger.
-- REVOKE FROM PUBLIC alone does NOT remove Supabase's default anon grant.
REVOKE ALL ON FUNCTION public.sweep_unledgered_bonus_events() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_unledgered_bonus_events() TO service_role;

-- Visible from \df+ and \sf, so the warning reaches someone who found this
-- function in the catalog rather than in the repository.
COMMENT ON FUNCTION public.sweep_unledgered_bonus_events() IS
  'Cutover-window only (F-003). Marks completed bonus-enabled events that carry no per-subject grant as legacy-paid. Correct ONLY after every pre-ledger admin container is gone; run at any other time it marks legitimately zero-bonus events as already-paid and silently refuses their future bonus passes. This is a mutation, not a state check.';

-- ---------------------------------------------------------------------------
-- Verify.
--
-- WHAT THIS BLOCK CANNOT PROVE, stated before what it can, because the whole
-- reason 00190 was rejected is that its verify block repeated its own predicate
-- and therefore passed vacuously.
--
-- It cannot prove the classification is correct. Whether an unmarked event was
-- really unpaid depends on when this sweep ran relative to the last old admin
-- container being replaced, and that is a runbook fact about container
-- lifecycle, not a property of any row. A green block here means the mechanism
-- is sound and reachable. It does not mean the cutover was performed correctly.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_bad      TEXT[] := '{}';
  v_src      TEXT;
  v_before   INTEGER;
  v_probed   BOOLEAN := false;
  v_remarked INTEGER;
BEGIN
  -- NOTE ON `array_append`. The obvious `v_bad := v_bad || 'message'` is a trap:
  -- an untyped literal lets Postgres resolve the operator as anyarray||anyarray
  -- and it then tries to parse the message AS an array, so the assertion dies
  -- with "malformed array literal" instead of reporting. Every arm below would
  -- have had that bug, and none of them run on a healthy database -- it was only
  -- visible under mutation testing.

  -- 1. Reachable by the role that will call it, and by nobody else.
  IF NOT has_function_privilege('service_role', 'public.sweep_unledgered_bonus_events()', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'service_role cannot execute the sweep');
  END IF;
  IF has_function_privilege('anon', 'public.sweep_unledgered_bonus_events()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sweep_unledgered_bonus_events()', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'the sweep is reachable by anon or authenticated');
  END IF;

  -- 2. The body carries no timestamp comparison -- the actual defect being
  --    removed. Asserted against the STORED definition, with comments stripped,
  --    because the header above discusses applied_at at length and an assertion
  --    a comment can satisfy proves nothing.
  v_src := regexp_replace(
             pg_get_functiondef('public.sweep_unledgered_bonus_events()'::regprocedure),
             '--[^\n]*', '', 'g');
  -- The sentinel MUST be a comment from inside the $fn$ body. pg_get_functiondef
  -- reconstructs the header from the catalog and does not reproduce comments
  -- written above RETURNS TABLE -- an earlier sentinel pointed at one of those,
  -- so it could never fire and the stripping check was itself vacuous. Caught by
  -- mutation M8.
  IF v_src LIKE '%Idempotent: re-running%' THEN
    v_bad := array_append(v_bad, 'comment stripping failed, so these assertions are vacuous');
  END IF;
  IF v_src ~* 'applied_at|schema_migrations|updated_at' THEN
    v_bad := array_append(v_bad, 'the sweep still reads a timestamp -- the defect 00206 exists to remove');
  END IF;

  -- 3. THE BEHAVIOURAL PROBE. An earlier version of this block asserted that no
  --    completed bonus-enabled event was left without a marker, and that was
  --    VACUOUS: 00190 and 00191 have already marked every such event, so it held
  --    whether the sweep wrote anything or not. Mutation testing caught it --
  --    gutting the INSERT still passed. That is the exact failure that got
  --    00190's own verify block rejected, so it is not repeated here.
  --
  --    Instead: take the markers away, run the sweep, and require it to put them
  --    back. Done inside a subtransaction that always rolls back, so the removal
  --    never reaches disk. plpgsql variable assignments are not transactional,
  --    so the counts survive the rollback.
  SELECT count(*) INTO v_before FROM public.tournament_bonus_grants WHERE kind = 'event_legacy_paid';

  IF v_before = 0 THEN
    -- Nothing to take away means the probe cannot run. Say so rather than
    -- reporting a pass it did not earn.
    RAISE NOTICE '00206: no legacy markers on this database, so the behavioural probe could not run -- the sweep is installed but UNPROVEN here';
    -- v_probed stays false so the closing notice cannot claim otherwise.
  ELSE
    BEGIN
      DELETE FROM public.tournament_bonus_grants WHERE kind = 'event_legacy_paid';
      PERFORM public.sweep_unledgered_bonus_events();
      SELECT count(*) INTO v_remarked
        FROM public.tournament_bonus_grants WHERE kind = 'event_legacy_paid';
      -- Unwind the probe. The only way out of this sub-block.
      RAISE EXCEPTION 'probe_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'probe_rollback' THEN RAISE; END IF;
    END;
    v_probed := true;

    IF v_remarked <> v_before THEN
      v_bad := array_append(v_bad, format(
        'the sweep re-marked %s of %s events it should have -- it is not writing what its predicate selects',
        v_remarked, v_before));
    END IF;
  END IF;

  -- 4. Idempotent. A second consecutive call must add nothing, or an operator
  --    re-running it to confirm quiet would instead be making changes.
  IF EXISTS (SELECT 1 FROM public.sweep_unledgered_bonus_events()) THEN
    v_bad := array_append(v_bad, 'the sweep is not idempotent -- a second consecutive run still marked events');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00206 verification failed: %', array_to_string(v_bad, '; ');
  END IF;
  -- The closing notice must not claim more than was exercised. Without markers
  -- to remove, the behavioural arm never ran, and saying "re-marks what it
  -- selects" there would be the same overstatement this migration exists to
  -- stop making.
  IF v_probed THEN
    RAISE NOTICE '00206 verified: service_role-only, timestamp-free, re-marks what it selects, idempotent';
  ELSE
    RAISE NOTICE '00206 partially verified: service_role-only, timestamp-free and idempotent -- the re-marking behaviour was NOT exercised (no markers on this database)';
  END IF;
END;
$verify$;

COMMIT;
