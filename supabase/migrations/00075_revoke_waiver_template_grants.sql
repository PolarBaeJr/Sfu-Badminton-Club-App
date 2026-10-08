-- ============================================================
-- 00075 — event_waiver_templates does not belong to anon
--
-- 00074 enabled RLS with no policies, reasoning that no policy means no access.
-- That is true for SELECT/INSERT/UPDATE/DELETE and false for TRUNCATE, which is
-- a table-level operation and bypasses row security entirely. Supabase's
-- default privileges grant the full set on every new table in `public`, so the
-- table shipped with anon and authenticated holding TRUNCATE, DELETE, UPDATE,
-- INSERT and SELECT.
--
-- This is the same hole 00072 closed on players and seven other tables, hours
-- earlier, reintroduced by the next new table. RLS-with-no-policies is not a
-- substitute for an explicit REVOKE: the sibling migration 00073 revoked
-- explicitly and its two tables came out clean.
--
-- Nothing legitimate loses access. Both readers and the writer use the
-- service-role client, which is not subject to these grants.
-- ============================================================

REVOKE ALL ON public.event_waiver_templates FROM anon, authenticated;
GRANT ALL ON public.event_waiver_templates TO service_role;
