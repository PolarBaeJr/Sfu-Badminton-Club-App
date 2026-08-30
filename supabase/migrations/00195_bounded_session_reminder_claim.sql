-- 00195 — the reminder claim becomes one statement, and it gives up (F-018)
--
-- 00186 split the claim (reminder_attempted_at) from the receipt (reminded_at)
-- so that a crash between them stopped being a permanent silent drop, and made
-- a claim with no receipt retryable after fifteen minutes. 00194 added the
-- columns that bound that retry. This is the statement that uses them.
--
-- WHY AN RPC RATHER THAN MORE APP CODE. The claim has to increment a counter,
-- and PostgREST cannot express `reminder_attempts = reminder_attempts + 1` — an
-- app-side update can only write a value it read, which turns a
-- compare-and-swap into a read-then-write and reintroduces exactly the race
-- 00186 closed. It also has to decide, atomically with the claim, whether this
-- attempt is the one that exhausts the cap. Both belong in one statement.
--
-- Doing it here also retires the id chunking the route needed: `.in()` puts the
-- ids in the query string, where a popular session's roster runs into the
-- proxy's 8 KB request line, whereas an RPC argument travels in the body.
--
-- THE CAP IS A GIVE-UP, AND THAT IS THE OPPOSITE OF WHAT THE DIGEST DOES.
-- A reminder that fails is retried, because a duplicate reminder is a minor
-- annoyance and a missing one is the whole feature failing. A digest delivery
-- that fails is NOT retried, because a duplicate club-wide mailing is
-- unrecallable and costs the sending domain's reputation. Both jobs are
-- deliberate and they disagree on purpose; whoever changes one should read the
-- other. What was missing here was the end of the retry: without a cap, an RSVP
-- whose send fails for a reason that will not fix itself is re-attempted every
-- fifteen minutes until the session starts, reporting the same
-- claimed-but-not-notified split each time with nothing accumulating that
-- anyone could alert on.

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_session_reminders(
  p_session_id   UUID,
  p_player_ids   UUID[],
  p_stale_before TIMESTAMPTZ,
  p_max_attempts INTEGER DEFAULT 5
)
RETURNS TABLE (player_id UUID, gave_up BOOLEAN)
LANGUAGE plpgsql
AS $fn$
BEGIN
  RETURN QUERY
  UPDATE public.session_rsvp r
     SET reminder_attempted_at = CASE
           WHEN r.reminder_attempts >= p_max_attempts THEN r.reminder_attempted_at
           ELSE NOW()
         END,
         reminder_attempts = CASE
           WHEN r.reminder_attempts >= p_max_attempts THEN r.reminder_attempts
           ELSE r.reminder_attempts + 1
         END,
         -- Only ever set here, and only on the attempt that finds the cap
         -- already reached. The WHERE clause guarantees it was NULL coming in.
         reminder_failed_at = CASE
           WHEN r.reminder_attempts >= p_max_attempts THEN NOW()
           ELSE NULL
         END
   WHERE r.session_id = p_session_id
     AND r.player_id = ANY (p_player_ids)
     AND r.intent = 'going'
     -- The receipt is the only thing that means "this player was reminded".
     AND r.reminded_at IS NULL
     -- Terminal. Never claimed again.
     AND r.reminder_failed_at IS NULL
     -- Never claimed, or claimed by a tick that never came back (00186).
     AND (r.reminder_attempted_at IS NULL OR r.reminder_attempted_at < p_stale_before)
  RETURNING r.player_id, r.reminder_failed_at IS NOT NULL;
END
$fn$;

-- The service-role client the cron route uses is the only intended caller. A
-- member being able to run this could burn another member's attempt budget and
-- leave them permanently unreminded.
REVOKE ALL ON FUNCTION public.claim_session_reminders(UUID, UUID[], TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_session_reminders(UUID, UUID[], TIMESTAMPTZ, INTEGER) TO service_role;

COMMENT ON FUNCTION public.claim_session_reminders(UUID, UUID[], TIMESTAMPTZ, INTEGER) IS
  'Compare-and-swap claim of session reminders for a set of players. Returns the players this call won, each flagged with whether this call instead retired it permanently for exceeding p_max_attempts. Callers must treat gave_up rows as NOT claimed.';

DO $verify$
DECLARE
  v_oid  OID := to_regprocedure('public.claim_session_reminders(uuid,uuid[],timestamptz,integer)');
  v_bad  TEXT[] := '{}';
BEGIN
  -- to_regprocedure, NOT pg_get_function_identity_arguments: that function
  -- renders argument NAMES alongside types, so a signature comparison against
  -- a bare type list can never match and the assertion is vacuous. Two such
  -- assertions in 00188 are vacuous for exactly this reason.
  IF v_oid IS NULL THEN
    v_bad := array_append(v_bad, 'claim_session_reminders missing');
  ELSE
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'anon can execute claim_session_reminders');
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'authenticated can execute claim_session_reminders');
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'service_role CANNOT execute claim_session_reminders');
    END IF;
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00195 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00195: the reminder claim is one statement and it now gives up.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
