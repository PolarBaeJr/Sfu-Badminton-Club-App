-- ============================================================
-- 00069 — a reinstatement fee belongs to a season
--
-- club_fees and tournament_fees both reach a season through a real column
-- (season_id directly, and tournaments.season_id). reinstatement_fees had
-- neither, so the income figure had to bucket it by paid_at — and money paid
-- outside every season window then belonged to no season and appeared in no
-- total at all.
--
-- That is not hypothetical. The one production row was paid 2026-08-06; Fall
-- 2026 starts 2026-09-01. A real $20 payment, correctly recorded, invisible
-- everywhere. Found by testing the income figure on staging and asking why it
-- read zero.
--
-- Nullable, deliberately. A reinstatement can be taken when no season is
-- active — between terms is exactly when a lapsed member comes back — and
-- refusing the payment because the club is between seasons would be worse than
-- recording it unattached. ON DELETE SET NULL for the same reason: deleting a
-- season must not delete the record that money changed hands.
-- ============================================================

ALTER TABLE reinstatement_fees
  ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES seasons(id) ON DELETE SET NULL;

COMMENT ON COLUMN reinstatement_fees.season_id IS
  'Season this reinstatement counts toward. Set from the active season when the fee is recorded. Nullable: a reinstatement can be taken between terms, and an unattached payment is better than a refused one.';

CREATE INDEX IF NOT EXISTS idx_reinstatement_fees_season
  ON reinstatement_fees (season_id);

-- Backfill, in order of confidence:
--   1. the season whose window actually contains paid_at
--   2. failing that, the next season to START after it — a fee taken in the
--      gap before a term opens is for that term, which is the real production
--      case above
--   3. failing that, the most recent season to have started before it, for a
--      payment after the last season ended
UPDATE reinstatement_fees f
SET season_id = COALESCE(
  (SELECT s.id FROM seasons s
    WHERE f.paid_at::date >= s.start_date
      AND (s.end_date IS NULL OR f.paid_at::date <= s.end_date)
    ORDER BY s.start_date DESC LIMIT 1),
  (SELECT s.id FROM seasons s
    WHERE s.start_date > f.paid_at::date
    ORDER BY s.start_date ASC LIMIT 1),
  (SELECT s.id FROM seasons s
    WHERE s.start_date <= f.paid_at::date
    ORDER BY s.start_date DESC LIMIT 1)
)
WHERE f.season_id IS NULL
  AND f.paid_at IS NOT NULL;
