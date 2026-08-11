-- ============================================================
-- DATA MIGRATION for 00094 — move the fee rows into club_fees
--
-- DELIBERATELY NOT IN supabase/migrations/. Nothing here is applied by any
-- automated step; it is run by hand, by the club owner, after reading it. It
-- moves the club's money records, and the counts on either side are a human
-- check, not an assertion in a script.
--
-- ORDER
--   1. apply supabase/migrations/00094_one_fee_ledger.sql
--   2. run SECTION 1 (read-only) and note the numbers
--   3. run SECTION 2 (the move) — one transaction, safe to re-run
--   4. run SECTION 3 and check the numbers agree with step 2
--   5. optionally run SECTION 4 (backfill entries that never had a fee row)
--   6. deploy the console
--   7. only then apply supabase/migrations/00095_retire_old_fee_tables.sql
--
-- Between 1 and 6 the old rows are readable from both places, so there is no
-- window where the money is unreachable. Deploying the console BEFORE step 3
-- would hide every tournament and reinstatement record until the rows moved.
-- ============================================================


-- ------------------------------------------------------------
-- SECTION 1 — READ ONLY. What each move would touch.
-- ------------------------------------------------------------
SELECT 'tournament_fees (source)'          AS what, count(*) AS rows FROM tournament_fees
UNION ALL
SELECT 'reinstatement_fees (source)',            count(*) FROM reinstatement_fees
UNION ALL
SELECT 'club_fees, already there',               count(*) FROM club_fees
UNION ALL
SELECT 'club_fees, fee_type = dues',             count(*) FROM club_fees WHERE fee_type = 'dues'
UNION ALL
SELECT 'club_fees, fee_type = tournament',       count(*) FROM club_fees WHERE fee_type = 'tournament'
UNION ALL
SELECT 'club_fees, fee_type = reinstatement',    count(*) FROM club_fees WHERE fee_type = 'reinstatement'
ORDER BY what;

-- The money, so the two sides can be compared as amounts and not only as row
-- counts. A move that loses a row shows up here even if the count is right.
SELECT 'tournament_fees'    AS ledger, coalesce(sum(amount_cents), 0) AS cents,
       count(*) FILTER (WHERE paid_at IS NOT NULL) AS paid_rows
  FROM tournament_fees
UNION ALL
SELECT 'reinstatement_fees', coalesce(sum(amount_cents), 0),
       count(*) FILTER (WHERE paid_at IS NOT NULL)
  FROM reinstatement_fees;


-- ------------------------------------------------------------
-- SECTION 2 — THE MOVE. One transaction. Safe to run twice.
-- ------------------------------------------------------------
-- COPIES, does not delete. The source tables are left exactly as they are and
-- are dropped later by 00095, once the counts have been checked. Nothing here
-- can lose a row that is not already copied.
--
-- ON CONFLICT DO NOTHING with no target: 00094's uniqueness is three PARTIAL
-- indexes, and a bare DO NOTHING covers any unique violation from any of them.
-- That is what makes a second run a no-op rather than a duplicate.
--
-- created_at is copied rather than defaulted. The member's /fees screen orders
-- receipts by it, and letting it default to now() would restack somebody's
-- payment history in the order the migration happened to run.
BEGIN;

-- Entry fees. season_id comes from the tournament, which is where the old
-- income query joined to find it — the season becomes a column on the row so
-- moving a tournament between seasons later cannot silently move recorded
-- money with it.
INSERT INTO club_fees (
  fee_type, player_id, tournament_id, tier_id, season_id,
  amount_cents, paid_at, marked_by, method, reference, created_at
)
SELECT 'tournament', tf.player_id, tf.tournament_id, tf.tier_id, t.season_id,
       tf.amount_cents, tf.paid_at, tf.marked_by, tf.method, tf.reference, tf.created_at
  FROM tournament_fees tf
  JOIN tournaments t ON t.id = tf.tournament_id
ON CONFLICT DO NOTHING;

-- Reinstatements. ban_started_at is NOT NULL on the source (00065), so every
-- row satisfies 00094's shape CHECK and the per-ban unique index.
INSERT INTO club_fees (
  fee_type, player_id, ban_started_at, ban_reason, season_id,
  amount_cents, paid_at, marked_by, method, reference, created_at
)
SELECT 'reinstatement', rf.player_id, rf.ban_started_at, rf.ban_reason, rf.season_id,
       rf.amount_cents, rf.paid_at, rf.marked_by, rf.method, rf.reference, rf.created_at
  FROM reinstatement_fees rf
ON CONFLICT DO NOTHING;

COMMIT;


-- ------------------------------------------------------------
-- SECTION 3 — READ ONLY. Did it land?
-- ------------------------------------------------------------
-- Each line must read 0. A non-zero row here is a source row that did NOT make
-- it across, and 00095 must not be run until this is empty.
SELECT 'tournament_fees not copied' AS problem, count(*) AS rows
  FROM tournament_fees tf
 WHERE NOT EXISTS (
   SELECT 1 FROM club_fees c
    WHERE c.fee_type = 'tournament'
      AND c.player_id = tf.player_id
      AND c.tournament_id = tf.tournament_id)
UNION ALL
SELECT 'reinstatement_fees not copied', count(*)
  FROM reinstatement_fees rf
 WHERE NOT EXISTS (
   SELECT 1 FROM club_fees c
    WHERE c.fee_type = 'reinstatement'
      AND c.player_id = rf.player_id
      AND c.ban_started_at = rf.ban_started_at);

-- And the money, per kind, to compare against SECTION 1.
SELECT fee_type,
       count(*) AS rows,
       count(*) FILTER (WHERE paid_at IS NOT NULL) AS paid_rows,
       coalesce(sum(amount_cents), 0) AS cents
  FROM club_fees
 GROUP BY fee_type
 ORDER BY fee_type;


-- ------------------------------------------------------------
-- SECTION 4 — OPTIONAL. Entries that never had a fee row at all.
-- ------------------------------------------------------------
-- WHY THIS EXISTS. Before 00094 a tournament fee row only appeared when an exec
-- marked one PAID. Somebody entered and unpaid had no row anywhere, and the
-- member's /fees screen guessed a price by walking their entries and reading
-- the tournament's default tier. The screen now reads the ledger, so those
-- entries are invisible to it until a row exists.
--
-- This mints the missing rows, UNPAID, at the price the entrant's membership
-- says they should pay — the same rule selectFeeTier applies at registration:
--
--   0  a tier that names their membership, fewest memberships first
--   1  a tier that names nobody — the general price
--   2  the tournament's default tier
--
-- and no row at all where the tournament has no usable tier, which is the same
-- "never refuse, never invent a price" rule the code follows.
--
-- Withdrawn entries are excluded, matching every screen that lists entrants.
-- is_exec / fee_exempt members are excluded, matching ensureEntryFees and every
-- fee roster in the app.
--
-- RUN SECTION 4a FIRST — it is the same query as a SELECT, so you can see
-- exactly who would be billed and for how much before anything is written.

-- 4a — READ ONLY
WITH entrants AS (
  SELECT DISTINCT ev.tournament_id, p.player_id
    FROM tournament_participants p
    JOIN tournament_events ev ON ev.id = p.event_id
   WHERE p.status <> 'withdrawn'
  UNION
  SELECT DISTINCT ev.tournament_id, pr.player1_id
    FROM tournament_pairs pr
    JOIN tournament_events ev ON ev.id = pr.event_id
   WHERE pr.status <> 'withdrawn'
  UNION
  SELECT DISTINCT ev.tournament_id, pr.player2_id
    FROM tournament_pairs pr
    JOIN tournament_events ev ON ev.id = pr.event_id
   WHERE pr.status <> 'withdrawn'
)
SELECT t.name AS tournament, pl.full_name, pl.membership_type,
       tier.name AS tier, tier.amount_cents
  FROM entrants e
  JOIN tournaments t ON t.id = e.tournament_id
  JOIN players pl ON pl.id = e.player_id
                 AND pl.is_exec = FALSE AND pl.fee_exempt = FALSE
  LEFT JOIN LATERAL (
    SELECT ft.id, ft.name, ft.amount_cents
      FROM tournament_fee_tiers ft
     WHERE ft.tournament_id = e.tournament_id
       AND (ft.applies_to IS NULL
            OR pl.membership_type = ANY (ft.applies_to)
            OR ft.is_default)
     ORDER BY CASE
                WHEN ft.applies_to IS NOT NULL
                     AND pl.membership_type = ANY (ft.applies_to) THEN 0
                WHEN ft.applies_to IS NULL THEN 1
                ELSE 2
              END,
              coalesce(array_length(ft.applies_to, 1), 0),
              ft.sort_order, ft.name
     LIMIT 1
  ) tier ON TRUE
 WHERE NOT EXISTS (
   SELECT 1 FROM club_fees c
    WHERE c.fee_type = 'tournament'
      AND c.player_id = e.player_id
      AND c.tournament_id = e.tournament_id)
 ORDER BY t.name, pl.full_name;

-- 4b — THE WRITE. Identical query, wrapped in an INSERT.
BEGIN;

WITH entrants AS (
  SELECT DISTINCT ev.tournament_id, p.player_id
    FROM tournament_participants p
    JOIN tournament_events ev ON ev.id = p.event_id
   WHERE p.status <> 'withdrawn'
  UNION
  SELECT DISTINCT ev.tournament_id, pr.player1_id
    FROM tournament_pairs pr
    JOIN tournament_events ev ON ev.id = pr.event_id
   WHERE pr.status <> 'withdrawn'
  UNION
  SELECT DISTINCT ev.tournament_id, pr.player2_id
    FROM tournament_pairs pr
    JOIN tournament_events ev ON ev.id = pr.event_id
   WHERE pr.status <> 'withdrawn'
)
INSERT INTO club_fees (
  fee_type, player_id, tournament_id, tier_id, season_id, amount_cents, paid_at
)
SELECT 'tournament', e.player_id, e.tournament_id, tier.id, t.season_id,
       tier.amount_cents, NULL
  FROM entrants e
  JOIN tournaments t ON t.id = e.tournament_id
  JOIN players pl ON pl.id = e.player_id
                 AND pl.is_exec = FALSE AND pl.fee_exempt = FALSE
  LEFT JOIN LATERAL (
    SELECT ft.id, ft.amount_cents
      FROM tournament_fee_tiers ft
     WHERE ft.tournament_id = e.tournament_id
       AND (ft.applies_to IS NULL
            OR pl.membership_type = ANY (ft.applies_to)
            OR ft.is_default)
     ORDER BY CASE
                WHEN ft.applies_to IS NOT NULL
                     AND pl.membership_type = ANY (ft.applies_to) THEN 0
                WHEN ft.applies_to IS NULL THEN 1
                ELSE 2
              END,
              coalesce(array_length(ft.applies_to, 1), 0),
              ft.sort_order, ft.name
     LIMIT 1
  ) tier ON TRUE
 WHERE NOT EXISTS (
   SELECT 1 FROM club_fees c
    WHERE c.fee_type = 'tournament'
      AND c.player_id = e.player_id
      AND c.tournament_id = e.tournament_id)
ON CONFLICT DO NOTHING;

COMMIT;
