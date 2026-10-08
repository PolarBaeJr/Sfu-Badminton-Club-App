-- ============================================================
-- 00043_season_term_year.sql — seasons get a term and a year
-- ============================================================
-- seasons.name is free text ("Fall 2026"). That is fine to display and useless
-- to select by: a season picker built on it is a list of arbitrary strings that
-- cannot be ordered correctly ("Fall 2026" sorts before "Spring 2026") and
-- cannot be split into the two dropdowns the admin UI wants.
--
-- term + year are the real identity of a season. name stays, derived from them
-- on write, so every existing query and every page that prints season.name
-- keeps working untouched.
--
-- Terms are the three the club actually runs. Ordered fall -> spring -> summer
-- to match the academic year rather than the calendar: at a university the year
-- starts in September, so Fall 2026 precedes Spring 2027, and enum order is
-- what ORDER BY will use.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE season_term AS ENUM ('fall', 'spring', 'summer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE seasons ADD COLUMN IF NOT EXISTS term season_term;
ALTER TABLE seasons ADD COLUMN IF NOT EXISTS year  INTEGER;

-- Backfill from the existing names. Deliberately tolerant: anything that does
-- not parse is left NULL rather than guessed at, and the NOT NULL constraints
-- below are only applied if every row resolved.
UPDATE seasons
   SET term = CASE
                WHEN name ILIKE '%fall%'   THEN 'fall'::season_term
                WHEN name ILIKE '%spring%' THEN 'spring'::season_term
                WHEN name ILIKE '%summer%' THEN 'summer'::season_term
              END
 WHERE term IS NULL;

-- Prefer a 4-digit year in the name; fall back to the start_date, which is
-- always present and is the better answer for a season named something odd.
UPDATE seasons
   SET year = COALESCE(
                NULLIF(substring(name FROM '(\d{4})'), '')::INTEGER,
                EXTRACT(YEAR FROM start_date)::INTEGER
              )
 WHERE year IS NULL;

-- Only tighten if the backfill was total. On a database with an unparseable
-- season name this leaves the columns nullable rather than failing the
-- migration outright — the admin can fix the row and re-run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seasons WHERE term IS NULL OR year IS NULL) THEN
    ALTER TABLE seasons ALTER COLUMN term SET NOT NULL;
    ALTER TABLE seasons ALTER COLUMN year SET NOT NULL;
    -- One season per term per year. Two "Fall 2026" rows would make the picker
    -- ambiguous and silently split a season's matches across both.
    BEGIN
      ALTER TABLE seasons ADD CONSTRAINT seasons_term_year_unique UNIQUE (term, year);
    EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
    END;
  ELSE
    RAISE NOTICE 'seasons.term/year left nullable: % row(s) did not parse',
      (SELECT count(*) FROM seasons WHERE term IS NULL OR year IS NULL);
  END IF;
END $$;

COMMENT ON COLUMN seasons.term IS
  'Which term this season covers. Enum order is fall -> spring -> summer, matching the academic year, so ORDER BY term sorts correctly within a year.';
COMMENT ON COLUMN seasons.year IS
  'Calendar year the term begins in. Fall 2026 and Spring 2027 are consecutive seasons of one academic year.';

-- name is now derived, so it can never drift from term/year. Kept as a real
-- column rather than a view or a generated column because it is selected by
-- name in a dozen places and GENERATED ALWAYS would forbid the plain INSERTs
-- those paths already do.
CREATE OR REPLACE FUNCTION set_season_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.term IS NOT NULL AND NEW.year IS NOT NULL THEN
    NEW.name := initcap(NEW.term::TEXT) || ' ' || NEW.year::TEXT;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_season_name ON seasons;
CREATE TRIGGER trg_set_season_name
  BEFORE INSERT OR UPDATE OF term, year ON seasons
  FOR EACH ROW EXECUTE FUNCTION set_season_name();
