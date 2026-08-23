-- 00161_schema_migrations.sql
--
-- Until now there has been no record of which migrations are applied. The files
-- are forward-only and numbered, so the numbering *implies* an order, but the
-- database has never stored what it actually ran. That gap has bitten us: 00158
-- exists as a number but was never applied anywhere, and nothing in the database
-- says so.
--
-- This table closes the gap going forward. It deliberately does NOT try to
-- reconstruct history it cannot know:
--
--   applied_by = 'backfill'  the row was inferred from the migration files present
--                            on deploy/docker-prod at the time this ran. It is a
--                            best-effort claim, not an observation. verified = false.
--   applied_by = 'runner'    scripts/db-migrate.sh applied the file itself and
--                            watched it succeed. verified = true.
--
-- Anything a human applies by hand outside the runner will simply not be here,
-- and `db-migrate.sh status` will report it as pending. That is the intended
-- failure mode: the runner under-claims rather than over-claims.

BEGIN;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version      TEXT        PRIMARY KEY,
  name         TEXT        NOT NULL,
  checksum     TEXT        NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by   TEXT        NOT NULL,
  -- false means "we believe this ran but did not watch it run"
  verified     BOOLEAN     NOT NULL DEFAULT false,
  CONSTRAINT schema_migrations_applied_by_known
    CHECK (applied_by IN ('backfill', 'runner', 'manual'))
);

COMMENT ON TABLE public.schema_migrations IS
  'One row per applied migration file. See 00161 for what verified=false means.';
COMMENT ON COLUMN public.schema_migrations.checksum IS
  'sha256 of the file as it stood when recorded. A mismatch means the file was '
  'edited after it was applied, which the runner reports but does not treat as fatal.';

-- The table is metadata about the schema, not application data. No client should
-- ever read it through PostgREST, so it gets RLS on with no policies: nothing
-- reaching it through the API can see a row. The runner is unaffected because it
-- connects as the postgres superuser over docker exec, not through PostgREST.
ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.schema_migrations FROM anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
