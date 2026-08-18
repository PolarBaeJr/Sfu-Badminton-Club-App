-- ============================================================
-- mirror-public-acls.sql — emit the GRANTs that make a restored dev database
-- carry PRODUCTION's privileges, instead of a blanket GRANT ALL
-- ============================================================
-- HOW IT IS USED. Run this on the SOURCE (prod) with `psql -At`. It prints a
-- SQL script; pipe that into the TARGET (dev). It reads catalogues and writes
-- nothing, so running it against production is a read.
--
--   psql -At -f mirror-public-acls.sql prod | psql -v ON_ERROR_STOP=1 dev
--
-- WHY IT EXISTS. prod-to-dev-snapshot.sh used to finish with
--
--   GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
--   GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, ...;
--
-- because `pg_dump --no-acl` restores objects with no privileges at all and the
-- staging app would otherwise get "permission denied for schema public" on
-- every read. The blanket grant fixed that and broke something quieter: every
-- night it handed `anon` and `authenticated` EVERYTHING, including
--
--   * `purgeable_inactive_players` — a security_invoker=false VIEW, so RLS
--     never applies to it, listing the members queued for deletion. 00064:109
--     revokes it by name on prod; staging got it back every morning. This is
--     the drift 00157 cleans up, and this file is what stops it returning.
--   * every SECURITY DEFINER function 00126 spent a whole migration taking
--     away from the browser key — and the ALTER DEFAULT PRIVILEGES line meant
--     functions created by LATER migrations were born anon-executable too.
--
-- So staging, the database used to rehearse migrations before production sees
-- them, was the one place where the privacy migrations provably did not hold.
--
-- WHAT IT EMITS, and the one assumption behind it.
--
-- It names FOUR grantees and no others: PUBLIC, anon, authenticated,
-- service_role. Every Supabase database has those three roles, so the output
-- cannot fail on a role the target lacks — which is why this is a hand-written
-- catalogue query rather than simply dropping `--no-acl` from the dump. A dump
-- carrying prod's full ACLs would also carry grants to whatever else prod
-- names (dashboard_user, supabase_read_only_user, …), and one missing role
-- aborts the whole restore under ON_ERROR_STOP=1, at 4am, on a cron job.
--
-- It SKIPS any object whose ACL is NULL on the source. NULL is not "no
-- privileges" — it is "the built-in default for this object type", which for a
-- function means EXECUTE TO PUBLIC. Emitting a revoke for those would leave the
-- target STRICTER than the source. Skipping is correct only because the caller
-- drops and recreates the schema first, so every restored object starts at NULL
-- too and the two sides already agree. prod-to-dev-snapshot.sh does exactly
-- that, deliberately; if you reuse this file somewhere else, keep that order.
--
-- ------------------------------------------------------------

WITH
-- The four grantees, and nothing else. See the header.
sch AS (
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
         a.privilege_type, a.is_grantable
    FROM pg_namespace n, aclexplode(n.nspacl) a
   WHERE n.nspname = 'public'
     AND (a.grantee = 0 OR pg_get_userbyid(a.grantee)
          IN ('anon','authenticated','service_role'))
),
rel AS (
  SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind,
         format('%I.%I', n.nspname, c.relname) AS obj,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
         a.privilege_type, a.is_grantable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(c.relacl) a
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r','p','v','m','S','f')   -- table, partitioned, view, matview, sequence, foreign
     AND c.relacl IS NOT NULL
     AND (a.grantee = 0 OR pg_get_userbyid(a.grantee)
          IN ('anon','authenticated','service_role'))
),
rou AS (
  SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind,
         format('%I.%I(%s)', n.nspname, p.proname,
                pg_get_function_identity_arguments(p.oid)) AS obj,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
         a.privilege_type, a.is_grantable
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) a
   WHERE n.nspname = 'public'
     AND p.proacl IS NOT NULL
     AND (a.grantee = 0 OR pg_get_userbyid(a.grantee)
          IN ('anon','authenticated','service_role'))
),
dfl AS (
  SELECT quote_ident(pg_get_userbyid(d.defaclrole)) AS owner_role,
         CASE d.defaclobjtype WHEN 'r' THEN 'TABLES'
                              WHEN 'S' THEN 'SEQUENCES'
                              WHEN 'f' THEN 'FUNCTIONS'
                              WHEN 'T' THEN 'TYPES'
                              WHEN 'n' THEN 'SCHEMAS' END AS kind,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
         a.privilege_type, a.is_grantable
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace,
         aclexplode(d.defaclacl) a
   WHERE n.nspname = 'public'
     AND (a.grantee = 0 OR pg_get_userbyid(a.grantee)
          IN ('anon','authenticated','service_role'))
),
stmts AS (
  -- 0. a marker, so the applied script is identifiable in a psql log
  SELECT 0 AS ord, '' AS obj, 0 AS sub,
         '-- privileges mirrored from the snapshot source' AS stmt

  -- 1. the schema itself
  UNION ALL
  SELECT 10, '', 0,
         'REVOKE ALL ON SCHEMA public FROM PUBLIC, anon, authenticated, service_role;'
   WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public' AND nspacl IS NOT NULL)
  UNION ALL
  SELECT 10, '', 1,
         format('GRANT %s ON SCHEMA public TO %s%s;', privs, grantee,
                CASE WHEN is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
    FROM (SELECT grantee, is_grantable,
                 string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
            FROM sch GROUP BY grantee, is_grantable) s

  -- 2. tables, views, matviews, sequences
  UNION ALL
  SELECT 20, obj, 0,
         format('REVOKE ALL ON %s %s FROM PUBLIC, anon, authenticated, service_role;', kind, obj)
    FROM (SELECT DISTINCT kind, obj FROM rel) r
  UNION ALL
  SELECT 20, obj, 1,
         format('GRANT %s ON %s %s TO %s%s;', privs, kind, obj, grantee,
                CASE WHEN is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
    FROM (SELECT kind, obj, grantee, is_grantable,
                 string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
            FROM rel GROUP BY kind, obj, grantee, is_grantable) r

  -- 3. functions and procedures
  UNION ALL
  SELECT 30, obj, 0,
         format('REVOKE ALL ON %s %s FROM PUBLIC, anon, authenticated, service_role;', kind, obj)
    FROM (SELECT DISTINCT kind, obj FROM rou) f
  UNION ALL
  SELECT 30, obj, 1,
         format('GRANT %s ON %s %s TO %s%s;', privs, kind, obj, grantee,
                CASE WHEN is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
    FROM (SELECT kind, obj, grantee, is_grantable,
                 string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
            FROM rou GROUP BY kind, obj, grantee, is_grantable) f

  -- 4. default privileges. The reset names `postgres` explicitly because that
  --    is the role the old blanket line ran as, and its entries outlive a
  --    schema drop only if somebody re-created them by hand since.
  UNION ALL
  SELECT 40, k, 0,
         format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
                'REVOKE ALL ON %s FROM PUBLIC, anon, authenticated, service_role;', k)
    FROM unnest(ARRAY['TABLES','SEQUENCES','FUNCTIONS','TYPES']) AS k
  UNION ALL
  SELECT 40, kind, 1,
         format('ALTER DEFAULT PRIVILEGES FOR ROLE %s IN SCHEMA public '
                'GRANT %s ON %s TO %s%s;', owner_role, privs, kind, grantee,
                CASE WHEN is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
    FROM (SELECT owner_role, kind, grantee, is_grantable,
                 string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privs
            FROM dfl GROUP BY owner_role, kind, grantee, is_grantable) d
)
SELECT stmt FROM stmts ORDER BY ord, obj, sub, stmt;
