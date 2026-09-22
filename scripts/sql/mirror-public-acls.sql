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
-- The grantee list is `mirrored_grantees` below, and it is an ALLOWLIST on
-- purpose. Three of its entries are the roles every Supabase database has:
-- anon, authenticated, service_role (plus PUBLIC, which is not a role). A dump
-- carrying prod's full ACLs would instead carry grants to whatever else prod
-- happens to name (dashboard_user, supabase_read_only_user, …), and one
-- missing role aborts the whole restore under ON_ERROR_STOP=1, at 4am, on a
-- cron job. That is why this is a hand-written catalogue query rather than
-- simply dropping `--no-acl` from the dump.
--
-- THE FOURTH ROLE, `data_api_reader`, DOES NOT HAVE THAT PROPERTY, and adding
-- it is the reason this paragraph exists. It is created by migration 00241, so
-- a database that has not applied 00241 does not have it. It is here anyway
-- because leaving it out is worse: 00241 grants the data API's read role
-- column-level SELECT on two tables and EXECUTE on three functions, the
-- snapshot drops and recreates the schema nightly, and a mirror that ignores
-- the role would restore those tables every morning with the role holding
-- nothing. The symptom of that is not an error. It is a data API that returns
-- an empty member list, on the database we use to rehearse, which is the one
-- place the feed most needs to be honest.
--
-- Two things keep it from aborting the cron:
--
--   * Nothing is emitted for it unless the SOURCE actually grants to it. On a
--     source without 00241 the CTEs match zero rows and the output is byte
--     identical to what this file produced before the role existed.
--   * When the source DOES grant to it, the script opens with a guarded
--     CREATE ROLE so the GRANTs that follow land on a target that may not have
--     applied 00241 yet. That is a cluster-global side effect and it is
--     deliberate: a grantee is part of the privilege picture this file exists
--     to reproduce, and the alternative is wrapping every GRANT in its own
--     existence check.
--
-- The REVOKE lines deliberately still name only PUBLIC and the three universal
-- roles. They are belt-and-braces: the caller drops and recreates the schema
-- first, so every restored object starts at a NULL ACL with nothing to revoke.
-- Naming `data_api_reader` there would reintroduce exactly the missing-role
-- abort this design avoids, and would buy nothing.
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
-- THE ALLOWLIST. Adding a name here is the whole extension mechanism; read the
-- header first, because a name that is not present on every target has to earn
-- its place the way data_api_reader does below.
mirrored_grantees(rolname) AS (
  VALUES ('anon'), ('authenticated'), ('service_role'), ('data_api_reader')
),
sch AS (
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
         a.privilege_type, a.is_grantable
    FROM pg_namespace n, aclexplode(n.nspacl) a
   WHERE n.nspname = 'public'
     AND (a.grantee = 0 OR pg_get_userbyid(a.grantee)
          IN (SELECT rolname FROM mirrored_grantees))
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
          IN (SELECT rolname FROM mirrored_grantees))
),
-- COLUMN-LEVEL GRANTS, which live in pg_attribute.attacl and are invisible to
-- the `rel` CTE above: relacl carries only whole-table privileges. This file
-- did not read them until 00241 needed them, and the omission was silent in
-- both directions: a column grant on the source simply never arrived, and
-- nothing anywhere said so.
--
-- 00241 is the case that forced it. It grants `data_api_reader` SELECT on the
-- named columns of `data_api_consumers` and pointedly NOT on
-- `player_ref_salt`, which is the secret that turns a member's id into their
-- pseudonym. A mirror that drops column grants would restore that table with
-- the role holding no SELECT at all, so the failure here is a feed that
-- silently returns nothing rather than a leak. Worth being precise about: the
-- direction of this bug is safe, and it is still a bug.
col AS (
  SELECT format('%I.%I', n.nspname, c.relname) AS obj,
         quote_ident(att.attname) AS col,
         CASE WHEN a.grantee = 0 THEN 'PUBLIC'
              ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee,
         a.privilege_type, a.is_grantable
    FROM pg_attribute att
    JOIN pg_class c ON c.oid = att.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(att.attacl) a
   WHERE n.nspname = 'public'
     AND att.attnum > 0
     AND NOT att.attisdropped
     AND att.attacl IS NOT NULL
     AND (a.grantee = 0 OR pg_get_userbyid(a.grantee)
          IN (SELECT rolname FROM mirrored_grantees))
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
          IN (SELECT rolname FROM mirrored_grantees))
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
          IN (SELECT rolname FROM mirrored_grantees))
),
stmts AS (
  -- 0. a marker, so the applied script is identifiable in a psql log
  SELECT 0 AS ord, '' AS obj, 0 AS sub,
         '-- privileges mirrored from the snapshot source' AS stmt

  -- 0b. THE GRANTEES THE TARGET MIGHT NOT HAVE.
  --
  --     Roles are cluster globals, so they are not in a `--schema=public` dump
  --     and they do not die with the schema drop. That cuts both ways: a target
  --     that has applied 00241 already has data_api_reader and this block is a
  --     no-op, and a target that has not would otherwise abort here on the
  --     first GRANT naming a role it lacks, under ON_ERROR_STOP=1, at 4am.
  --
  --     Emitted ONLY when the source actually grants to the role, so a source
  --     without 00241 produces the same script this file produced before the
  --     role existed. The attributes match 00241's own CREATE ROLE: NOLOGIN
  --     because nothing connects as it directly, NOINHERIT so membership alone
  --     confers nothing. It is created with no privileges; every privilege it
  --     ends up with is granted by the statements below, mirrored from source.
  UNION ALL
  SELECT 5, g.rolname, 0,
         format($fmt$DO $mirror$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %L) THEN CREATE ROLE %I NOLOGIN NOINHERIT; END IF; END $mirror$;$fmt$,
                g.rolname, g.rolname)
    FROM mirrored_grantees g
   WHERE g.rolname NOT IN ('anon','authenticated','service_role')
     AND EXISTS (SELECT 1 FROM rel  WHERE rel.grantee = quote_ident(g.rolname)
                 UNION ALL
                 SELECT 1 FROM col  WHERE col.grantee = quote_ident(g.rolname)
                 UNION ALL
                 SELECT 1 FROM rou  WHERE rou.grantee = quote_ident(g.rolname)
                 UNION ALL
                 SELECT 1 FROM sch  WHERE sch.grantee = quote_ident(g.rolname)
                 UNION ALL
                 SELECT 1 FROM dfl  WHERE dfl.grantee = quote_ident(g.rolname))

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

  -- 2b. column-level grants. No REVOKE partner: the caller drops and recreates
  --     the schema, so every restored column starts at a NULL attacl and there
  --     is nothing to clear. One statement per (table, grantee, privilege), with
  --     the columns gathered into the parenthesised list PostgreSQL expects.
  --     Ordering the columns by name keeps the emitted script stable between
  --     runs, so a diff of two nights' output shows real drift and not the
  --     catalogue's scan order. Name rather than attnum because the name is
  --     what is projected, and because a column added by a later migration
  --     then sorts into place instead of landing at the end.
  --
  --     ord 25 MUST stay above ord 20, and this is load-bearing TODAY, not a
  --     precaution. A table-level REVOKE also clears that role's column-level
  --     privileges on the table. Verified: GRANT SELECT (a) ON t TO anon, then
  --     REVOKE ALL ON TABLE t FROM anon, leaves has_column_privilege false.
  --     00241 grants SELECT (id, name, created_at, created_by, notes) on
  --     data_api_consumers to service_role, pointedly withholding
  --     player_ref_salt, and service_role is named in the ord-20 REVOKE. So the
  --     two sections already collide on a real grant, and only the ordering
  --     keeps the column grant alive. Swap them and the console loses its read
  --     of the consumer list, silently, the way an empty list is always silent.
  UNION ALL
  SELECT 25, obj, 1,
         format('GRANT %s (%s) ON TABLE %s TO %s%s;',
                privilege_type, cols, obj, grantee,
                CASE WHEN is_grantable THEN ' WITH GRANT OPTION' ELSE '' END)
    FROM (SELECT obj, grantee, privilege_type, is_grantable,
                 string_agg(col, ', ' ORDER BY col) AS cols
            FROM col GROUP BY obj, grantee, privilege_type, is_grantable) cg

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
