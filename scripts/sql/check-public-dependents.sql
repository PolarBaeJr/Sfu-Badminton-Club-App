-- Anything OUTSIDE the public schema that depends on something INSIDE it.
--
-- WHY THIS EXISTS. prod-to-dev-snapshot.sh does `DROP SCHEMA public CASCADE`
-- on the target before restoring prod's dump into it. CASCADE is what makes the
-- restore succeed (the old `pg_dump --clean` emits a bare `DROP SCHEMA` with no
-- CASCADE, which aborts the whole run the moment the target holds anything the
-- source lacks). But CASCADE deletes dependents in OTHER schemas too, and
-- `pg_dump --schema=public` restores none of them: the dependent is gone and
-- nothing puts it back.
--
-- The textbook casualty is the Supabase signup trigger — an AFTER INSERT on
-- auth.users calling a public.handle_new_user(). CASCADE takes the trigger, the
-- restore recreates only the function, and from then on signup silently writes
-- no player row. Nothing errors. Nothing logs. The same goes for an extension
-- installed INTO public (`--schema=public` does not emit CREATE EXTENSION), a
-- foreign key from another schema into public.players, a view in another schema
-- selecting from public, and a column anywhere typed as a public enum.
--
-- This repo's own migrations put every trigger on a public table and never say
-- `SCHEMA public` on a CREATE EXTENSION — but the migrations are not the whole
-- database. Supabase's own init scripts run first, the club owner has run SQL by
-- hand, and `CREATE EXTENSION IF NOT EXISTS` is a silent no-op that tells you
-- nothing about where the extension actually landed. So this is a QUESTION PUT
-- TO THE LIVE DATABASE at 04:00, not an assumption checked once against a repo.
--
-- Contract: prints one line per dependent, prints nothing when there are none.
-- The caller treats any output as fatal and refuses to drop anything.
--
-- Run it with `psql -qAt -f` — without -q psql echoes the SET below into the
-- output as a literal "SET" line, which the caller would then count as a
-- dependent and refuse on. (That echo has bitten this directory once already.)
--
-- The `NOT LIKE '%public.%'` filter is what search_path = '' buys us: with an
-- empty search_path pg_describe_object schema-qualifies EVERYTHING, so a
-- dependent inside public is recognisable by its own name and the only rows left
-- are the ones that would not come back.
SET search_path = '';

WITH pub AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'public'),
-- Every object in public, keyed the way pg_depend keys its referents. Three
-- catalogues cover the cases that actually bite: relations (tables, views,
-- sequences), functions, and types (an enum used as a column type elsewhere).
pubobj AS (
  SELECT 'pg_catalog.pg_class'::pg_catalog.regclass::pg_catalog.oid AS cls, oid
    FROM pg_catalog.pg_class WHERE relnamespace = (SELECT oid FROM pub)
  UNION ALL
  SELECT 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, oid
    FROM pg_catalog.pg_proc  WHERE pronamespace = (SELECT oid FROM pub)
  UNION ALL
  SELECT 'pg_catalog.pg_type'::pg_catalog.regclass::pg_catalog.oid, oid
    FROM pg_catalog.pg_type  WHERE typnamespace = (SELECT oid FROM pub)
)
SELECT DISTINCT descr FROM (
  -- An extension whose home is public. pg_depend would not describe this as a
  -- dependency on a public object, so it needs its own arm.
  SELECT 'extension ' || e.extname AS descr
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
   WHERE n.nspname = 'public'
  UNION ALL
  -- deptype 'n' is a normal dependency (the FK, the trigger, the view's rule,
  -- the enum column); 'a' is auto. 'i' (internal) and 'e' (extension member)
  -- are deliberately excluded: those dependents die with their owner anyway and
  -- would only produce noise the caller has to refuse on.
  SELECT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
    FROM pg_catalog.pg_depend d
    JOIN pubobj p ON d.refclassid = p.cls AND d.refobjid = p.oid
   WHERE d.deptype IN ('n','a')
) q
WHERE descr NOT LIKE '%public.%'
ORDER BY 1;
