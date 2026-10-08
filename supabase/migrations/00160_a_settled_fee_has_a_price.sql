-- ============================================================
-- 00160 — a settled fee has a price
--
-- The one-line follow-up 00141 asked for. That file wrote out the constraint,
-- explained why it is the right one, and then deliberately did NOT add it:
--
--   "`CHECK (paid_at IS NULL OR amount_cents IS NOT NULL)` on club_fees is the
--    right constraint and it is NOT in this file, because PRODUCTION VIOLATES
--    IT. Two settled reinstatement rows carry a null `amount_cents` ... Fix the
--    rows first ... and then add the constraint as its own one-line migration."
--
-- Those two rows are gone (2026-08-23). They were reinstatement fees on the
-- owner's own test account, `ban_reason = 'testing'`, marked paid but never
-- priced, and 00141 notes they were being booked as $0.00 income — so removing
-- them moved no real total. This file is the second half of that plan.
--
-- WHAT THIS DOES AND DOES NOT OUTLAW
-- NULL `amount_cents` STAYS LEGAL on its own. 00141 is explicit that it is the
-- supported "the club has not said what this costs yet" state and that every
-- screen renders it as TBD; a constraint outlawing it would break the ordinary
-- case of creating a fee before pricing it. What this forbids is the narrower,
-- incoherent pair: a fee marked SETTLED (`paid_at` set) that never had a price.
-- That row cannot be reconciled against anything — it silently contributes
-- $0.00 to income while claiming to be paid.
--
-- The app already cannot produce one. `recordReinstatementPayment` matches on
-- `.is('amount_cents', null)` precisely so the Reinstatements card can fill the
-- amount in at the moment it settles the fee. This constraint makes that
-- guarantee structural rather than a property of one call site.
--
-- BEFORE RUNNING, expect 0:
--   SELECT count(*) FROM public.club_fees
--    WHERE paid_at IS NOT NULL AND amount_cents IS NULL;
-- Measured 0 on production 2026-08-23. If it is not 0, this file fails on apply
-- and changes nothing — which is the correct outcome, not a problem to work
-- around by weakening the constraint.
-- ============================================================

BEGIN;

-- Idempotent in the same shape 00141 uses for its own guards, so a re-run after
-- a partial apply is a no-op rather than a 42710.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.club_fees'::regclass
       AND conname  = 'club_fees_settled_has_amount'
  ) THEN
    ALTER TABLE public.club_fees
      ADD CONSTRAINT club_fees_settled_has_amount
      CHECK (paid_at IS NULL OR amount_cents IS NOT NULL);
  END IF;
END $$;

COMMENT ON CONSTRAINT club_fees_settled_has_amount ON public.club_fees IS
  'A fee marked paid must carry an amount. A null amount on an UNPAID fee stays '
  'legal and means "not priced yet" — see 00141.';

COMMIT;

-- ------------------------------------------------------------
-- Verify
-- ------------------------------------------------------------
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'public.club_fees'::regclass
--      AND conname  = 'club_fees_settled_has_amount';
--
-- And that the TBD case is still permitted — this must SUCCEED and roll back:
--   BEGIN;
--   INSERT INTO public.club_fees (player_id, season_id, fee_type, amount_cents)
--   SELECT player_id, season_id, 'dues', NULL FROM public.club_fees LIMIT 1;
--   ROLLBACK;
