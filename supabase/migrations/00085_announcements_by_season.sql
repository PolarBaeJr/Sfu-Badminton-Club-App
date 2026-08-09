-- Announcements belong to a season, or to none of them on purpose.
--
-- Everything else season-scoped got a season months ago; announcements never
-- did. So the feed is cumulative forever: come the rollover, last term's
-- "Courts closed for reading week" is still pinned above this term's, and there
-- is no way to retire it short of deleting it — which throws away the record of
-- having said it. The feed is the one place members actually look.
--
-- TWO columns rather than one, because "no season" has two different meanings
-- and collapsing them is what makes a NULL ambiguous everywhere else in this
-- schema:
--
--   all_seasons = true   this is evergreen. Club rules, the door code, how to
--                        pay dues. Deliberately not tied to a term.
--   season_id            it belongs to exactly one season and retires with it.
--
-- The CHECK makes those the only two shapes, so no row can be both or neither
-- and no reader has to guess which a NULL meant.
--
-- EXISTING ROWS become all_seasons = true. They were written before the app had
-- the concept, so nobody chose a season for them, and guessing one from
-- created_at would silently retire announcements that are still current. Staying
-- visible is what they do today; this migration does not change that for a
-- single existing row.

BEGIN;

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES seasons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS all_seasons boolean NOT NULL DEFAULT true;

-- Explicit rather than relying on the DEFAULT, so re-running this on a database
-- where the column already exists still lands every legacy row in the same
-- state.
UPDATE announcements SET all_seasons = true WHERE season_id IS NULL;

ALTER TABLE announcements
  DROP CONSTRAINT IF EXISTS announcements_season_shape;
ALTER TABLE announcements
  ADD CONSTRAINT announcements_season_shape
  CHECK (
    (all_seasons AND season_id IS NULL)
    OR (NOT all_seasons AND season_id IS NOT NULL)
  );

-- The player feed reads "this season's, plus the evergreen ones" on every load.
CREATE INDEX IF NOT EXISTS announcements_season_idx
  ON announcements (season_id)
  WHERE NOT all_seasons;

-- ON DELETE SET NULL above would break the CHECK for a season-scoped row whose
-- season is deleted (season_id becomes NULL while all_seasons stays false), so
-- carry it to the evergreen shape instead. Deleting a season is rare and this is
-- the honest outcome: the announcement survives, unattached, still visible,
-- rather than the season delete failing on a constraint nobody expected.
CREATE OR REPLACE FUNCTION announcements_orphaned_to_evergreen()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  UPDATE announcements
     SET all_seasons = true, season_id = NULL
   WHERE season_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS announcements_orphaned_to_evergreen_trg ON seasons;
CREATE TRIGGER announcements_orphaned_to_evergreen_trg
  BEFORE DELETE ON seasons
  FOR EACH ROW EXECUTE FUNCTION announcements_orphaned_to_evergreen();

COMMIT;
