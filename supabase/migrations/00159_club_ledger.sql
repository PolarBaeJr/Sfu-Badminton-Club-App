-- ============================================================
-- 00159 — the two club ledgers become one
--
-- "just wanted to have less db tables around" — the club owner, 00094, which
-- collapsed three fee ledgers into club_fees and is the pattern this file
-- follows. club_expenses and other_income are the same table twice: money,
-- against a season, in a category, with a description, a payment date and who
-- recorded it. other_income's eleven columns are an EXACT SUBSET of
-- club_expenses' fifteen. They differ in which way the money moved, which is a
-- column, not a schema.
--
-- WHY NOW AND NOT LATER
-- Both tables are EMPTY on production (verified 2026-08-21, and again in the
-- guard below). That makes this pure DDL: nothing to backfill, nothing to
-- reconcile, no window where a total is assembled from two shapes. The first
-- shuttle purchase or donation recorded turns it into a data migration with a
-- money figure riding on it. This is the cheapest this change will ever be.
--
-- WHY NOT FOLD INTO club_fees AS WELL
-- club_fees answers "what does this person owe" — it is per-player receivables
-- keyed by player_id/manual_name, and 00094 collapsed it precisely so that
-- question has ONE answer. An expense has no person who owes it. Folding
-- money-out into that table would add six nullable columns and a sign
-- convention to a ledger whose whole job is per-member balances. Two tables
-- for two questions, not three tables for two.
--
-- ============================================================
-- THE ONE THING EVERY READER MUST NOW DO
-- ============================================================
-- FILTER ON `direction`. This is the same hazard 00094 called out for fee_type
-- and it is sharper here, because the two halves are separate CAPABILITIES:
-- fees.expenses.read and fees.otherincome.read. An admin may hold one and not
-- the other. Before this file the table boundary enforced that; after it, the
-- WHERE clause does. An unfiltered SELECT hands a donations reader the club's
-- spending, and — worse — an unfiltered DELETE or UPDATE keyed only on `id`
-- will happily reach across the boundary, because ids are unique across the
-- whole table now. Every query in apps/admin/src/lib/actions/finance.ts,
-- season-income.ts, season-finance.ts and fees/ledger-card.tsx carries the
-- filter. A new one must too.
-- ============================================================

-- ------------------------------------------------------------
-- Refuse to run if either table has grown a row
-- ------------------------------------------------------------
-- The whole argument above rests on both being empty. If money HAS been
-- recorded since this was written, the right move is a real data migration
-- with the counts read first — not a silent DROP. So this stops rather than
-- guesses.
DO $$
DECLARE n_exp BIGINT; n_inc BIGINT;
BEGIN
  SELECT count(*) INTO n_exp FROM public.club_expenses;
  SELECT count(*) INTO n_inc FROM public.other_income;
  IF n_exp > 0 OR n_inc > 0 THEN
    RAISE EXCEPTION
      'club_expenses has % row(s) and other_income has % row(s). 00159 assumes both are empty. Migrate the rows deliberately, then re-run.',
      n_exp, n_inc;
  END IF;
END $$;

-- ------------------------------------------------------------
-- The merged ledger
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.club_ledger (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE RESTRICT, carried over from 00073 unchanged. 00069's principle:
  -- "deleting a season must not delete the record that money changed hands."
  -- season_id is NOT NULL so SET NULL is unavailable, which leaves CASCADE
  -- (silently shreds the ledger) or RESTRICT (refuses). RESTRICT is honest.
  season_id     UUID NOT NULL REFERENCES public.seasons(id) ON DELETE RESTRICT,

  -- Which way the money moved. TEXT + CHECK rather than an enum, for 00094's
  -- reason: an enum cannot be extended inside a transaction on older servers,
  -- and a CHECK is edited with one ALTER and no type surgery.
  --
  -- NO DEFAULT, deliberately. Both halves are equally real, so there is no
  -- "obviously right" value to fall back on, and an INSERT that forgot the
  -- column should fail loudly rather than quietly book a donation as a spend.
  direction     TEXT NOT NULL CHECK (direction IN ('income', 'expense')),

  category      TEXT NOT NULL,
  description   TEXT NOT NULL CHECK (btrim(description) <> ''),

  -- 00141 hardening carried over: amounts are non-negative, and the SIGN comes
  -- from `direction`, never from a negative amount. A ledger that allowed both
  -- would have two ways to express money out and every SUM would have to know
  -- which was meant.
  amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),

  quantity      INTEGER CHECK (quantity IS NULL OR quantity > 0),
  paid_at       TIMESTAMPTZ,
  marked_by     UUID REFERENCES public.players(id),
  method        TEXT,
  reference     TEXT,

  -- Reimbursement, from 00077. Expense-only — see the CHECK below.
  paid_by       UUID REFERENCES public.players(id),
  reimbursed_at TIMESTAMPTZ,
  reimbursed_by UUID REFERENCES public.players(id),

  -- ONE running reference number across both halves, where 00077 had two.
  --
  -- This IS a behaviour change and it is the only one in this file. Before,
  -- club_expenses and other_income each had their own IDENTITY, so the club's
  -- first expense and first donation were both #1, displayed EXP-0001 and
  -- INC-0001. Now they share a sequence: EXP-0001, INC-0002, EXP-0003. That is
  -- how a paper cashbook numbers entries, and it is free ONLY because both
  -- tables are empty — no reference number a person has already been given
  -- changes meaning. The display prefix still comes from `direction`.
  --
  -- GENERATED ALWAYS, as 00077 had it: database-assigned, immutable, gaps
  -- possible (a rolled-back insert burns a number), and NOT a count.
  ref_no        BIGINT GENERATED ALWAYS AS IDENTITY,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Each half keeps its own category vocabulary, exactly as 00073 wrote them.
  -- One CHECK rather than two columns: without this a donation could be filed
  -- as an expense and would flip the sign of the season's net position with
  -- nothing on screen looking wrong.
  CONSTRAINT club_ledger_category_matches_direction CHECK (
       (direction = 'expense' AND category IN ('shuttles','court_rental','equipment','food','other'))
    OR (direction = 'income'  AND category IN ('donation','grant','fundraiser','social','sponsorship','other'))
  ),

  -- Reimbursement is a property of money the club OWES SOMEBODY BACK, which
  -- only happens on the way out. `quantity` is the same: it counts tubes of
  -- shuttles, and a donation has no unit count. Without this, an income row
  -- could carry a payer and a settlement date and would render with a
  -- reimbursement badge on the Expenses tab's own component.
  CONSTRAINT club_ledger_reimbursement_is_expense CHECK (
    direction = 'expense'
    OR (paid_by IS NULL AND reimbursed_at IS NULL AND reimbursed_by IS NULL AND quantity IS NULL)
  ),

  -- Both carried over verbatim from 00077.
  CONSTRAINT club_ledger_reimbursement_complete
    CHECK ((reimbursed_at IS NULL) = (reimbursed_by IS NULL)),
  CONSTRAINT club_ledger_reimbursement_needs_payer
    CHECK (reimbursed_at IS NULL OR paid_by IS NOT NULL)
);

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------
-- (season_id, direction) rather than season_id alone: EVERY read in the console
-- is "one season, one direction" — that is what the capability split means —
-- so the composite serves both halves and neither has to filter the other's
-- rows out after the fact.
CREATE INDEX IF NOT EXISTS idx_club_ledger_season
  ON public.club_ledger (season_id, direction);

CREATE UNIQUE INDEX IF NOT EXISTS idx_club_ledger_ref_no
  ON public.club_ledger (ref_no);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
-- Both source tables had exactly one policy each — `FOR ALL TO authenticated
-- USING (is_admin(auth.uid()))` with no WITH CHECK, so the USING expression
-- serves both. Merged, that is ONE policy of the same shape, and it is
-- equivalent: a person who is an admin could reach both tables before and
-- reaches both halves now; a person who is not could reach neither.
--
-- THE POLICY IS NOT THE CAPABILITY BOUNDARY and never was. fees.expenses.read
-- and fees.otherincome.read are enforced in the app, by requireCapability, over
-- the service-role client — which bypasses RLS by design. This policy is the
-- floor for a direct authenticated read, not the mechanism that keeps the two
-- books apart. That mechanism is the `direction` filter in the queries.
ALTER TABLE public.club_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_ledger_admin ON public.club_ledger;
CREATE POLICY club_ledger_admin ON public.club_ledger
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()));

-- ------------------------------------------------------------
-- Grants
-- ------------------------------------------------------------
-- Mirrors what club_expenses and other_income actually hold on production:
-- postgres and service_role only. NOTHING to anon or authenticated — 00131 and
-- 00157 exist because grants drifted; this table starts where they finished.
REVOKE ALL ON public.club_ledger FROM PUBLIC;
REVOKE ALL ON public.club_ledger FROM anon, authenticated;
GRANT ALL ON public.club_ledger TO service_role;

-- The identity sequence is owned by the table and is written only through it;
-- GENERATED ALWAYS means no client supplies a value. service_role needs no
-- separate sequence grant for that, and anon/authenticated get none —
-- 00131 recorded both old ref_no sequences as reachable by anon, which was
-- drift, not intent.
REVOKE ALL ON SEQUENCE public.club_ledger_ref_no_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.club_ledger_ref_no_seq FROM anon, authenticated;

-- ------------------------------------------------------------
-- Comments
-- ------------------------------------------------------------
COMMENT ON TABLE public.club_ledger IS
  'Club money that is not a per-member fee: what came in (donations, grants, socials) and what went out (shuttles, courts, equipment), one row per transaction, split by `direction`. Replaces other_income and club_expenses (00073, 00077). EVERY READER MUST FILTER ON direction — fees.expenses.read and fees.otherincome.read are separate capabilities, and ids are unique across both halves, so an unfiltered UPDATE or DELETE keyed on id reaches the other book.';

COMMENT ON COLUMN public.club_ledger.direction IS
  'income or expense. Determines the sign in every net-position sum, the category vocabulary, whether reimbursement columns may be set, and which capability may read the row.';

COMMENT ON COLUMN public.club_ledger.amount_cents IS
  'Always non-negative. Money out is expressed by direction = expense, never by a negative amount.';

COMMENT ON COLUMN public.club_ledger.ref_no IS
  'Human-readable reference, shown as EXP-0001 or INC-0002 by direction. ONE sequence across both halves (00159 merged the two 00077 had). Database-assigned, immutable, gaps possible, not a count.';

-- ------------------------------------------------------------
-- The old tables
-- ------------------------------------------------------------
-- Safe because the guard at the top of this file proved both are empty. No
-- CASCADE: nothing references either (fk_in = 0 for both, verified against
-- production), so a plain DROP is enough and would fail loudly if that changed.
DROP TABLE public.club_expenses;
DROP TABLE public.other_income;

-- ------------------------------------------------------------
-- PostgREST
-- ------------------------------------------------------------
-- Without this the console reads a table the schema cache has never heard of
-- and PostgREST answers 404 — which arrives in the app as an EMPTY LIST, not an
-- error, on a money figure. See the notes in season-income.ts about why a
-- silently-empty ledger is the worst possible failure here.
NOTIFY pgrst, 'reload schema';
