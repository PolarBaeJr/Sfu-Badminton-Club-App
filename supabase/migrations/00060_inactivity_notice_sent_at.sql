-- ============================================================
-- 00059_inactivity_notice_sent_at.sql — remember that we told
-- somebody their membership went inactive
--
-- The club owner asked for an email when an account is marked
-- inactive. The job that marks people inactive runs EVERY NIGHT
-- and re-evaluates the same rows, so "who is inactive" is not a
-- usable trigger on its own — it would re-mail the same member
-- until they came back. Nor is "they only transition once" true:
-- a member can lapse, be restored, and lapse again, and the
-- second notice is legitimate.
--
-- So the fact of having sent it is stored. NULL means "not told
-- yet"; the sweep in the admin console
-- (/api/cron/inactivity-notices) stamps it after a successful
-- send, and every path that puts a member back on the active
-- roster clears it again:
--
--   * reactivateLapsedMember()  — members' app, sign-in
--   * updatePlayer({ active_flag: true }) — console Restore
--
-- Service-role reads only. Deliberately NOT added to the
-- players_self view: it is bookkeeping about mail we sent, not
-- something a member's own session needs, and every writer of it
-- holds the service key.
-- ============================================================

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS inactivity_notice_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN players.inactivity_notice_sent_at IS
  'When the "your membership is now inactive" email was sent. NULL = not sent. Cleared whenever active_flag goes back to true, so a second lapse is notified again.';

-- Backfill: anyone ALREADY deactivated when this ships is treated
-- as having been told. They were deactivated before the email
-- existed, and the sweep's first run would otherwise mail the
-- entire historical inactive roster at once — surprise bulk mail
-- to lapsed addresses is precisely the shape that earns spam
-- complaints, and a complaint rate is what suspends sending.
--
-- On prod today this matches zero rows (7 players, none inactive),
-- so it is a no-op there and a guard everywhere else.
UPDATE players
   SET inactivity_notice_sent_at = NOW()
 WHERE active_flag = FALSE
   AND inactivity_notice_sent_at IS NULL;

-- The sweep's WHERE clause, so it never scans the roster.
-- Partial: only deactivated, un-notified rows are ever candidates,
-- which is normally an empty set.
CREATE INDEX IF NOT EXISTS idx_players_inactivity_notice_pending
  ON players (active_flag)
  WHERE active_flag = FALSE AND inactivity_notice_sent_at IS NULL;
