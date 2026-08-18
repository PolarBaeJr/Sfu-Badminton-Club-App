-- ============================================================
-- mirror-public-publications.sql — put the public tables back into the
-- publications they were in, after a schema drop and restore
-- ============================================================
-- HOW IT IS USED, exactly like its sibling: run on the SOURCE (prod) with
-- `psql -At`, pipe the output into the TARGET (dev). It only reads.
--
-- WHY IT EXISTS. A publication is a DATABASE-level object, but its membership
-- is a property of the TABLE. `pg_dump --schema=public` dumps neither: grep a
-- dump for PUBLICATION and you get zero hits. So dropping and restoring the
-- public schema leaves `supabase_realtime` still existing and completely
-- EMPTY — and an empty publication is not an error anywhere, it is a realtime
-- feed that silently never fires again. Every live badge, every auto-refreshing
-- match card and the whole door page stop updating on staging, with nothing in
-- any log, until somebody re-adds 12 tables by hand.
--
-- Measured, not assumed: a fixture publication holding one public table came
-- back from a drop-and-restore holding zero, and `grep -c PUBLICATION` on the
-- dump is 0. REPLICA IDENTITY is the opposite case and needs nothing from this
-- file — pg_dump does emit `ALTER TABLE ... REPLICA IDENTITY FULL`, so that
-- half survives on its own.
--
-- This was already true of the snapshot script before it grew this step. It is
-- not a regression being fixed; it is a hole that was always there and that
-- nobody would ever see as an error.
--
-- The guards are for a cron job at 4am, not for elegance: a publication the
-- target does not have raises a NOTICE and is skipped rather than aborting the
-- run under ON_ERROR_STOP=1, a table already present is skipped so the script
-- is re-runnable, and FOR ALL TABLES publications are left alone because
-- ADD TABLE is an error on those and they need no help anyway.
-- ------------------------------------------------------------

SELECT format(
  $fmt$DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = %L) THEN
    RAISE NOTICE 'publication %% does not exist here, skipping table %%', %L, %L;
  ELSIF EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = %L AND schemaname = 'public' AND tablename = %L) THEN
    NULL;  -- already a member
  ELSE
    EXECUTE format('ALTER PUBLICATION %%I ADD TABLE public.%%I', %L, %L);
  END IF;
END $do$;$fmt$,
  p.pubname, p.pubname, t.tablename, p.pubname, t.tablename, p.pubname, t.tablename)
FROM pg_publication_tables t
JOIN pg_publication p ON p.pubname = t.pubname
WHERE t.schemaname = 'public'
  AND NOT p.puballtables
ORDER BY t.pubname, t.tablename;
