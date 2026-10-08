-- ============================================================
-- 00012_account_deletion.sql — self-service account deletion
--
-- Adds players.deletion_requested_at, set when a player requests
-- deletion of their own account. The account is deactivated
-- immediately (active_flag = false) but nothing is destroyed:
-- signing back in within 30 days lets the player restore it
-- (and an admin can cancel the deletion too). After 30 days the
-- purge-deleted-accounts edge function anonymizes the row and
-- deletes the auth user. The column stays set on anonymized
-- rows as a tombstone so they remain identifiable.
-- ============================================================

ALTER TABLE players ADD COLUMN deletion_requested_at TIMESTAMPTZ;
