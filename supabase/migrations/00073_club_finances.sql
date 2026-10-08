-- ============================================================
-- 00073 — other income and club expenses, both season-scoped
--
-- Numbered 00073: 00070 and 00072 are applied on production, and 00071 was
-- claimed and never used. Leave the gap.
--
-- WHY THIS EXISTS
-- The club owner asked to record money that is not a club/tournament/
-- reinstatement fee ("add other fees" — donations, grants, socials), to track
-- money going out ("track our shuttles usage for normal club events"), and to
-- answer one question with the two together: "are we in the positives".
-- Answering that needs both halves in the ledger, so both halves are here.
--
-- SEASON SCOPING IS A COLUMN, NOT A DATE WINDOW
-- reinstatement_fees had no season column and had to be bucketed by paid_at.
-- A real $20 payment taken three weeks before the term it was for began then
-- fell outside every season window and appeared in no total at all (see 00069).
-- Both tables here carry season_id NOT NULL, so which season a row counts
-- toward is stated when it is recorded and no date arithmetic can move it.
--
-- NOT NULL rather than nullable-with-a-fallback: unlike a reinstatement, which
-- genuinely happens between terms, there is no reason to book a shuttle
-- purchase or a donation against no season. A nullable column here would be a
-- row that belongs to no total, which is the exact bug 00069 fixed.
--
-- ON DELETE RESTRICT, deliberately, and NOT the ON DELETE CASCADE club_fees
-- uses. 00069 states the principle: "deleting a season must not delete the
-- record that money changed hands." season_id is NOT NULL so SET NULL is not
-- available, which leaves CASCADE (silently destroys the ledger) or RESTRICT
-- (refuses). RESTRICT is the honest one. There is no season-delete path in the
-- console today — nothing calls DELETE on seasons anywhere in apps/ — so this
-- breaks nothing now; if one is ever added it will have to decide out loud what
-- happens to the money, instead of quietly shredding it.
--
-- COLUMN CONVENTIONS
-- amount_cents / paid_at / marked_by / method / reference, matching club_fees,
-- tournament_fees and reinstatement_fees column for column. docs recommend
-- eventually consolidating the fee tables; that is a separate decision and is
-- NOT done here, but keeping the shape identical means the consolidation stays
-- a mechanical INSERT ... SELECT rather than a schema translation.
--
-- amount_cents is an INTEGER of cents. Never a float: 0.1 + 0.2 does not equal
-- 0.3 and a treasurer's total must reconcile exactly.
--
-- paid_at is nullable, like every other ledger, and is what makes a row count.
-- getSeasonIncome / getSeasonFinances filter `paid_at IS NOT NULL` uniformly
-- across all five ledgers — one rule, not one per table. The console always
-- sets it on insert; the nullable column exists so the shape matches and so a
-- row whose date nobody can pin down can still be filed and shown as "not
-- recorded" rather than being refused or guessed at.
--
-- NO UNIQUENESS CONSTRAINT, unlike 00065's club_fees_manual_name_season_key.
-- There it worked because a person pays a season fee once. Here, buying two
-- tubes of shuttles on the same day for the same price at the same event is an
-- ordinary Tuesday, so any natural key would reject real entries. Double-submit
-- protection is the dialog's single-flight guard instead, and the row list
-- shows every entry individually so a duplicate is visible and deletable.
-- ============================================================

-- ------------------------------------------------------------
-- other_income — money in that is not a fee
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS other_income (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id    UUID NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
  -- Fixed vocabulary so a season can be broken down by where the money came
  -- from. TEXT + CHECK rather than an enum: adding a value later is a plain
  -- forward-only ALTER instead of a type change, and `method` next to it is
  -- already TEXT.
  category     TEXT NOT NULL CHECK (category IN ('donation', 'grant', 'fundraiser', 'social', 'sponsorship', 'other')),
  description  TEXT NOT NULL CHECK (btrim(description) <> ''),
  -- Non-negative, not positive: a $0.00 entry is a legitimate way to record
  -- that a promised donation came to nothing without deleting the trail.
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  paid_at      TIMESTAMPTZ,
  marked_by    UUID REFERENCES players(id),
  method       TEXT,
  reference    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE other_income IS
  'Money in that is not a club, tournament or reinstatement fee: donations, grants, socials, sponsorships. Season-scoped by column so no date gap can hide a row. Counted by getSeasonIncome only when paid_at is set.';
COMMENT ON COLUMN other_income.season_id IS
  'Season this income counts toward. NOT NULL: a row attached to no season belongs to no total, which is the bug 00069 fixed for reinstatements.';
COMMENT ON COLUMN other_income.amount_cents IS
  'Cents, integer. Never a float — a treasurer''s total has to reconcile exactly.';
COMMENT ON COLUMN other_income.paid_at IS
  'When the money actually arrived. NULL means "recorded but not confirmed received" and is excluded from every total, the same rule the fee ledgers use.';

-- ------------------------------------------------------------
-- club_expenses — money out
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS club_expenses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id    UUID NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
  -- 'shuttles' is the motivating case and is listed first for that reason.
  category     TEXT NOT NULL CHECK (category IN ('shuttles', 'court_rental', 'equipment', 'food', 'other')),
  description  TEXT NOT NULL CHECK (btrim(description) <> ''),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  -- How many units the spend covers — tubes of shuttles, hours of court. The
  -- ask was to "track our shuttles usage", and usage is a count, not only a
  -- dollar figure. Optional and deliberately unitless: this is a note on a
  -- spend line, not an inventory system, and nothing computes a stock level
  -- from it.
  quantity     INTEGER CHECK (quantity IS NULL OR quantity > 0),
  paid_at      TIMESTAMPTZ,
  marked_by    UUID REFERENCES players(id),
  method       TEXT,
  reference    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE club_expenses IS
  'Money out, by category. Season-scoped by column. Subtracted from season income to give the net position. Counted only when paid_at is set, matching the income ledgers.';
COMMENT ON COLUMN club_expenses.category IS
  'shuttles | court_rental | equipment | food | other. TEXT + CHECK rather than an enum so a new category is a forward-only ALTER.';
COMMENT ON COLUMN club_expenses.quantity IS
  'Optional unit count for the spend (tubes of shuttles, hours of court). A note, not inventory — no stock level is derived from it.';
COMMENT ON COLUMN club_expenses.paid_at IS
  'When the money actually left. NULL is excluded from every total, the same rule the income ledgers use.';

-- Every read is "this season's rows", the same access pattern club_fees has.
CREATE INDEX IF NOT EXISTS idx_other_income_season   ON other_income  (season_id);
CREATE INDEX IF NOT EXISTS idx_club_expenses_season  ON club_expenses (season_id);

-- ------------------------------------------------------------
-- RLS and grants
--
-- These hold money and nothing else. Unlike club_fees there is no
-- *_select_own policy: no member has a stake in a single row here, so no member
-- has any business reading one.
--
-- Belt AND braces, because they protect against different mistakes:
--   - The REVOKEs mean neither member-facing role holds a privilege at all,
--     even before RLS is consulted. Supabase ships ALTER DEFAULT PRIVILEGES
--     that hand `anon`/`authenticated` broad grants on newly created tables in
--     public, so a fresh table is NOT private by default. 00072 had to go back
--     and revoke TRUNCATE from the existing money tables for exactly this
--     reason; doing it at creation time is cheaper than doing it after.
--   - The policies mean that if a later blanket GRANT ever puts those
--     privileges back, rows are still unreachable to anyone who is not an
--     admin.
-- Only the service-role console client (createAdminClient) touches these, and
-- it bypasses RLS — so the server actions gate on getAdminPlayer(), which is
-- the real boundary. This is the layer under it.
-- ------------------------------------------------------------
ALTER TABLE other_income  ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_expenses ENABLE ROW LEVEL SECURITY;

-- Re-runnable: CREATE POLICY has no IF NOT EXISTS.
DROP POLICY IF EXISTS other_income_admin  ON other_income;
DROP POLICY IF EXISTS club_expenses_admin ON club_expenses;

-- FOR ALL with no WITH CHECK: Postgres reuses the USING expression as the
-- WITH CHECK, so INSERT and UPDATE are gated by is_admin() too. Same shape as
-- club_fees_admin / tf_admin / rf_admin.
CREATE POLICY other_income_admin  ON other_income  FOR ALL TO authenticated USING (is_admin(auth.uid()));
CREATE POLICY club_expenses_admin ON club_expenses FOR ALL TO authenticated USING (is_admin(auth.uid()));

REVOKE ALL ON public.other_income  FROM anon, authenticated;
REVOKE ALL ON public.club_expenses FROM anon, authenticated;

-- service_role explicitly, because EVERY read and write of these tables goes
-- through it: createAdminClient() is the only client that touches them, and the
-- admin gate is getAdminPlayer() in the server action, not a database role.
--
-- Stated rather than inherited. Supabase normally hands service_role its
-- privileges through ALTER DEFAULT PRIVILEGES, which is a property of the role
-- that ran CREATE TABLE and of whatever defaults happen to be configured — none
-- of which is visible in this file. If those defaults are absent when this is
-- applied by hand, the entire finance section fails on a permission error at
-- the first query. One line makes it independent of that.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.other_income  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.club_expenses TO service_role;
