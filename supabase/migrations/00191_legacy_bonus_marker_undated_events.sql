-- 00191_legacy_bonus_marker_undated_events.sql
--
-- One-line correction to 00190's predicate, plus the reasoning for why the
-- rest of that predicate stays exactly as it is.
--
-- 00190 bounded the legacy marker to the pre-ledger era with
--
--     COALESCE(e.updated_at, NOW()) < COALESCE(<00188 applied_at>, NOW())
--
-- and tournament_events.updated_at is nullable. It carries DEFAULT now(), and
-- both hosts measure zero NULLs today, so nothing was actually missed — but the
-- expression fails OPEN for a NULL, which is the wrong direction for this
-- guard. With updated_at NULL the left side becomes NOW(), which is not less
-- than a past applied_at, so the event is silently EXCLUDED from the marker
-- set. And when 00188 is absent the fallback degrades to NOW() < NOW(), which
-- is false, excluding it again. An event nobody can date is precisely an event
-- nobody can prove was paid after the ledger existed, and for an irreversible
-- rating movement "cannot prove" has to read as "assume it was".
--
-- So the predicate becomes (updated_at IS NULL OR updated_at < cutoff). The
-- INSERT is otherwise identical to 00190's and is re-run here rather than
-- edited into 00190, because 00190 is already applied on staging and editing an
-- applied migration is what makes the checksum preflight report DRIFT.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
-- It does not widen the cutoff past 00188. Codex's round-4 review is right that
-- the cutoff identifies migration time rather than the moment every running
-- image starts using the ledger, and that a prod finalise landing in the window
-- between "00190 applied" and "new image live" would be paid by the old code —
-- which writes ratings by absolute UPDATE and calls no RPC at all, so it leaves
-- neither grants nor a marker, and a later run would pay the podium twice.
--
-- That gap is real and it is NOT closed here, because it cannot be closed by a
-- predicate: no timestamp available to SQL knows when the application image
-- changed. It is closed by the cutover instead — do not apply placement bonuses
-- between these migrations and the code deploy — with a detection query and a
-- by-hand remedy recorded in docs/sensitive/PROD-CUTOVER-00177-00190.md. A
-- re-runnable reconciliation function was considered and rejected: a mechanism
-- an operator has to remember to fire lets this file CLAIM a closure it does
-- not have, which is the same accident-versus-property mistake 00190 exists to
-- correct.

BEGIN;

INSERT INTO public.tournament_bonus_grants
  (event_id, kind, subject_id, requested_bonus, applied_delta, granted_at)
SELECT e.id, 'event_legacy_paid', e.id, 0, 0, COALESCE(e.updated_at, NOW())
  FROM public.tournament_events e
 WHERE e.status = 'completed'
   AND e.placement_bonus_enabled
   AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bonus_grants g
          WHERE g.event_id = e.id
            AND g.kind IN ('rating', 'participant_credit')
       )
   AND (
         e.updated_at IS NULL
         OR e.updated_at < COALESCE(
              (SELECT m.applied_at FROM public.schema_migrations m WHERE m.version = '00188'),
              NOW()
            )
       )
ON CONFLICT (event_id, kind, subject_id) DO NOTHING;

DO $verify$
DECLARE
  v_cutoff TIMESTAMPTZ;
  v_open   INTEGER;
BEGIN
  SELECT COALESCE(
           (SELECT m.applied_at FROM public.schema_migrations m WHERE m.version = '00188'),
           NOW()
         ) INTO v_cutoff;

  -- The assertion 00190's verifier could not make: it checked only rows that
  -- already satisfied the same timestamp predicate, so a NULL-dated event was
  -- excluded from the check by the very expression that excluded it from the
  -- insert. This one asks the fail-closed question directly.
  SELECT count(*) INTO v_open
    FROM public.tournament_events e
   WHERE e.status = 'completed'
     AND e.placement_bonus_enabled
     AND (e.updated_at IS NULL OR e.updated_at < v_cutoff)
     AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bonus_grants g
            WHERE g.event_id = e.id
              AND g.kind IN ('rating', 'participant_credit')
         )
     AND NOT EXISTS (
           SELECT 1 FROM public.tournament_bonus_grants g
            WHERE g.event_id = e.id
              AND g.kind = 'event_legacy_paid'
              AND g.subject_id = e.id
         );

  IF v_open > 0 THEN
    RAISE EXCEPTION '00191 verification failed: % pre-ledger event(s) still have neither grants nor a legacy marker', v_open;
  END IF;

  RAISE NOTICE '00191: no undated or pre-ledger event is left unmarked.';
END
$verify$;

COMMIT;
