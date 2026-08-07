-- ============================================================
-- 00077 — who fronted an expense, whether the club has paid them back, and a
--         reference number a human can read out loud
--
-- Numbered 00077: 00073, 00074, 00075 and 00076 are applied on production.
-- This file stands alone on top of them — it touches only club_expenses
-- (created in 00073) and adds nothing that any of them also add.
--
-- WHY THIS EXISTS
-- The club owner: "allow execs to add expenses too, and for admins to mark them
-- as 'reimbursed'". The flow being served is a real one: an exec buys shuttles
-- out of their own pocket at the door, records the spend so the club knows the
-- money went out, and later an admin confirms the club has paid them back.
--
-- THREE COLUMNS, AND WHY EACH ONE IS NOT ALREADY THERE
--
--   paid_by — WHO FRONTED THE MONEY. This is NOT marked_by. marked_by is who
--     typed the row; that is a bookkeeping fact, and 00073 already records it.
--     Who is out of pocket is a different question with a different answer in
--     the two ordinary cases:
--       * an exec pays at the counter and records it themselves
--         → marked_by = paid_by = that exec;
--       * an exec texts a receipt to an admin who records it
--         → marked_by = the admin, paid_by = the exec.
--     Reusing marked_by would reimburse the second exec's admin. There is no
--     way to recover the payer from the row afterwards, so it has to be stated
--     when the row is written.
--
--     NULL means CLUB FUNDS — paid from the club account, nobody is out of
--     pocket, and no reimbursement is owed or possible. That is a real and
--     common case (a court block invoiced to the club), so it needs a
--     representation, and "no person is owed" is exactly what NULL says. It is
--     never a default in the console: the entry dialog makes the choice
--     explicit, because there is no edit action and delete is admin-only, so an
--     exec who silently accepted a wrong default could not fix their own row.
--
--   reimbursed_at — WHEN the club paid them back. NULL = still owed. The
--     timestamp, not a boolean: "reimbursed" with no date cannot answer "how
--     long has this exec been waiting", which is the question that makes an
--     exec chase it.
--
--   reimbursed_by — WHICH ADMIN confirmed it. Reimbursement is admin-only and
--     moves real money out of the club account; the same reason club_fees
--     records marked_by applies here. Without it the audit log is the only
--     trace, and audit_logs is a different table with a different retention
--     story.
--
-- Both new attribution columns are plain `REFERENCES players(id)`, matching
-- marked_by on this table and on club_fees / tournament_fees / reinstatement_
-- fees. That is NO ACTION, so deleting a player who fronted money is refused
-- rather than quietly erasing who was owed. KNOWN GAP, pre-existing and widened
-- here: merge_players() (00026) repoints marked_by on the older money tables,
-- but was never taught about club_expenses at all when 00073 added it, so a
-- merge of a player with expense history already fails on the FK. These two
-- columns are two more of the same. Deliberately NOT fixed here — 00026's
-- function is the only copy of its body in git and later applied migrations are
-- not, so a CREATE OR REPLACE from that text could silently revert them.
--
-- REIMBURSEMENT DOES NOT CHANGE ANY MONEY FIGURE.
-- No total, no view, no net position looks at these columns. A reimbursed
-- expense still counts against the season net in full, because the club is
-- poorer by the amount either way — the reimbursement IS the club paying it.
-- These columns answer "does the club still owe a person", which is a
-- liability, not a spend. The reasoning lives in full in
-- apps/admin/src/lib/season-finance.ts, next to the arithmetic it governs.
--
-- NO RLS OR GRANT CHANGES. club_expenses keeps the admin-only FOR ALL policy
-- and the REVOKE ALL FROM anon, authenticated that 00073 set, and 00073 already
-- granted UPDATE to service_role — which is the only role that ever touches
-- this table, because every read and write goes through createAdminClient().
-- Execs may now INSERT here, but they do so through that same service-role
-- client with getExecOrAdmin() as the gate in the server action; nothing about
-- the database's own privileges changes, so there is nothing to re-grant and
-- 00076's schema-wide revokes and default-privilege changes are untouched.
-- ============================================================

ALTER TABLE club_expenses
  ADD COLUMN IF NOT EXISTS paid_by       UUID REFERENCES players(id),
  ADD COLUMN IF NOT EXISTS reimbursed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reimbursed_by UUID REFERENCES players(id);

-- Re-runnable: ADD CONSTRAINT has no IF NOT EXISTS.
ALTER TABLE club_expenses DROP CONSTRAINT IF EXISTS club_expenses_reimbursement_complete;
ALTER TABLE club_expenses DROP CONSTRAINT IF EXISTS club_expenses_reimbursement_needs_payer;

-- A half-written reimbursement is the failure mode these two exist for.
--
-- (1) Date and confirmer move together. "Reimbursed, by nobody" and "confirmed
--     by an admin, on no date" are both rows that cannot be audited after the
--     fact, and either would be produced by a partial UPDATE — exactly what a
--     future hand-run SQL fix is most likely to write.
ALTER TABLE club_expenses ADD CONSTRAINT club_expenses_reimbursement_complete
  CHECK ((reimbursed_at IS NULL) = (reimbursed_by IS NULL));

-- (2) Nothing can be reimbursed unless somebody fronted it. paid_by IS NULL
--     means the club paid directly, so there is no person to pay back;
--     marking such a row reimbursed would assert the club refunded itself, and
--     would show an exec a "Reimbursed" badge for money they never spent.
ALTER TABLE club_expenses ADD CONSTRAINT club_expenses_reimbursement_needs_payer
  CHECK (reimbursed_at IS NULL OR paid_by IS NOT NULL);

-- Every existing row has all three columns NULL, so both constraints hold on
-- the current table with no backfill: NULL = NULL is true for the first, and
-- the second is satisfied by its left branch.

COMMENT ON COLUMN club_expenses.paid_by IS
  'Who fronted the money, when a person did. NULL means the club account paid directly and nobody is owed. NOT the same as marked_by, which is whoever typed the row — an admin routinely records an expense an exec paid for.';
COMMENT ON COLUMN club_expenses.reimbursed_at IS
  'When the club paid the payer back. NULL means still owed. Changes no money total: the expense counts against the season net whether or not it has been settled — see apps/admin/src/lib/season-finance.ts.';
COMMENT ON COLUMN club_expenses.reimbursed_by IS
  'The admin who confirmed the reimbursement. Admin-only, enforced in markExpenseReimbursed(); execs may record an expense but never settle one.';

-- ------------------------------------------------------------
-- ref_no — a reference number a person can say out loud
--
-- The club owner: "give each expense an 'id' i guess? so its easier to track".
-- Both tables have had a uuid primary key since 00073, so this is not about
-- identity — it is about a treasurer holding a receipt and a bank line and
-- needing to name the row that matches. Nobody reads
-- "3f1c9a2e-7b40-4d51-9c88-0a2e5f4b1d63" to another person over a table.
--
-- A SEQUENCE (via IDENTITY), not a truncated uuid. Truncating a uuid is not
-- collision-free — birthday bounds make a clash a real event long before the
-- rows become unmanageable — and the result reads as noise, which defeats the
-- entire purpose.
--
-- GENERATED ALWAYS, not BY DEFAULT: the database refuses a user-supplied value
-- outright rather than accepting one and colliding later. An identifier that
-- can be handed to it is an identifier that can be duplicated, and the UNIQUE
-- index below is the second lock on the same door.
--
-- IMMUTABLE ONCE ASSIGNED. Nothing in the console offers to change it, and
-- updateExpense() does not include it in its column list. An identifier that
-- moves is worse than no identifier: every receipt annotated with the old value
-- silently starts pointing at a different row.
--
-- NOT GAP-FREE, and that is fine — but only because nothing pretends otherwise.
-- A sequence burns its value on a rolled-back insert, so EXP-0007 can be
-- missing with EXP-0006 and EXP-0008 both present. Postgres has no cheap
-- gap-free counter (one would need a locked counter row, serialising every
-- insert). Gaps do not matter for the job this does — matching one receipt to
-- one row — and they only become a problem if a treasurer reads the sequence as
-- a count. So the UI never presents it as one: no "expense #7 of 12", no
-- ordering by it, no arithmetic on it. It is a label, and the row count comes
-- from counting rows.
--
-- BOTH LEDGERS, not just expenses. other_income was built as a matched pair
-- with club_expenses in 00073 (same columns, same order, deliberately, so a
-- future consolidation stays a mechanical INSERT ... SELECT) and both are drawn
-- by the SAME component — LedgerCard renders either one. Giving only expenses a
-- reference would mean MORE conditional code, not less, and a donation is
-- exactly as likely to need matching against a bank line. Prefixes keep them
-- apart in conversation: EXP-0001 and INC-0001 are different rows and cannot be
-- confused, which is why the prefix is not decoration.
--
-- Adding an IDENTITY column rewrites the table and backfills existing rows in
-- physical order. Both tables are days old and hold tens of rows.
-- ------------------------------------------------------------
ALTER TABLE club_expenses ADD COLUMN IF NOT EXISTS ref_no BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE other_income  ADD COLUMN IF NOT EXISTS ref_no BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX IF NOT EXISTS idx_club_expenses_ref_no ON club_expenses (ref_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_other_income_ref_no  ON other_income  (ref_no);

-- The identity sequences, granted to service_role explicitly.
--
-- For an IDENTITY column Postgres evaluates nextval() internally and does NOT
-- require the inserting role to hold USAGE on the sequence — unlike a `serial`,
-- which does. So this should be unnecessary. It is here anyway because the cost
-- of being wrong is asymmetric: two harmless GRANTs against one failure mode
-- where EVERY expense and income insert dies on a permission error, on a
-- hand-applied migration, on a live console. 00076 changed default privileges
-- schema-wide and is not in this repository, so "the defaults will cover it"
-- cannot be checked from here.
--
-- Sequence USAGE only. This grants nothing 00076 revoked — that was TRUNCATE,
-- REFERENCES and TRIGGER on TABLES — and nothing at all to anon or
-- authenticated, who keep the REVOKE ALL that 00073 gave them.
--
-- pg_get_serial_sequence resolves the generated name rather than hard-coding
-- club_expenses_ref_no_seq, which is only a convention.
DO $$
DECLARE
  seq TEXT;
BEGIN
  FOREACH seq IN ARRAY ARRAY[
    pg_get_serial_sequence('public.club_expenses', 'ref_no'),
    pg_get_serial_sequence('public.other_income',  'ref_no')
  ] LOOP
    IF seq IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq);
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN club_expenses.ref_no IS
  'Human-readable reference, shown as EXP-0001 (see packages/shared/src/utils/finance-refs.ts — the padding lives in ONE place). Assigned by the database, never by the app, and never updated. Sequence-backed, so gaps are possible and it is NOT a count of anything.';
COMMENT ON COLUMN other_income.ref_no IS
  'Human-readable reference, shown as INC-0001. Same rules as club_expenses.ref_no: database-assigned, immutable, gaps possible, not a count.';
