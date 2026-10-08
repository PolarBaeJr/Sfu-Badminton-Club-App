-- ============================================================
-- 00065 — the fee ledgers get the uniqueness the code assumed
--
-- Both tables feed a "Collected this season" figure that is a
-- plain SUM(amount_cents) over rows with paid_at IS NOT NULL
-- (apps/admin/src/app/fees/page.tsx, dashboard/page.tsx). Any
-- path that can file the same payment twice therefore does not
-- just leave a stray row — it overstates real money.
--
-- What was actually enforced before this file:
--
--   reinstatement_fees: reinstatement_fees_pkey (id). Nothing
--     else. Two clicks on Unban = two paid rows.
--
--   club_fees: club_fees_player_id_season_id_key
--     UNIQUE (player_id, season_id) — which markFeePaid/waiveFee
--     already upsert onto, so the per-player path was safe. But
--     player_id is NULLABLE and NULLs are distinct in Postgres,
--     and addManualFee inserts player_id = NULL. Every manual
--     entry was outside the constraint.
--
-- Checked against production before writing: zero duplicates in
-- either table (1 reinstatement row, 1 club_fees row), so both
-- indexes below build cleanly and no payment record is at risk.
-- ============================================================

-- ------------------------------------------------------------
-- club_fees — close the manual-entry hole
-- ------------------------------------------------------------
-- The table's own CHECK is num_nonnulls(player_id, manual_name) = 1, so
-- "player_id IS NULL" is exactly "this is a manual, name-keyed entry" and
-- manual_name is guaranteed present inside the predicate.
--
-- The key is the pair the money actually hangs off: one person, one season
-- fee. Normalised (lower + btrim) because 'John Smith' typed twice with
-- different capitalisation or a trailing space is the double-submit this is
-- here to stop, not a second payer.
--
-- The tradeoff, stated plainly: two genuinely different people with the same
-- name paying in the same season now collide. That is rarer than a
-- double-click, it fails closed rather than silently inflating income, and the
-- admin resolves it by disambiguating the name ('John Smith (2)'). addManualFee
-- turns the 23505 into that instruction rather than a generic failure.
CREATE UNIQUE INDEX IF NOT EXISTS club_fees_manual_name_season_key
  ON club_fees (season_id, lower(btrim(manual_name)))
  WHERE player_id IS NULL;

COMMENT ON INDEX club_fees_manual_name_season_key IS
  'One manual (name-keyed) club fee per name per season. club_fees_player_id_season_id_key does not cover these rows because player_id is NULL there and NULLs are distinct.';

-- ------------------------------------------------------------
-- reinstatement_fees — key the fee to the ban it lifted
-- ------------------------------------------------------------
-- UNIQUE (player_id) would be wrong: a member can legitimately be banned and
-- reinstated more than once over their time at the club, and the second
-- reinstatement is a second, real payment. The thing that must not happen twice
-- is a fee for the SAME ban.
--
-- There is no bans table to point at, so the ban episode is identified by when
-- it started. reinstatePlayer snapshots players.banned_at before clearing it
-- and writes it here, which makes two concurrent reinstatements of one ban
-- collide (both racers read the same banned_at) while a genuine later ban gets
-- a different value and passes.
ALTER TABLE reinstatement_fees
  ADD COLUMN IF NOT EXISTS ban_started_at TIMESTAMPTZ;

-- Backfill: rows written before this column existed have no recorded ban start.
-- created_at is the closest true statement about them — the fee was filed at
-- reinstatement time — and it is distinct per row, so NOT NULL holds and no
-- existing row is invented into a collision.
UPDATE reinstatement_fees
   SET ban_started_at = created_at
 WHERE ban_started_at IS NULL;

-- Deliberately no DEFAULT. A future insert that forgets to name the ban it is
-- settling should fail loudly rather than quietly mint a unique now() and slip
-- past the index this file exists to add.
ALTER TABLE reinstatement_fees
  ALTER COLUMN ban_started_at SET NOT NULL;

COMMENT ON COLUMN reinstatement_fees.ban_started_at IS
  'players.banned_at of the ban this reinstatement lifted, snapshotted before the ban was cleared. Identifies the ban episode; with the unique index below it makes one fee per ban, while still allowing a fee for a genuine later ban.';

CREATE UNIQUE INDEX IF NOT EXISTS reinstatement_fees_player_ban_key
  ON reinstatement_fees (player_id, ban_started_at);

COMMENT ON INDEX reinstatement_fees_player_ban_key IS
  'One reinstatement fee per player per ban episode. Backstop for the is_banned precondition in reinstatePlayer, which catches the sequential double-click but not two concurrent submits.';
