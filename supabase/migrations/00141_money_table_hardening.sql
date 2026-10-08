-- ============================================================
-- 00141_money_table_hardening.sql — four guards the other money ledgers
-- already have and club_fees does not
-- ============================================================
-- SAFE TO APPLY AT ANY TIME, BEFORE OR AFTER THE DEPLOY. Defence in depth
-- only: nothing here changes what any screen does, and the app already enforces
-- every rule below in its own validation. Each one is here because the DATABASE
-- did not, and a rule that lives only in a Zod schema is a rule that a service
-- role, a psql session or a future action can walk past without noticing.
--
-- The audit that found these drafted them as `00139`. That number was taken by
-- the audit-log migration before this was written; the content is unchanged.
--
-- ------------------------------------------------------------
-- RUN THESE FIRST — three of the four can fail on existing data
-- ------------------------------------------------------------
-- Each ALTER validates the whole table, and each CREATE UNIQUE INDEX validates
-- uniqueness, so a violating row makes this file fail. That is the right
-- behaviour — nothing is changed and the message names the constraint — but it
-- is better to know before than during:
--
--   SELECT count(*) FROM public.club_fees             WHERE amount_cents < 0;   -- expect 0
--   SELECT count(*) FROM public.tournament_fee_tiers  WHERE amount_cents < 0;   -- expect 0
--   SELECT count(*) FROM public.tournament_fee_tiers  WHERE amount_cents IS NULL; -- expect 0
--   SELECT ref_no, count(*) FROM public.club_expenses GROUP BY 1 HAVING count(*) > 1;
--   SELECT ref_no, count(*) FROM public.other_income  GROUP BY 1 HAVING count(*) > 1;
--
-- ------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
-- ------------------------------------------------------------
-- `CHECK (paid_at IS NULL OR amount_cents IS NOT NULL)` on club_fees is the
-- right constraint and it is NOT in this file, because PRODUCTION VIOLATES IT.
-- Two settled reinstatement rows carry a null `amount_cents` and are booked as
-- $0.00 income; adding the constraint would fail on apply. Fix the rows first —
-- the Reinstatements card does it, and `recordReinstatementPayment` matches on
-- `.is('amount_cents', null)` precisely so it can — and then add the constraint
-- as its own one-line migration. Doing it in this order means this file applies
-- cleanly today rather than waiting on a data cleanup.
--
-- `tournaments` carries the same stray `anon` grants as the three tables below,
-- and is not revoked here: nothing was traced about what reads it anonymously,
-- and guessing inside a money migration is how an unrelated page goes dark.
--
-- `club_fees.season_id -> ON DELETE RESTRICT` is a judgement call about a
-- delete path that does not exist yet. Not this file's business.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. club_fees is the only money table with no sign constraint on its amount
-- ------------------------------------------------------------
-- `other_income_amount_cents_check` and `club_expenses_amount_cents_check` are
-- both `>= 0`. club_fees has neither.
--
-- NULL STAYS LEGAL, and that is not an oversight to tidy up later: it is the
-- supported "the club has not said what this costs yet" state, and every screen
-- renders it as TBD. A constraint that outlawed it would break the ordinary
-- case of creating a fee before pricing it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.club_fees'::regclass
       AND conname  = 'club_fees_amount_cents_check'
  ) THEN
    ALTER TABLE public.club_fees
      ADD CONSTRAINT club_fees_amount_cents_check
      CHECK (amount_cents IS NULL OR amount_cents >= 0);
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. The price list itself
-- ------------------------------------------------------------
-- `feeTierSchema` already enforces min(0) in the app; the column does not. A
-- negative tier would not stay in one place — `selectFeeTier` prices every
-- tournament entry from this table, so one bad row propagates into every entry
-- made against it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tournament_fee_tiers'::regclass
       AND conname  = 'tournament_fee_tiers_amount_cents_check'
  ) THEN
    ALTER TABLE public.tournament_fee_tiers
      ADD CONSTRAINT tournament_fee_tiers_amount_cents_check
      CHECK (amount_cents >= 0);
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Stray anon grants on three money tables
-- ------------------------------------------------------------
-- Production grants anon SELECT/INSERT/UPDATE/DELETE on all three; staging
-- grants nothing, which is the tell that these are historical rather than
-- intended.
--
-- THIS REVOKE IS PROVABLY BEHAVIOUR-NEUTRAL TODAY, which is the only reason it
-- can be applied without a deploy dependency: RLS is enabled on all three
-- (`relrowsecurity = t`), every policy on them is `TO authenticated`, and anon
-- does not own them — so anon is already denied every row. What the grant
-- represents is the half that would suddenly matter the day somebody adds a
-- policy targeting `public`, at which point the table would be open to the
-- internet because of a grant nobody remembered.
--
-- The public price list keeps working: it is read through `get_active_season()`,
-- which is SECURITY DEFINER and does not consult anon's table grants.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.club_fees            FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.seasons              FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.tournament_fee_tiers FROM anon;

-- ------------------------------------------------------------
-- 4. A reference number read off a receipt should be unique
-- ------------------------------------------------------------
-- `ref_no` is GENERATED ALWAYS AS IDENTITY on both databases, so uniqueness is
-- already true and this cannot fail on existing data. It is here to PIN the
-- property rather than to rely on it: an identity column stops being unique the
-- moment somebody adds `OVERRIDING SYSTEM VALUE` or restarts the sequence
-- during a restore, and a duplicate reference number on a receipt is the kind
-- of thing that is discovered by an auditor rather than by a test.
CREATE UNIQUE INDEX IF NOT EXISTS club_expenses_ref_no_key ON public.club_expenses (ref_no);
CREATE UNIQUE INDEX IF NOT EXISTS other_income_ref_no_key  ON public.other_income  (ref_no);

COMMIT;

-- ============================================================
-- VERIFY
-- ============================================================
-- Two constraints:
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('club_fees_amount_cents_check',
--                      'tournament_fee_tiers_amount_cents_check');
--
-- No anon privilege left on the three tables — expect ZERO rows:
--
--   SELECT table_name, privilege_type FROM information_schema.table_privileges
--    WHERE grantee = 'anon'
--      AND table_name IN ('club_fees', 'seasons', 'tournament_fee_tiers');
--
-- Two unique indexes:
--
--   SELECT indexname FROM pg_indexes
--    WHERE indexname IN ('club_expenses_ref_no_key', 'other_income_ref_no_key');
--
-- And the thing the revoke must NOT have broken — the price list an anonymous
-- visitor sees. Load the public tournaments page signed out, or:
--
--   SET ROLE anon; SELECT * FROM get_active_season(); RESET ROLE;
