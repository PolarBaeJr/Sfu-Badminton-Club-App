-- ============================================================
-- 00094 — three fee ledgers become one
--
-- "just wanted to have less db tables around" — the club owner, and the
-- reason this file exists. club_fees, tournament_fees and reinstatement_fees
-- are the same table three times: (who, how much, when it was paid, how, and
-- the transaction id). They differ only in what the money was FOR, which is a
-- column, not a schema. Keeping them apart cost:
--
--   * a member's /fees screen reading three tables and merging them by hand,
--   * season income summing three ledgers and being wrong about one of them
--     for months (00069), and
--   * "what does this person owe" having no single answer anywhere.
--
-- After this file club_fees carries all three, tagged by fee_type. The rows
-- do NOT move here — the data migration is run by hand, separately, once the
-- counts have been read. See the ORDER OF OPERATIONS note at the bottom.
--
-- THIS MIGRATION IS SAFE TO APPLY BEFORE THE CODE SHIPS. Every column added
-- is nullable or defaulted, every CHECK is satisfied by the existing rows
-- (all of which are dues), and nothing is dropped.
-- ============================================================

-- ------------------------------------------------------------
-- What the money is for
-- ------------------------------------------------------------
-- TEXT + CHECK rather than an enum. The three values are a closed set today,
-- but an enum cannot be extended inside a transaction on older servers and
-- the club has already invented one new kind of money this year (00073's
-- other_income). A CHECK is edited with one ALTER and no type surgery.
--
-- DEFAULT 'dues' is what makes this backward compatible: every existing row
-- IS a due, and every INSERT already written — markFeePaid, waiveFee,
-- addManualFee — keeps working untouched and keeps meaning what it meant.
ALTER TABLE club_fees
  ADD COLUMN IF NOT EXISTS fee_type TEXT NOT NULL DEFAULT 'dues';

ALTER TABLE club_fees DROP CONSTRAINT IF EXISTS club_fees_fee_type_check;
ALTER TABLE club_fees
  ADD CONSTRAINT club_fees_fee_type_check
  CHECK (fee_type IN ('dues', 'tournament', 'reinstatement'));

COMMENT ON COLUMN club_fees.fee_type IS
  'What this money is for: dues (season membership), tournament (entry fee) or reinstatement (price of lifting a ban). EVERY READER MUST FILTER ON IT — /admin/fees splits the club-fee ledger and the reinstatement ledger across two separate capabilities, so an unfiltered SELECT hands one to a holder of the other.';

-- ------------------------------------------------------------
-- The columns each kind needs
-- ------------------------------------------------------------
-- Named for what they are rather than folded into one generic "context"
-- column. A tournament fee genuinely points at a tournament and a
-- reinstatement genuinely identifies a ban episode; a jsonb blob would make
-- both unjoinable and unconstrainable, and the partial unique indexes below
-- are the whole reason the collapse is safe.

-- Entry fees. ON DELETE CASCADE preserves tournament_fees' behaviour exactly:
-- deleting a tournament already deleted its fee rows, and changing that here
-- would be a silent policy change smuggled in under a refactor.
ALTER TABLE club_fees
  ADD COLUMN IF NOT EXISTS tournament_id UUID REFERENCES tournaments(id) ON DELETE CASCADE;

-- Which tier priced it. SET NULL, as on tournament_fees: deleting a tier must
-- not delete the record that money changed hands, and amount_cents on the row
-- is the snapshot that survives.
ALTER TABLE club_fees
  ADD COLUMN IF NOT EXISTS tier_id UUID REFERENCES tournament_fee_tiers(id) ON DELETE SET NULL;

-- Reinstatements. ban_started_at identifies WHICH ban this fee settled — see
-- 00065, which explains at length why a member can legitimately owe two
-- reinstatements and why the key cannot be player_id alone.
ALTER TABLE club_fees
  ADD COLUMN IF NOT EXISTS ban_started_at TIMESTAMPTZ;
ALTER TABLE club_fees
  ADD COLUMN IF NOT EXISTS ban_reason TEXT;

COMMENT ON COLUMN club_fees.tournament_id IS
  'The tournament this entry fee is for. NULL on every other fee_type.';
COMMENT ON COLUMN club_fees.tier_id IS
  'The tournament_fee_tiers row that priced this entry, recorded at entry time. amount_cents is the snapshot; this only says where the figure came from. Changing a member''s membership_type never re-prices an entry already made.';
COMMENT ON COLUMN club_fees.ban_started_at IS
  'players.banned_at of the ban this reinstatement lifted, snapshotted before the ban was cleared (00065). Identifies the ban episode.';
COMMENT ON COLUMN club_fees.ban_reason IS
  'Why the member was banned, copied onto the fee before players.ban_reason is cleared.';

-- ------------------------------------------------------------
-- season_id can no longer be NOT NULL, and must stop cascading
-- ------------------------------------------------------------
-- TWO SEPARATE DECISIONS, both taken elsewhere and both preserved here.
--
-- 1. NULLABLE. tournaments.season_id is nullable (ON DELETE SET NULL, 00001)
--    and reinstatement_fees.season_id is nullable ON PURPOSE — 00069 spells
--    it out: "a reinstatement can be taken when no season is active, and
--    refusing the payment because the club is between seasons would be worse
--    than recording it unattached". A NOT NULL column here would make those
--    rows unrepresentable. Dues keep the old guarantee through the shape
--    CHECK below, so nothing about the season fee gets looser.
--
-- 2. ON DELETE SET NULL, NOT CASCADE. club_fees' FK deletes the fee when the
--    season goes; reinstatement_fees' does not, and 00069 chose that
--    deliberately — "deleting a season must not delete the record that money
--    changed hands". Collapsing into a CASCADE column would silently reverse
--    that for every reinstatement and every entry fee. So the whole table
--    moves to SET NULL: a deleted season now orphans dues rows rather than
--    destroying them, which is the safer half of the disagreement and the one
--    that loses no money.
ALTER TABLE club_fees ALTER COLUMN season_id DROP NOT NULL;

ALTER TABLE club_fees DROP CONSTRAINT IF EXISTS club_fees_season_id_fkey;
ALTER TABLE club_fees
  ADD CONSTRAINT club_fees_season_id_fkey
  FOREIGN KEY (season_id) REFERENCES seasons(id) ON DELETE SET NULL;

COMMENT ON COLUMN club_fees.season_id IS
  'Season this money counts toward. NOT NULL for dues (enforced by club_fees_shape_check); nullable for the other two, because a tournament may have no season and a reinstatement may be taken between terms (00069). ON DELETE SET NULL so deleting a season cannot delete the record that money changed hands.';

-- ------------------------------------------------------------
-- One shape per kind
-- ------------------------------------------------------------
-- A single table holding three kinds of row is only honest if the database
-- knows which columns each kind may use. Without this a "dues" row could
-- carry a tournament_id, a reinstatement could carry a tier, and every reader
-- would have to defend against shapes nothing can actually produce.
--
-- The table's existing num_nonnulls(player_id, manual_name) = 1 still stands
-- and is untouched. It is why 'tournament' and 'reinstatement' only have to
-- say manual_name IS NULL to mean "a real player": the old CHECK supplies the
-- other half.
ALTER TABLE club_fees DROP CONSTRAINT IF EXISTS club_fees_shape_check;
ALTER TABLE club_fees
  ADD CONSTRAINT club_fees_shape_check CHECK (
    CASE fee_type
      WHEN 'dues' THEN
        season_id IS NOT NULL
        AND tournament_id IS NULL
        AND tier_id IS NULL
        AND ban_started_at IS NULL
        AND ban_reason IS NULL
      WHEN 'tournament' THEN
        tournament_id IS NOT NULL
        AND manual_name IS NULL
        AND ban_started_at IS NULL
        AND ban_reason IS NULL
      WHEN 'reinstatement' THEN
        ban_started_at IS NOT NULL
        AND manual_name IS NULL
        AND tournament_id IS NULL
        AND tier_id IS NULL
      ELSE FALSE
    END
  );

-- ------------------------------------------------------------
-- Uniqueness, one key per kind
-- ------------------------------------------------------------
-- THE CONSTRAINT THAT HAD TO GO. club_fees_player_id_season_id_key is
-- UNIQUE (player_id, season_id) — one fee per person per season — which is
-- exactly right for dues and flatly wrong for entry fees: a member entering
-- two tournaments in one term is two rows, and the old constraint would
-- refuse the second one.
--
-- So it becomes three partial indexes, one per kind, each keyed on the thing
-- that genuinely must not happen twice. 00065 exists because a fee filed
-- twice does not merely leave a stray row, it OVERSTATES REAL MONEY — every
-- income figure in the app is a plain SUM over paid rows. None of that
-- protection is being given up here; it is being made specific.
--
-- Consequence for the code, written down because it is not obvious: PostgREST
-- emits ON CONFLICT (cols) with no index predicate, so a partial unique index
-- cannot be inferred as an upsert arbiter. markFeePaid and
-- markTournamentFeePaid are therefore read-then-update-or-insert, the shape
-- waiveFee already used.
ALTER TABLE club_fees DROP CONSTRAINT IF EXISTS club_fees_player_id_season_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS club_fees_dues_player_season_key
  ON club_fees (player_id, season_id)
  WHERE fee_type = 'dues' AND player_id IS NOT NULL;

COMMENT ON INDEX club_fees_dues_player_season_key IS
  'One season fee per member per season. The partial replacement for club_fees_player_id_season_id_key, which could not survive entry fees (two tournaments in one term is two rows for one person and one season).';

-- Manual, name-keyed dues. 00065's index, narrowed to dues: entry fees and
-- reinstatements always have a real player, so they were never in scope, and
-- leaving the predicate wide would have made the index claim otherwise.
DROP INDEX IF EXISTS club_fees_manual_name_season_key;
CREATE UNIQUE INDEX IF NOT EXISTS club_fees_manual_name_season_key
  ON club_fees (season_id, lower(btrim(manual_name)))
  WHERE player_id IS NULL AND fee_type = 'dues';

COMMENT ON INDEX club_fees_manual_name_season_key IS
  'One manual (name-keyed) season fee per name per season. See 00065 for why it is normalised and what it trades away.';

-- tournament_fees' UNIQUE (tournament_id, player_id), carried across intact.
-- ONE ENTRY FEE PER TOURNAMENT, not per event: a member entering three events
-- at one tournament pays once, and this is what makes that true rather than
-- hoped for.
CREATE UNIQUE INDEX IF NOT EXISTS club_fees_tournament_player_key
  ON club_fees (tournament_id, player_id)
  WHERE fee_type = 'tournament';

COMMENT ON INDEX club_fees_tournament_player_key IS
  'One entry fee per member per tournament — NOT per event. Registration for a second event in the same tournament finds this row rather than minting another.';

-- reinstatement_fees_player_ban_key (00065), carried across intact. Keyed on
-- the ban episode and not on the player, because a member can genuinely be
-- banned and reinstated more than once and the second fee is real money.
CREATE UNIQUE INDEX IF NOT EXISTS club_fees_reinstatement_ban_key
  ON club_fees (player_id, ban_started_at)
  WHERE fee_type = 'reinstatement';

COMMENT ON INDEX club_fees_reinstatement_ban_key IS
  'One reinstatement fee per member per ban episode. See 00065: UNIQUE (player_id) would be wrong, because a later ban is a later, real payment.';

-- ------------------------------------------------------------
-- Access paths
-- ------------------------------------------------------------
-- idx_club_fees_season and idx_club_fees_player already exist (00002). These
-- are the two reads the collapse adds: "this tournament's fees" (the entry
-- roster) and "this kind of fee, this season" (every income sum, and the
-- /admin/fees roster now that it must say fee_type = 'dues').
CREATE INDEX IF NOT EXISTS idx_club_fees_tournament ON club_fees (tournament_id)
  WHERE tournament_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_club_fees_type_season ON club_fees (fee_type, season_id);

-- ------------------------------------------------------------
-- RLS: nothing to add, and that is worth stating
-- ------------------------------------------------------------
-- club_fees_select_own is USING (player_id = get_player_id(auth.uid())) and
-- club_fees_admin is USING (is_admin(auth.uid())) — identical to tf_select_own
-- / tf_admin and rf_select_own / rf_admin on the two tables being retired. A
-- member sees their own rows and no one else's, whatever the fee is for, so
-- the collapse neither widens nor narrows what the player app can read.
--
-- 00072 already revoked TRUNCATE, REFERENCES and TRIGGER on club_fees from
-- authenticated and anon, so the rows arriving here land under the same
-- grants they left.

-- ------------------------------------------------------------
-- Fee tiers price themselves off membership
-- ------------------------------------------------------------
-- "tier doesn't allow me to charge user based on status set? Manual assignment
-- is crazy annoying — we're already marking people as alumni and current
-- member" — the club owner.
--
-- 00040 added players.membership_type and said in its own header that it
-- drives "tournament eligibility and which fee tier applies". The eligibility
-- half shipped; this is the other half. Nothing linked a tier to a person, so
-- an exec picked one by hand for every entrant.
--
-- NULL MEANS "ANYONE", and that is what keeps every existing tier working
-- unchanged: a tier with no applies_to is the general price, exactly as it is
-- today. An empty array would mean "nobody", which is never what anyone
-- intends — it is the shape a UI produces when everything is deselected — so
-- the CHECK refuses it, same as tournaments_allowed_memberships_not_empty.
--
-- An ARRAY rather than a single membership because the groups are not ranked:
-- "internal + alumni" and "internal + external" are both real, and neither is
-- a prefix of the other. Same reasoning as 00040's allowed_memberships.
ALTER TABLE tournament_fee_tiers
  ADD COLUMN IF NOT EXISTS applies_to membership_type[];

ALTER TABLE tournament_fee_tiers
  DROP CONSTRAINT IF EXISTS tournament_fee_tiers_applies_to_not_empty;
ALTER TABLE tournament_fee_tiers
  ADD CONSTRAINT tournament_fee_tiers_applies_to_not_empty
  CHECK (applies_to IS NULL OR array_length(applies_to, 1) >= 1);

COMMENT ON COLUMN tournament_fee_tiers.applies_to IS
  'Membership groups this tier prices. NULL means anyone — the general price, and the default so existing tiers are unchanged. Resolution when more than one matches: most specific first (fewest memberships), then a NULL/anyone tier, then the is_default tier, then no fee. An entry is NEVER refused for want of a matching tier.';

-- ============================================================
-- ORDER OF OPERATIONS — read this before deploying the console
-- ============================================================
-- This file moves NO rows. Applying it and then deploying code that reads
-- club_fees only would make every existing tournament and reinstatement
-- record vanish from the UI until the data migration is run.
--
--   1. apply this migration
--   2. run the read-only count query from the branch report
--   3. run the data migration from the branch report, and re-run the counts
--   4. THEN deploy the code
--   5. 00095 drops the two emptied tables, once (3) has been verified
--
-- Steps 2-4 exist because the rows are the club's money and the owner reads
-- every statement before running it.
-- ============================================================
