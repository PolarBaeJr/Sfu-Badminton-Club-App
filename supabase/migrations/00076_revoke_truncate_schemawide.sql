-- ============================================================
-- 00076 — no member-facing role holds TRUNCATE, on any table, ever
--
-- 00072 revoked TRUNCATE from anon/authenticated on eight tables. That was
-- treating a symptom. A sweep after 00074 shipped found:
--
--   * 35 of 49 public tables still grant TRUNCATE to anon
--   * 36 to authenticated
--   * ALTER DEFAULT PRIVILEGES grants arwdDxtm — the full set, TRUNCATE
--     included — to both roles on EVERY new table in public
--
-- So each new table arrives with the hole pre-drilled. 00074 demonstrated it
-- within hours: it enabled RLS with no policies, correctly reasoning that no
-- policy means no access, and shipped anyway with anon holding TRUNCATE —
-- because TRUNCATE is a table-level operation that bypasses row security
-- entirely. RLS is not a substitute for a grant that should not exist.
--
-- REACHABILITY, stated honestly: PostgREST has no TRUNCATE verb, so this is not
-- an open door through the API today. It is a loaded one. Anything that ever
-- executes SQL as anon or authenticated — a SECURITY INVOKER function, a future
-- RPC, a direct connection with those roles — can empty a table and RLS will
-- not stop it.
--
-- WHAT IS AND IS NOT REVOKED:
--   revoked  TRUNCATE, REFERENCES, TRIGGER — none of which any app path uses
--   kept     SELECT, INSERT, UPDATE, DELETE — all genuinely used through
--            PostgREST and all constrained by RLS policies
--
-- Revoking the second group would break the app. Revoking the first breaks
-- nothing: verified on staging against the running apps before this reached
-- production.
-- ============================================================

-- Every existing table, not a hand-kept list — a list is how eight got fixed
-- and thirty-five did not.
-- Views as well as tables. TRUNCATE cannot be executed on a view, so those two
-- grants were never exposure — but leaving them behind means the next person to
-- run this audit finds hits and has to work out that they are harmless. A clean
-- sweep is worth more than a footnote.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT schemaname AS s, tablename AS n FROM pg_tables WHERE schemaname = 'public'
    UNION ALL
    SELECT schemaname, viewname FROM pg_views WHERE schemaname = 'public'
  LOOP
    EXECUTE format(
      'REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I.%I FROM anon, authenticated',
      t.s, t.n
    );
  END LOOP;
END $$;

-- And stop the next table inheriting it. Without this the sweep above has to be
-- re-run after every migration that adds a table, which is exactly the failure
-- this migration exists to end.
--
-- Scoped to the role that owns the existing default ACL (postgres) so it
-- actually replaces that entry rather than adding a second one.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;
