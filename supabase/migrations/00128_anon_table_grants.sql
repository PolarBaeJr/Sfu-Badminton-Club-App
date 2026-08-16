-- ============================================================
-- 00128 — Take the table grants away from the browser key
-- ============================================================
-- 00126 closed EXECUTE on the SECURITY DEFINER functions. This is the same
-- mistake one layer up, from the same cause, found while writing it
-- (00126:556-565).
--
-- THE HOLE, MEASURED ON PRODUCTION (pg_class.relacl, 2026-08-15):
-- `anon` holds INSERT, SELECT, UPDATE, DELETE and MAINTAIN on 41 of the 53
-- tables in `public` — including players (UPDATE, DELETE), platform_settings,
-- audit_logs and passkey_credentials. The anon key ships inside the browser
-- bundle, so `anon` means anyone who has read the JavaScript.
--
-- All 41 have relrowsecurity = true, and pg_policy holds NOT ONE policy whose
-- polroles names anon. Six policies have polroles = {} (PUBLIC, so evaluated
-- for anon too) and every one of them tests is_admin(auth.uid()) or
-- auth.role() = 'service_role', both false for an anonymous caller. So RLS is
-- the only thing holding the line, and the grants are a redundant second copy
-- of the same permission decision pointing the wrong way. Nothing is
-- exploitable today. One DISABLE ROW LEVEL SECURITY, one `TO public` policy,
-- or one USING (true) written for `authenticated` and landing on PUBLIC, and
-- there is no grant left underneath to catch it.
--
-- CAUSE, identical to 00126's. Supabase runs, on every project:
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... ON TABLES
--     TO anon, authenticated, service_role;
-- (pg_default_acl on production: `anon=arwdm/postgres` for objtype 'r'). A
-- freshly created table therefore does not get relacl = NULL. It gets EXPLICIT
-- entries, and `REVOKE ... FROM PUBLIC` removes only the `=arwd/postgres`
-- entry, never those. Every statement below names PUBLIC as well as the role,
-- for the reason 00126:26-31 sets out — anon is a member of PUBLIC, so the trap
-- runs both ways and neither half of the revoke is sufficient alone. On these
-- 41 tables there is in fact no PUBLIC entry to remove, so naming it is belt
-- and braces rather than load-bearing; it costs nothing and it stops the next
-- reader concluding the one-sided form is fine.
--
-- ============================================================
-- THE `m` IS MAINTAIN, AND IT IS WHY THIS FILE SAYS `ALL PRIVILEGES`
-- ============================================================
-- Production is PostgreSQL 17.6 and the ACLs read `anon=arwdm/postgres`. That
-- trailing `m` is MAINTAIN (VACUUM / ANALYZE / CLUSTER / REINDEX / REFRESH
-- MATERIALIZED VIEW), new in 17. It matters twice:
--
--   * information_schema.role_table_grants is SQL-standard and has NO MAINTAIN
--     concept, so querying it reports these tables as DELETE,INSERT,SELECT,
--     UPDATE and quietly undercounts. The 41 above is read from pg_class.relacl.
--   * `REVOKE SELECT, INSERT, UPDATE, DELETE` would leave `anon=m/postgres`
--     behind, and an assertion that only tests those four privileges would pass
--     while the entry survived. Hence REVOKE ALL PRIVILEGES below, and an
--     assertion at the foot that re-derives the answer from aclexplode() rather
--     than from a named list of privileges.
--
-- MAINTAIN is also the one privilege in the set that RLS does not backstop:
-- VACUUM is not a row-returning operation and no policy constrains it. It is
-- not exploitable — PostgREST only ever emits SELECT/INSERT/UPDATE/DELETE/CALL,
-- and `anon` is NOLOGIN so there is no direct connection to run it from — but
-- it does mean "RLS is holding the line" is true of four privileges out of five.
--
-- ============================================================
-- WHAT LEGITIMATELY NEEDS anon — MEASURED, NOT REASONED
-- ============================================================
-- pg_stat_statements on production, over the 18 days since stats_reset
-- (2026-07-28 22:50 UTC → 2026-08-15), attributes to the `anon` role exactly
-- seven statement shapes and no others:
--
--   89822  set_config(...)            PostgREST's per-request role switch
--   61116  get_active_season()        SECURITY DEFINER
--   41617  COMMIT
--   28670  get_leaderboard()          SECURITY DEFINER   (two plans)
--      36  get_executives()           SECURITY DEFINER   (two plans)
--
-- Not one table read, not one write, in eighteen days of live traffic. That is
-- the whole case, and it agrees with the static one:
--
--   * The logged-out landing page (apps/player/src/app/page.tsx:19) and
--     /leaderboard (leaderboard/page.tsx:15) render the ladder from
--     `.rpc('get_leaderboard')`. get_leaderboard() is SECURITY DEFINER owned by
--     postgres, postgres owns the tables, and relforcerowsecurity is false
--     everywhere — so the body reads players and ratings as the owner and the
--     CALLER's table grants never enter into it. Same for get_active_season(),
--     which the root layout (layout.tsx:186) calls unconditionally on every
--     public route, and get_executives() behind /exec. All three keep their anon
--     EXECUTE; 00126:485-494 asserts exactly that.
--   * Every other public route reads through the service role, deliberately:
--     /legal/[doc] (legal/[doc]/page.tsx:26-30, whose comment says the
--     legal_documents SELECT policy is authenticated-only), /unsubscribe,
--     /api/calendar/[token], /tournaments/checkin, and both halves of the
--     passkey sign-in. The passkey login handlers read passkey_credentials and
--     players with createServiceRoleClient() and build an anon-key client only
--     to mint the session cookie — it touches the auth schema, never public.
--   * The remaining anon-key call sites are auth-schema only (getUser,
--     verifyOtp, exchangeCodeForSession) or sit behind `if (user)`, which makes
--     them `authenticated`: the player middleware's players_self read
--     (middleware.ts:111-115) and the admin middleware's three RPCs
--     (middleware.ts:110-116).
--
-- ONE TABLE IS KEPT, AND ONLY ONE.
--
--   ratings — SELECT stays. /leaderboard is a public route and its client
--   component opens a realtime postgres_changes channel on public.ratings
--   UNGUARDED (leaderboard-client.tsx:225-233; it is there to router.refresh()
--   a signed-in viewer). Realtime evaluates a subscriber's visibility by
--   switching to the subscriber's role and selecting the WAL row, so an anon
--   subscriber without SELECT turns a channel that quietly delivers nothing
--   into one that errors. Keeping the grant preserves today's behaviour exactly
--   and leaks nothing: ratings_select is TO authenticated (00005_rls.sql:79),
--   there is no anon policy, so an anon subscriber sees zero rows either way.
--   Its INSERT, UPDATE, DELETE and MAINTAIN go, in group B.
--
-- ============================================================
-- IDEMPOTENT
-- ============================================================
-- REVOKE is naturally so. The assertion block at the foot re-derives the final
-- state from pg_class.relacl, pg_attribute.attacl and pg_default_acl and raises
-- if any line did not take, so a table renamed out from under this file fails
-- loudly instead of silently revoking nothing.
--
-- Verified before writing, in a throwaway PostgreSQL 17 container whose
-- pre-state was built by applying Supabase's ALTER DEFAULT PRIVILEGES FIRST and
-- creating the 53 stub tables after it, then asserting the resulting ACL string
-- matched production character for character (`m` included) — without that
-- ordering the test proves nothing, because tables created before the default
-- privileges exist come out with relacl = NULL and every revoke trivially
-- "passes".
-- ============================================================

BEGIN;

-- ============================================================
-- BEFORE-SNAPSHOT, so "nothing else moved" is checked rather than asserted
-- ============================================================
-- Every privilege in `public` held by anyone who is NOT one of this file's two
-- targets (anon, and PUBLIC — which is grantee 0 and which every statement
-- below names deliberately). The block at the foot re-runs the identical query
-- and requires the two sets to be equal, which is what proves `authenticated`,
-- `service_role` and `postgres` came through untouched.
--
-- A snapshot rather than a list of expected privilege strings on purpose. This
-- branch carries 00122-00127 ahead of production, so any file that hardcoded
-- "authenticated holds exactly SELECT+MAINTAIN on matches" would abort the
-- whole migration the first time an earlier one legitimately changed it — a
-- guard against collateral damage failing on damage it was never watching for.
-- Comparing the database against itself has no such coupling.
CREATE TEMP TABLE _00128_acl_before ON COMMIT DROP AS
  SELECT c.oid::regclass::text AS rel, '' AS col, a.grantee, a.privilege_type
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE ns.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND a.grantee NOT IN (0, 'anon'::regrole)
  UNION ALL
  SELECT c.oid::regclass::text, att.attname, a.grantee, a.privilege_type
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
  JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  WHERE ns.nspname = 'public'
    AND a.grantee NOT IN (0, 'anon'::regrole);

-- ============================================================
-- A. THE 40 TABLES anon HAS NO BUSINESS TOUCHING AT ALL
-- ============================================================
-- Every table that carried an anon entry, except ratings. ALL PRIVILEGES, so
-- MAINTAIN goes with the other four. Ordered as pg_class reports them, so this
-- list can be diffed against a fresh measurement without re-sorting.
--
-- Grouped only for readability; there is no per-group reasoning, because the
-- evidence is uniform. No policy admits anon on any of them, and no anon
-- statement in eighteen days of pg_stat_statements touched any of them.

-- A SWEEP, NOT A LIST — and the list below is kept only as documentation.
--
-- The explicit statements that follow were measured against PRODUCTION and are
-- accurate there. Staging carries four relations production does not
-- (cron_config, email_suppressions, tournament_checkin_tokens and the
-- purgeable_inactive_players VIEW), so the hand-written list left anon reaching
-- them and this file's own closing assertion refused to commit. That assertion
-- did its job; the list was the thing at fault.
--
-- A list cannot be right on two databases that have drifted, and the evidence
-- behind this migration is not per-table anyway: eighteen days of
-- pg_stat_statements show the anon role touching NO table at all, only three
-- SECURITY DEFINER functions that read as their owner. "Nothing in public is
-- reachable by anon" is therefore the rule, and a sweep states the rule rather
-- than one database's snapshot of it.
--
-- VIEWS included (relkind 'v'): purgeable_inactive_players is a view, and a
-- view is queried through its own ACL, so omitting views would leave a readable
-- window onto tables that had just been closed.
--
-- ratings is excluded here and handled in section B, which keeps its SELECT.
DO $sweep$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS ident
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'v', 'm', 'p')
       AND c.relname <> 'ratings'
       AND c.relacl IS NOT NULL
       AND c.relacl::text LIKE '%anon=%'
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON %s FROM PUBLIC, anon', r.ident);
  END LOOP;
END
$sweep$;

-- Membership, identity and moderation.
REVOKE ALL PRIVILEGES ON TABLE public.players               FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.passkey_credentials   FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.audit_logs            FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.platform_settings     FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.calendar_feed_tokens  FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.push_subscriptions    FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.notifications         FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.varsity_notes         FROM PUBLIC, anon;

-- Legal and consent.
REVOKE ALL PRIVILEGES ON TABLE public.legal_documents          FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.waiver_acceptances       FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.event_waiver_acceptances FROM PUBLIC, anon;

-- Seasons, fees and settings.
REVOKE ALL PRIVILEGES ON TABLE public.seasons              FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.season_snapshots     FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.season_final_ratings FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.club_fees            FROM PUBLIC, anon;

-- Sessions and attendance.
REVOKE ALL PRIVILEGES ON TABLE public.sessions               FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.session_attendance     FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.session_rsvp           FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.session_checkin_tokens FROM PUBLIC, anon;

-- Play: challenges, matches, results and the derived stats.
REVOKE ALL PRIVILEGES ON TABLE public.challenges             FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.challenge_participants FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.matches                FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.match_games            FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.match_participants     FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.walkovers              FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.disputes               FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.head_to_head_stats     FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.partnership_stats      FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.reliability_metrics    FROM PUBLIC, anon;

-- Tournaments.
REVOKE ALL PRIVILEGES ON TABLE public.tournaments                    FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.tournament_events              FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.tournament_participants        FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.tournament_pairs               FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.tournament_matches             FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.tournament_fee_tiers           FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.tournament_audit_log           FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.legacy_tournament_participants FROM PUBLIC, anon;

-- Communications and feedback.
REVOKE ALL PRIVILEGES ON TABLE public.announcements       FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.announcement_reads  FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE public.event_feedback      FROM PUBLIC, anon;

-- tournament_audit_log above deserves one line of follow-up. 00126:72-77 kept
-- anon's EXECUTE on is_admin() precisely because this table's PUBLIC-role
-- policy "Admin read tournament_audit_log" calls it, and revoking would have
-- turned an anonymous read from an empty result into "permission denied for
-- function is_admin". With the table grant gone the read is refused one step
-- earlier and that reason lapses — but 00126 is not edited here. Its grant is
-- harmless (is_admin(NULL) is false) and rewriting an applied-order migration
-- to chase a dependency this file removed is how migration pairs get skewed.

-- ============================================================
-- B. ratings — WRITES GO, THE READ STAYS
-- ============================================================
-- See the header. The public /leaderboard's realtime channel subscribes to this
-- table while logged out; SELECT is what keeps that handshake behaving as it
-- does today, and it discloses nothing because no policy admits anon.
-- Named individually rather than as ALL-minus-SELECT, because there is no such
-- form and because MAINTAIN has to be spelled out or it survives.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.ratings FROM PUBLIC, anon;

-- ============================================================
-- C. THE COLUMN GRANT UNDERNEATH players
-- ============================================================
-- Table and column privileges are separate ACLs. 00032:36 revoked SELECT on
-- players from anon and then re-granted ONE column:
--
--     GRANT SELECT (id) ON public.players TO anon;
--
-- with the comment "Health checks ping the table unauthenticated (head + count
-- only)". That health check does not exist. Both container healthchecks in
-- docker-compose.yml:53 and :113 fetch the Next.js app over HTTP; nothing in
-- the repo, in scripts/, or in either compose file calls PostgREST without a
-- session; and no `players` statement appears under the anon role in eighteen
-- days of pg_stat_statements. It is vestigial, so it goes.
--
-- Kept as its own statement rather than trusted to group A. REVOKE on a table
-- privilege is documented to cascade to the matching column privileges, but
-- players is the one table where that cascade has nothing to hang off — its
-- table-level entry was `anon=wdm`, with no SELECT to revoke in the first
-- place. One explicit line removes the doubt.
REVOKE SELECT (id) ON TABLE public.players FROM PUBLIC, anon;

-- ============================================================
-- D. THE DURABLE FIX — STOP MINTING THE GRANT ON EVERY NEW TABLE
-- ============================================================
-- Groups A-C clean up 53 tables' worth of history. Without this, table 54
-- arrives with `anon=arwdm` again and the audit has to be re-run.
--
-- 00126's author deliberately deferred the equivalent for functions, on the
-- grounds that it changes the meaning of every subsequent CREATE, including
-- Supabase tooling's. That worry does not survive measurement here. Default
-- privileges are keyed by OWNER: pg_default_acl.defaclrole is `postgres` for
-- the public-schema entries and `supabase_admin` for the storage, graphql and
-- supabase_functions ones. Issued as postgres against schema public, the line
-- below reaches exactly the tables this repo's own migrations create, and
-- cannot touch anything Supabase's tooling makes in its own schemas.
--
-- The genuine counter-argument is this repo's own history. 00115 is a whole
-- migration about a MISSING grant, and its lesson is that the failure is
-- silent: PostgREST refuses the request, supabase-js resolves rather than
-- rejects, and the app's `?? []` renders the refusal as an empty list. A future
-- public table whose author forgets an explicit GRANT will look like a page
-- with no data, not like an error.
--
-- Taken anyway, because the measurement says the default is simply wrong for
-- this schema: zero of 53 tables need anon, the one public surface the app has
-- is served by SECURITY DEFINER RPCs, and a genuinely public table is rare
-- enough that writing one GRANT for it is the right amount of friction. An
-- unnecessary grant fails silently in the other direction, and 00126 plus this
-- file are the second and third migrations spent cleaning that up.
--
-- `authenticated` is NOT touched. Its default grant is load-bearing on almost
-- every table and re-deciding it is a different migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- ============================================================
-- ASSERTIONS — re-derive the whole answer from the catalogue
-- ============================================================
DO $do$
DECLARE
  offender text;
  n        int;
  privs    text;
BEGIN
  -- (1) NOTHING in public grants anon anything, except ratings. aclexplode
  --     rather than a list of privilege names, so MAINTAIN cannot hide.
  SELECT string_agg(x.relname || ' (' || x.privs || ')', ', ' ORDER BY x.relname)
    INTO offender
  FROM (
    SELECT c.relname, string_agg(a.privilege_type, '+' ORDER BY a.privilege_type) AS privs
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE ns.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.grantee = 'anon'::regrole
      AND c.relname <> 'ratings'
    GROUP BY c.relname
  ) x;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION '00128: anon still reaches %', offender;
  END IF;

  -- (2) ratings kept SELECT and lost everything else.
  SELECT string_agg(a.privilege_type, '+' ORDER BY a.privilege_type) INTO privs
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid = 'public.ratings'::regclass AND a.grantee = 'anon'::regrole;
  IF privs IS DISTINCT FROM 'SELECT' THEN
    RAISE EXCEPTION '00128: ratings should leave anon SELECT alone, has %',
      coalesce(privs, '(nothing)');
  END IF;

  -- (3) The column grant is gone, at both levels it could survive at.
  IF has_column_privilege('anon', 'public.players', 'id', 'SELECT') THEN
    RAISE EXCEPTION '00128: anon can still SELECT players.id';
  END IF;
  SELECT count(*) INTO n
  FROM pg_attribute att
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  WHERE att.attrelid = 'public.players'::regclass
    AND a.grantee = 'anon'::regrole;
  IF n <> 0 THEN
    RAISE EXCEPTION '00128: % column ACLs on players still name anon', n;
  END IF;

  -- (4) NOBODY ELSE LOST ANYTHING. Diffed against the snapshot taken before the
  --     first REVOKE, both directions, tables and columns together — so a stray
  --     role name in any statement above, or a table-level revoke cascading
  --     into a column grant it should not have reached, shows up here by name.
  --     This is what protects `authenticated` (including the players column
  --     grants 00115 exists to restate) and `service_role` (which every
  --     server-side read in both apps runs as).
  SELECT string_agg(d.rel || coalesce(nullif('.' || d.col, '.'), '') ||
                    ' ' || d.privilege_type || ' for ' ||
                    coalesce(pg_get_userbyid(d.grantee), 'PUBLIC'),
                    ', ' ORDER BY d.rel, d.col, d.privilege_type)
    INTO offender
  FROM (
    SELECT * FROM _00128_acl_before
    EXCEPT
    SELECT c.oid::regclass::text, '', a.grantee, a.privilege_type
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE ns.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND a.grantee NOT IN (0, 'anon'::regrole)
    EXCEPT
    SELECT c.oid::regclass::text, att.attname, a.grantee, a.privilege_type
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0
    CROSS JOIN LATERAL aclexplode(att.attacl) a
    WHERE ns.nspname = 'public'
      AND a.grantee NOT IN (0, 'anon'::regrole)
  ) d;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION '00128: collateral damage — these privileges disappeared: %', offender;
  END IF;

  -- (5) And a named spot-check of the three reads the apps would most visibly
  --     lose, in case the snapshot itself was somehow empty.
  IF NOT has_table_privilege('service_role', 'public.players', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.legal_documents', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.passkey_credentials', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.players', 'handle', 'SELECT') THEN
    RAISE EXCEPTION '00128: service_role or authenticated lost a read the apps depend on';
  END IF;
  SELECT count(*) INTO n FROM _00128_acl_before;
  IF n < 100 THEN
    RAISE EXCEPTION '00128: the before-snapshot holds only % rows, too few to have checked anything', n;
  END IF;

  -- (6) The default privilege that mints the grant is gone for anon and intact
  --     for the other two.
  --     SCOPED TO THE OWNER WE CAN ACTUALLY ALTER. Default privileges are keyed
  --     by (granting role, schema), and ALTER DEFAULT PRIVILEGES may only be
  --     issued by the owning role or a member of it. Staging carries a SECOND
  --     entry for schema public owned by supabase_admin, which production does
  --     not have, and `postgres` is not a member of supabase_admin
  --     (pg_has_role says false) — so that entry is unreachable from any
  --     connection this migration can run on.
  --
  --     It is also not the entry that matters. A default ACL applies to objects
  --     created BY its owning role, and every table in this repo is created by
  --     migrations running as postgres. The supabase_admin entry would only
  --     mint a grant on a table supabase_admin itself created, which nothing
  --     here does. Asserting over every owner therefore fails on staging for a
  --     condition that is neither fixable nor relevant, which is a worse
  --     outcome than not asserting it: an assertion nobody can satisfy gets
  --     deleted, and then the real one goes with it.
  SELECT count(*) INTO n
  FROM pg_default_acl d
  JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE ns.nspname = 'public' AND d.defaclobjtype = 'r'
    AND d.defaclrole = 'postgres'::regrole
    AND a.grantee = 'anon'::regrole;
  IF n <> 0 THEN
    RAISE EXCEPTION '00128: ALTER DEFAULT PRIVILEGES still grants anon on tables created by postgres';
  END IF;

  SELECT count(DISTINCT a.grantee) INTO n
  FROM pg_default_acl d
  JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  WHERE ns.nspname = 'public' AND d.defaclobjtype = 'r'
    AND a.grantee IN ('authenticated'::regrole, 'service_role'::regrole);
  IF n <> 2 THEN
    RAISE EXCEPTION '00128: authenticated/service_role default table grants were collateral';
  END IF;

  RAISE NOTICE '00128 OK: anon reaches one table (ratings, SELECT) and nothing else in public';
END
$do$;

COMMIT;

-- ============================================================
-- FOUND, NOT FIXED
-- ============================================================
-- 1. anon HOLDS CREATE ON SCHEMA public. pg_namespace.nspacl reads
--    `anon=UC/postgres` — U is USAGE, which PostgREST needs, but C is CREATE.
--    An anonymous caller cannot open a connection (anon is NOLOGIN) and
--    PostgREST issues no DDL, so there is no route to exercising it today; it
--    is nonetheless a privilege nobody chose. Left alone because it is
--    schema-level rather than table-level, and because REVOKE CREATE ON SCHEMA
--    public is the kind of change that surfaces in some Supabase tool three
--    months later. Its own migration, with its own container test.
--
-- 2. anon HOLDS TABLE GRANTS IN THREE OTHER SCHEMAS: storage (9 tables),
--    realtime (3) and supabase_functions (2). Out of scope here, and storage's
--    at least are plausibly load-bearing — the avatars bucket is public and
--    AvatarUpload.tsx reads it through the browser client. Their default
--    privileges have defaclrole = supabase_admin, not postgres, so group D does
--    not reach them and auditing them means auditing Supabase's own tooling.
--
-- 3. platform_settings REMAINS READABLE BY anon THROUGH A FUNCTION. 00126 kept
--    `authenticated` on platform_setting_int because challenges.expires_at
--    DEFAULTs through it, and revoked all three accessors from anon — so this
--    is closed for anon and noted only because group A's revoke of the TABLE is
--    not by itself what closes it. 00126:515-521's warning stands: a secret
--    stored in platform_settings is readable by any signed-in member.
--
-- 4. THE VIEWS WERE ALREADY CLEAN. players_self grants only authenticated and
--    purgeable_inactive_players only service_role, so neither appears above.
--    Assertion (1) covers relkind 'v' and 'm' anyway, so a future view that
--    picks up an anon grant will fail this migration on re-run rather than
--    slipping past a table-only sweep.
