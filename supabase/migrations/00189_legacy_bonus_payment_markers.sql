-- 00189_legacy_bonus_payment_markers.sql
--
-- Closes the hole 00188's backfill left open.
--
-- 00188 made every placement-bonus payment claim a per-subject row in
-- tournament_bonus_grants before paying, which is a real guarantee going
-- forward. To cover payments made BEFORE that migration it backfilled the
-- ledger from tournament_audit_log, reading the player ids out of
-- details -> 'rated_players'.
--
-- That backfill inserted nothing. On staging both placement_bonuses_applied
-- rows carry details = NULL, so the jsonb_array_elements_text() lateral
-- produced zero elements and the INSERT ... SELECT had no rows to insert.
-- Prod has the same shape. The audit write is best-effort (see
-- audit-policy.ts), so a payment followed by an audit failure leaves no
-- details at all — and even a successful row only names players if the
-- details payload happened to be populated.
--
-- The consequence: every event paid before 00188 has NO grant rows, so the
-- unique index excludes nobody and the event can be paid a second time in
-- full. The per-player backfill cannot be repaired because the per-player
-- facts were never durably recorded.
--
-- So this migration stops trying to reconstruct them and fails closed at the
-- granularity the evidence actually supports: the EVENT. Any event with a
-- placement_bonuses_applied audit row gets one marker row saying "this event
-- was already paid, by a code path that kept no per-player record". The
-- application refuses to pay a marked event unless an admin explicitly
-- overrides, which is the correct posture — a human can read the ratings and
-- decide, but nothing pays twice by accident.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Let the ledger carry an event-level fact.
-- ---------------------------------------------------------------------------

-- subject_id is a bare uuid with no FK precisely so it can address different
-- kinds of subject; for this kind it holds the event_id itself. The existing
-- UNIQUE (event_id, kind, subject_id) then gives one marker per event for
-- free, so the backfill below is idempotent without any extra predicate.
ALTER TABLE public.tournament_bonus_grants
  DROP CONSTRAINT IF EXISTS tournament_bonus_grants_kind_check;

ALTER TABLE public.tournament_bonus_grants
  ADD CONSTRAINT tournament_bonus_grants_kind_check
  CHECK (kind IN ('rating', 'participant_credit', 'event_legacy_paid'));

COMMENT ON COLUMN public.tournament_bonus_grants.applied_delta IS
  'The movement applied to elo_change, which is unclamped. elo_after is
   separately clamped to rating_bounds(), so for a subject at the ceiling the
   effective rating movement is smaller than this number. Always 0 for
   kind = ''event_legacy_paid'', where the per-subject amounts are unknown.';

-- ---------------------------------------------------------------------------
-- 2. Mark every event that was paid before 00188.
-- ---------------------------------------------------------------------------

-- Deliberately NOT filtered on details being present or non-null. The whole
-- lesson of the failed backfill is that the details payload is unreliable
-- evidence; the existence of the action row is the only fact worth trusting,
-- and it is exactly the fact that says "someone paid this event".
INSERT INTO public.tournament_bonus_grants
  (event_id, kind, subject_id, requested_bonus, applied_delta, granted_at)
SELECT l.event_id,
       'event_legacy_paid',
       l.event_id,
       0,
       0,
       MIN(l.created_at)
  FROM public.tournament_audit_log l
 WHERE l.action = 'placement_bonuses_applied'
   AND l.event_id IS NOT NULL
 GROUP BY l.event_id
ON CONFLICT (event_id, kind, subject_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. A cheap, authoritative read for the application.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.event_has_legacy_bonus_payment(p_event_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tournament_bonus_grants
     WHERE event_id = p_event_id
       AND kind = 'event_legacy_paid'
       AND subject_id = p_event_id
  );
$$;

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every new function to
-- anon and authenticated as EXPLICIT acl entries, which REVOKE ... FROM PUBLIC
-- does not touch. Both roles have to be named. See 00126 lines 10-18.
REVOKE ALL ON FUNCTION public.event_has_legacy_bonus_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_has_legacy_bonus_payment(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Verify, in the same transaction.
-- ---------------------------------------------------------------------------

DO $verify$
DECLARE
  v_bad    TEXT[] := '{}';
  v_events INTEGER;
  v_marked INTEGER;
BEGIN
  SELECT count(DISTINCT event_id) INTO v_events
    FROM public.tournament_audit_log
   WHERE action = 'placement_bonuses_applied' AND event_id IS NOT NULL;

  SELECT count(*) INTO v_marked
    FROM public.tournament_bonus_grants
   WHERE kind = 'event_legacy_paid';

  IF v_marked <> v_events THEN
    v_bad := v_bad || format('expected %s legacy markers, found %s', v_events, v_marked);
  END IF;

  -- A marker must address its own event, or the application's lookup misses it.
  IF EXISTS (
    SELECT 1 FROM public.tournament_bonus_grants
     WHERE kind = 'event_legacy_paid' AND subject_id <> event_id
  ) THEN
    v_bad := v_bad || 'a legacy marker does not address its own event';
  END IF;

  IF has_function_privilege('anon', 'public.event_has_legacy_bonus_payment(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.event_has_legacy_bonus_payment(uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'event_has_legacy_bonus_payment is reachable by anon or authenticated';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.event_has_legacy_bonus_payment(uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'service_role cannot execute event_has_legacy_bonus_payment';
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00189 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00189: % event(s) marked as legacy-paid, lookup granted to service_role only.', v_marked;
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
