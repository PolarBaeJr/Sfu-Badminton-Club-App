-- 00190_legacy_bonus_markers_from_completion.sql
--
-- Closes the one hole 00189 left, which is narrower than 00189's but the same
-- shape: an event that was paid before the grant ledger existed and left no
-- durable trace of it.
--
-- 00189 marks an event as legacy-paid when tournament_audit_log holds a
-- placement_bonuses_applied row for it. That is one fact better than 00188's
-- backfill, which needed the row AND a populated details payload, but it is
-- still a fact written by a best-effort insert. audit-policy.ts says plainly
-- that a failed audit insert leaves the parent mutation standing, so:
--
--   1. Before 00188, event E pays its podium.
--   2. E's placement_bonuses_applied insert fails. The payment stands.
--   3. E has no audit row, so 00188 backfills no grants and 00189 marks
--      nothing.
--   4. applyPlacementBonuses(E) sees legacyPaid = false and an empty ledger,
--      and pays the whole podium a second time.
--
-- The population of that case is EMPTY on both hosts today: staging and prod
-- each hold exactly two completed, bonus-enabled events and both carry an
-- audit row, so this migration inserts zero rows on either. That is precisely
-- why it is worth writing now — it converts "closed because the set happens to
-- be empty" into "closed by construction", at zero behavioural cost, before
-- prod ever runs 00188.
--
-- THE RULE. Stop asking the audit log whether an event was paid and ask the
-- event. A tournament_events row that is `completed` with placement bonuses
-- enabled has already been through finalizeEvent, and finalizeEvent pays the
-- podium. So completed + bonus-enabled + no per-subject grant rows means "we
-- cannot prove this was not paid", and for an irreversible rating movement
-- that is the same answer as "assume it was".
--
-- BOUNDED TO THE PRE-LEDGER ERA ON PURPOSE. The predicate is restricted to
-- events completed before 00188 was applied, because after 00188 the absence
-- of grant rows is meaningful rather than ambiguous: an event whose medallists
-- all score a zero bonus legitimately writes no grants, and marking it would
-- block a genuine later payment once someone fills in the final positions.
-- Only the pre-ledger era is ambiguous, and that era is closed.
--
-- THE ESCAPE HATCH IS DELIBERATELY NOT IN THE UI. applyPlacementBonuses takes
-- allowLegacyRepay, but nothing in the admin app passes it. That is the right
-- trade while the marked set is exactly the two events we can see were paid: a
-- "force anyway" button would be a permanent double-pay footgun standing ready
-- for a case that does not exist. If a marked-but-genuinely-unpaid event ever
-- turns up, the remedy is one row, run deliberately by an operator who has
-- compared the ratings against the standings first:
--
--   DELETE FROM public.tournament_bonus_grants
--    WHERE kind = 'event_legacy_paid' AND event_id = '<uuid>';

BEGIN;

INSERT INTO public.tournament_bonus_grants
  (event_id, kind, subject_id, requested_bonus, applied_delta, granted_at)
SELECT e.id,
       'event_legacy_paid',
       e.id,
       0,
       0,
       COALESCE(e.updated_at, NOW())
  FROM public.tournament_events e
 WHERE e.status = 'completed'
   AND e.placement_bonus_enabled
   -- Nothing per-subject means the ledger cannot exclude anyone, which is the
   -- state that makes a second run pay in full.
   AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bonus_grants g
          WHERE g.event_id = e.id
            AND g.kind IN ('rating', 'participant_credit')
       )
   -- The pre-ledger era only. COALESCE covers a host where 00188's ledger row
   -- is somehow absent: then every existing event predates "now" and the
   -- broader reading is the safe one.
   AND COALESCE(e.updated_at, NOW()) < COALESCE(
         (SELECT m.applied_at FROM public.schema_migrations m WHERE m.version = '00188'),
         NOW()
       )
ON CONFLICT (event_id, kind, subject_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Verify, in the same transaction.
-- ---------------------------------------------------------------------------

DO $verify$
DECLARE
  v_bad       TEXT[] := '{}';
  v_unmarked  INTEGER;
  v_markers   INTEGER;
BEGIN
  -- The whole point: after this runs, no completed bonus-enabled event from
  -- the pre-ledger era may be left with neither per-subject grants nor a
  -- marker. That is the state applyPlacementBonuses reads as "never paid".
  SELECT count(*) INTO v_unmarked
    FROM public.tournament_events e
   WHERE e.status = 'completed'
     AND e.placement_bonus_enabled
     AND COALESCE(e.updated_at, NOW()) < COALESCE(
           (SELECT m.applied_at FROM public.schema_migrations m WHERE m.version = '00188'), NOW())
     AND NOT EXISTS (SELECT 1 FROM public.tournament_bonus_grants g WHERE g.event_id = e.id);

  IF v_unmarked > 0 THEN
    v_bad := v_bad || format('%s pre-ledger event(s) still carry no grant and no marker', v_unmarked);
  END IF;

  -- A marker still has to address its own event or the lookup misses it.
  IF EXISTS (
    SELECT 1 FROM public.tournament_bonus_grants
     WHERE kind = 'event_legacy_paid' AND subject_id <> event_id
  ) THEN
    v_bad := v_bad || 'a legacy marker does not address its own event';
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00190 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  SELECT count(*) INTO v_markers
    FROM public.tournament_bonus_grants WHERE kind = 'event_legacy_paid';
  RAISE NOTICE '00190: no unmarked pre-ledger events remain; % legacy marker(s) total.', v_markers;
END
$verify$;

COMMIT;
