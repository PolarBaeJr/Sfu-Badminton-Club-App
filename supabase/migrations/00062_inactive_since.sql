-- ============================================================
-- 00062_inactive_since.sql — record WHEN a membership lapsed
--
-- The retention clock added in 00064 is measured from the moment
-- somebody went inactive, and nothing in the schema recorded
-- that. The three columns that look like they might are all the
-- wrong quantity, and picking one of them would have quietly
-- given the purge a meaning nobody chose:
--
--   last_active_at             — when they were last SEEN. This is
--     the input to the deactivation decision, not its output.
--     Keying a purge to it would collapse the two thresholds into
--     one clock and delete people 365 days after their last game
--     rather than 365 days after the club gave up on them.
--
--   updated_at                 — touched by every unrelated write.
--     An exec fixing a typo in somebody's display name would
--     restart their deletion countdown.
--
--   inactivity_notice_sent_at  — when the "you are now inactive"
--     EMAIL went out (00060). Tempting, and wrong twice over. It
--     is only stamped if mail succeeds, so a suppressed or bounced
--     address would never become purgeable; and 00061, which
--     schedules that sweep, is UNAPPLIED on prod, so the column is
--     NULL for everyone and a clock keyed to it would never start
--     at all.
--
-- Hence a column that means exactly one thing and is written by
-- exactly one event: the transition active -> inactive.
-- ============================================================

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS inactive_since TIMESTAMPTZ;

COMMENT ON COLUMN players.inactive_since IS
  'When active_flag last went true -> false because the inactivity clock ran out. NULL = not lapsed, or deactivated by some other route (admin removal, deletion request, manual). Cleared on every reactivation. Only a non-NULL value starts the retention clock in 00064.';

-- NO BACKFILL, deliberately.
--
-- Existing deactivated rows have no recoverable lapse date — the
-- event was never recorded, which is why this column exists. The
-- two candidate backfills are both worse than leaving NULL:
--
--   NOW()          — invents a lapse date of "today" for people who
--                    may have lapsed years ago, which is at least
--                    safe but is a fiction the purge would then act
--                    on in a year.
--   last_active_at — dates the lapse to before it happened, so the
--                    first purge run after 00064 ships could find
--                    rows ALREADY past 365 days and delete them on
--                    day one. This is the failure this whole design
--                    is meant to make impossible.
--
-- NULL means "never purgeable", so pre-existing inactive rows are
-- permanently excluded until somebody deliberately does something
-- about them. On prod today this is academic: 7 players, 0 inactive
-- (verified 2026-08-06), so there is nothing to back-fill either way.

-- The purge view's WHERE clause. Partial, because the eligible set
-- is normally empty and should never cost a roster scan.
CREATE INDEX IF NOT EXISTS idx_players_inactive_since
  ON players (inactive_since)
  WHERE active_flag = FALSE AND inactive_since IS NOT NULL;
