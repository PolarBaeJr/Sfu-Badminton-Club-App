-- ============================================================
-- 00134 — players_self is a READ, and only a read
-- ============================================================
-- 00032 created this view to solve one problem: it had just revoked blanket
-- SELECT on `players` and replaced it with a 16-column grant, and the Settings
-- page needs the caller's OWN phone, email and notification preferences, which
-- that grant deliberately withholds. A definer-semantics view filtered to
-- auth.uid() returns exactly one row — the caller's — with every column on it.
-- That design is correct and is not changed here.
--
-- 00032 also wrote, on the two lines after the CREATE:
--
--     REVOKE ALL ON public.players_self FROM PUBLIC, anon;
--     GRANT SELECT ON public.players_self TO authenticated;
--
-- and believed that left `authenticated` holding SELECT. It never did. Measured
-- on production 2026-08-16:
--
--     players_self  relkind=v
--                   reloptions  {security_barrier=true,security_invoker=false}
--                   relacl      {postgres=arwdDxtm/postgres,
--                                authenticated=arwdm/postgres,      <-- a w d m
--                                service_role=arwdDxtm/postgres}
--     players       relrowsecurity=t  relforcerowsecurity=f  owner=postgres
--
-- `arwdm` is INSERT, SELECT, UPDATE, DELETE, MAINTAIN. It is not what the GRANT
-- above asked for; it is what Supabase's ALTER DEFAULT PRIVILEGES minted when
-- the view was created, and the REVOKE on the line before could not take it
-- back. This is 00126's and 00131's trap, arriving a third time:
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... TO anon, authenticated, service_role;
--
-- gives a new object EXPLICIT `authenticated=.../postgres` entries, not a
-- PUBLIC default. `REVOKE ... FROM PUBLIC` removes only the `=.../postgres`
-- entry; `REVOKE ... FROM anon` was a real revoke but said nothing about
-- `authenticated`. Confirmed still live in pg_default_acl on production:
--
--     postgres | r | {anon=arwdm/postgres,authenticated=arwdm/postgres,service_role=arwdDxtm/postgres}
--
-- Every REVOKE below therefore names PUBLIC **and** each role by name.
--
-- ------------------------------------------------------------
-- WHY THREE STRAY LETTERS ARE A PRIVILEGE ESCALATION
-- ------------------------------------------------------------
-- `security_invoker=false` (the default, and stated explicitly by 00032) means
-- permission checks and RLS on the base table are evaluated as the view's
-- OWNER. The owner is `postgres`, which also owns `players`, and
-- `relforcerowsecurity` is false — so RLS on `players` is BYPASSED ENTIRELY for
-- anything routed through this view. The view's own `WHERE user_id = auth.uid()`
-- is then the only thing standing between a member and the base table, and it
-- constrains which rows are VISIBLE, not what may be written into them: there
-- was no WITH CHECK OPTION (`information_schema.views.check_option = NONE`).
--
-- `pg_relation_is_updatable` returns 28 for both the view and `players` — the
-- same bitmask — so the view is fully auto-updatable. Three consequences, all
-- live on production until this file runs, and all reproduced in the container
-- described below:
--
--   DELETE — the loud one. `players` has no DELETE policy for a non-admin,
--     which is exactly what makes its table-level `d` grant inert on the base
--     table. Through the view there is no policy to fail. An ordinary member
--     with no tournament history could hard-delete their own row, and 29 of the
--     64 foreign keys referencing `players` are ON DELETE CASCADE, so it takes
--     with it: ratings, waiver_acceptances and event_waiver_acceptances (the
--     club's signed consent evidence), session_attendance, match_participants,
--     notifications, push_subscriptions and passkey_credentials. The app's own
--     account deletion (apps/player/src/lib/actions/profile.ts:319-338) is a
--     SOFT delete — `deletion_requested_at` plus `active_flag=false`, with a
--     30-day window in which signing back in restores it. This path destroys
--     instead, and leaves no record that it happened.
--
--   INSERT — the quiet one. `authenticated` has NO INSERT on `players`
--     (has_table_privilege = false; the table grant is `wdm`). So the
--     `players_self_insert` policy that 00005 wrote and 00056 hardened —
--     `user_id = auth.uid() AND status='pending_approval' AND role='player'
--     AND NOT is_exec AND NOT is_trainer AND NOT fee_exempt AND NOT is_banned`
--     — has never once been evaluated. It is dead code. The view is the only
--     INSERT path a member has, and it does not run policies.
--     `guard_player_privileged_insert_trg` does still fire (it is a trigger,
--     not a policy), and it re-pins the privilege columns — role, status,
--     is_exec, is_trainer, fee_exempt, is_banned, exec_title, permission_role,
--     permission_grants, permission_revokes, permission_baseline_id — so this
--     is not a route to admin. It does NOT pin `user_id` and does NOT pin
--     `email`. A member could plant an extra `players` row carrying somebody
--     else's user_id and somebody else's email address.
--
--   UPDATE — the narrow one. The view's WHERE confines it to the member's own
--     row, and the privilege-column trigger fires, but with no WITH CHECK
--     OPTION nothing pins `user_id` on the way OUT: the member could rewrite
--     their row's user_id to another auth user's, handing that account their
--     player row. On the BASE table the same write is refused, because
--     `players_update_own` carries `WITH CHECK (user_id = auth.uid())` — the
--     protection exists and the view routes around it.
--
-- ------------------------------------------------------------
-- WHAT ACTUALLY USES THE VIEW — established before revoking anything
-- ------------------------------------------------------------
-- READERS. Three, all `.select()`, none of them a write:
--   apps/player/src/middleware.ts:111-122     onboarding_completed
--   apps/player/src/components/bottom-nav.tsx:85-90   id, status, eligibility_flag
--   apps/player/src/app/settings/page.tsx:144         select('*')
--
-- WRITERS. None. `.from('players_self')` appears at exactly those three sites
-- in the whole repo and nowhere with `.insert`, `.update`, `.upsert` or
-- `.delete`. In the database, `pg_proc.prosrc ILIKE '%players_self%'` returns
-- one row — `create_player_with_rating` — and the match is a COMMENT naming
-- the `players_self_insert` POLICY; the function's body writes
-- `INSERT INTO players`, is SECURITY DEFINER, and is owned by postgres, which
-- holds INSERT on the base table in its own right. 00132's
-- `ensure_player_for_user` is the same shape and is EXECUTE-able only by
-- service_role (00132:639-641). `pg_depend` reports no rule, view or matview
-- built on players_self.
--
-- So no member INSERT grant is needed, no member DELETE grant is needed, and no
-- member UPDATE grant is needed either. The view is a read. It is granted as a
-- read.
--
-- ------------------------------------------------------------
-- THE OBVIOUS FIX IS THE WRONG ONE: security_invoker STAYS false
-- ------------------------------------------------------------
-- The textbook repair for a definer view that bypasses RLS is
-- `security_invoker = true`. On this view it would take the whole player app
-- down, and it was measured doing so before this file was written.
--
-- Under `security_invoker = true` the CALLER's privileges apply to the base
-- table — RLS *and* column grants. RLS is fine: `players_select` admits
-- `user_id = auth.uid()`, so the member's own row is visible. The column grants
-- are not. `authenticated` holds SELECT on 16 columns of `players`:
--
--   active_flag, avatar_url, bio, display_name, first_name, full_name, handle,
--   hide_from_leaderboard, id, is_exec, last_name, member_code, role,
--   show_activity_status, status, user_id
--
-- and the view's frozen column list is 32 columns wide. Every one of the three
-- readers names at least one column that is NOT in the 16:
--
--   middleware   onboarding_completed              not granted
--   bottom-nav   eligibility_flag                  not granted
--   settings     select('*') -> email, phone,
--                notification_preferences, ...     not granted
--
-- All three fail with 42501, `permission denied for table players`. Measured,
-- not reasoned about — the container ran each of the three shapes separately.
--
-- IT IS WORSE THAN "the reads that name a withheld column break". A fourth case
-- was run: `SELECT id FROM players_self`, naming ONLY a column `authenticated`
-- fully holds. It is refused too. PostgreSQL fixes the base relation's
-- selectedCols when it parses the VIEW DEFINITION, and this view's definition is
-- 32 columns wide, so under invoker semantics the caller needs SELECT on all 32
-- no matter which one they ask for. There is no subset of this view that would
-- keep working. That is what makes "just flip security_invoker" unsalvageable
-- here rather than merely awkward.
--
-- HOW THAT WOULD HAVE PRESENTED, which is why it was worth measuring rather
-- than reasoning about — none of it looks like a security change going wrong:
--   * the middleware FAILS OPEN by design (middleware.ts:119-121). A refused
--     read is logged and fallen through, so the onboarding gate would silently
--     stop gating. Nobody is logged out; nobody sees an error.
--   * Settings hangs FOREVER. `const { data } = await ...` discards the error,
--     `data` is null, the `if (data)` block never runs, `setLoaded(true)` never
--     fires, and the page sits on its skeleton.
--   * the bottom-nav unread badge just stops appearing.
-- A sign-in smoke test passes through all three. This is the same failure mode
-- 00115 documents at length: a refused read arrives as absent data, never as an
-- error.
--
-- AND THE FIX FOR THAT FIX IS WORSE. Widening the column grants so invoker=true
-- works would hand every member every other member's email and phone, because a
-- column grant is not row-scoped and `players_select` admits any member to any
-- approved member's row. That undoes 00032 in order to repair 00032. Rejected.
--
-- Definer semantics were never the hole. WRITE privileges under definer
-- semantics were. A SELECT-only, security_barrier, `WHERE user_id = auth.uid()`
-- view is precisely what 00032 designed, and this file is the first time the
-- catalogue actually says so.
--
-- ------------------------------------------------------------
-- ALTER VIEW, NEVER CREATE OR REPLACE
-- ------------------------------------------------------------
-- Two reasons, and the first one is a live trap.
--
--   1. THE TWO DATABASES DISAGREE ABOUT THIS VIEW'S COLUMN LIST. Production's
--      players_self is 32 columns — 00032's `SELECT *` frozen at the moment it
--      ran. Staging's is 44, and includes permission_role, permission_grants,
--      permission_revokes, competition_category, inactive_since and
--      inactivity_notice_sent_at. Something replaced it out of band between
--      00111 and 00121. `CREATE OR REPLACE VIEW ... AS SELECT * FROM players`
--      is legal as long as it only APPENDS columns, so it would SUCCEED on
--      production and silently widen the view to 45 columns — undoing 00060's
--      deliberate exclusion of inactivity_notice_sent_at, 00111:113's of
--      competition_category and 00130:279-284's of exec_bio in one statement,
--      while looking like a no-op diff.
--
--   2. A DROP + CREATE is worse: pg_default_acl re-mints `authenticated=arwdm`
--      on the new object, which is the exact grant this file exists to remove.
--
-- `ALTER VIEW ... SET (...)` accepts check_option, security_barrier and
-- security_invoker, touches no column list, preserves the ACL, and behaves
-- identically on both drifted databases. All three options are restated
-- explicitly so the intent is on the record rather than inherited.
--
-- ------------------------------------------------------------
-- IDEMPOTENT
-- ------------------------------------------------------------
-- REVOKE, GRANT and ALTER VIEW ... SET are all naturally idempotent. The
-- assertion block at the foot re-derives every claim from the catalogue with
-- aclexplode() rather than trusting that a statement took — 00128's lesson:
-- a named-privilege check cannot see MAINTAIN, and MAINTAIN is one of the five
-- letters being removed here.
--
-- ------------------------------------------------------------
-- VERIFIED IN A THROWAWAY PostgreSQL 17.6 CONTAINER
-- ------------------------------------------------------------
-- The pre-state was built to match production and ASSERTED to match it before
-- any test ran, because a harness that is looser than production makes every
-- subsequent result meaningless. Asserted pre-state:
--   * bootstrap superuser `supabase_admin`; `postgres` NOSUPERUSER and owner of
--     both relations (pg_roles on production: supabase_admin rolsuper=t,
--     postgres rolsuper=f). A superuser can revoke privileges it never granted,
--     so an all-superuser harness proves nothing about the REVOKEs.
--   * Supabase's ALTER DEFAULT PRIVILEGES applied BEFORE the view was created,
--     so `authenticated=arwdm` was MINTED by the same mechanism that minted it
--     on production, not typed in by hand.
--   * players: relrowsecurity=t, relforcerowsecurity=f, all four policies,
--     both guard triggers, table grant `wdm` for authenticated (no `a`, no `r`).
--   * THE LOAD-BEARING ONE: the `authenticated` SELECT column grant on
--     `players` is exactly the 16 columns above, and has_column_privilege is
--     false for email, phone, notification_preferences, onboarding_completed
--     and eligibility_flag. Seed blanket SELECT instead and the invoker=true
--     experiment passes and Settings ships broken.
--   * players_self: 32 columns, check_option=NONE,
--     pg_relation_is_updatable = 28, relacl authenticated=arwdm.
--   * ON DELETE CASCADE children (ratings, waiver_acceptances,
--     passkey_credentials) populated, so the cascade is observed rather than
--     assumed.
--
-- 36 checks, the behavioural ones run as `authenticated` with
-- request.jwt.claim.sub set to the member, each in its own rolled-back
-- transaction. All 36 pass, and THE WHOLE SUITE WAS RUN TWICE: once against
-- production's 32-column view and once against staging's 44-column one, so the
-- claim that this file is safe on both databases is measured rather than
-- argued. Verbatim, from the production-shaped run:
--
-- NEGATIVE CONTROL — the holes must be OPEN beforehand, or the after-state
-- proves nothing:
--   N1  SELECT onboarding_completed FROM players_self      1 row
--   N2  SELECT id,status,eligibility_flag FROM players_self 1 row
--   N3  SELECT * FROM players_self                          own email returned
--   N4  DELETE FROM players_self                            SUCCEEDED — row,
--         rating, signed waiver and passkey all gone with it
--   N5  INSERT INTO players_self (user_id,email,...)        SUCCEEDED — row
--         planted carrying another auth user's id and email
--   N6  UPDATE players_self SET user_id = <other uuid>      SUCCEEDED
--
-- CONTROL — the same three writes against the BASE table, already refused,
-- which is what shows the view is the route around them and not a second
-- symptom of one broken table:
--   C1  DELETE FROM players ...          0 rows (no DELETE policy)
--   C2  UPDATE players SET user_id=...   new row violates row-level security policy
--   C3  INSERT INTO players ...          permission denied for table players
--
-- EXPERIMENT — security_invoker = true, applied and rolled back:
--   I1  middleware read     permission denied for table players
--   I2  bottom-nav read     permission denied for table players
--   I3  settings SELECT *   permission denied for table players
--   I4  SELECT id only      permission denied for table players
--
-- AFTER this file (applied three times over, to show idempotence; its own
-- assertion block passed on each):
--   P1  SELECT onboarding_completed FROM players_self   1 row   (middleware)
--   P2  SELECT id,status,eligibility_flag ...           1 row   (bottom-nav)
--   P3  SELECT * FROM players_self                      own email returned
--   P4  SELECT count(*) FROM players_self               1 — still own row only
--   P5  DELETE through the view    permission denied for view players_self
--   P6  INSERT through the view    permission denied for view players_self
--   P7  UPDATE through the view    permission denied for view players_self
--   P8  UPDATE players SET bio (own row, base table)    1 row — still works
--   P9  UPDATE players SET user_id (base)  new row violates row-level security policy
--   P10 UPDATE players SET role='admin'    Not authorized to modify privileged
--                                          player fields
--   P11 re-GRANT UPDATE on the view, then move user_id
--                                  new row violates check option for view
--                                  "players_self"    <- section C earning its keep
--   P12 re-GRANT INSERT on the view, then plant a row
--                                  new row violates check option for view
--                                  "players_self"
--
-- APPLICATION SHAPES. Applied three times over to show idempotence, and applied
-- both statement-at-a-time (psql -f, autocommit) and wrapped in one explicit
-- transaction, because those two differ for the temp table section D diffs
-- against and the file has no say in which shape the runner uses:
--   T1  BEGIN; <file> COMMIT;              applies, assertion block passes
--
-- MUTATION TESTS — an assertion that cannot fail is decoration. Each of these
-- injects one wrong statement into the file and requires the block at the foot
-- to catch it by name. 00126/00128/00131 each report their assertions catching
-- a real error; these are the proof that this file's would:
--   T2  + REVOKE SELECT (handle) ON players FROM authenticated
--         -> 00134: collateral damage — these privileges disappeared:
--            players.handle SELECT for authenticated
--   T3  + GRANT SELECT (email) ON players TO authenticated
--         -> 00134: this file GRANTED something it should not have:
--            players.email SELECT for authenticated
--   T4  + GRANT DELETE ON players_self TO authenticated
--         -> 00134: authenticated should hold exactly SELECT on players_self,
--            holds DELETE+SELECT
--   T5  + GRANT SELECT ON players_self TO anon
--         -> 00134: 1 privilege(s) on players_self still belong to anon or PUBLIC
--   T6  + REVOKE UPDATE ON players_self FROM service_role
--         -> 00134: service_role lost privileges on players_self
--   T7  after five rolled-back mutants, authenticated is still exactly SELECT
--
-- FINAL CATALOGUE STATE in the container, which is the state this file intends
-- production to be in:
--   players       reloptions (none)   authenticated: DELETE+MAINTAIN+UPDATE
--   players_self  {security_barrier=true,security_invoker=false,check_option=cascaded}
--                 authenticated: SELECT      anon/PUBLIC: 0 privileges
-- ============================================================

-- ------------------------------------------------------------
-- A. FAIL LOUDLY IF THE SUBJECT IS NOT WHAT THIS FILE DESCRIBES
-- ------------------------------------------------------------
-- A REVOKE on a missing relation errors anyway; this exists to say WHY, and to
-- catch the more dangerous case where players_self has been turned into
-- something other than a view over players since this was written.
DO $do$
BEGIN
  IF to_regclass('public.players_self') IS NULL THEN
    RAISE EXCEPTION
      '00134: public.players_self does not exist. 00032 creates it; this file only re-grants it.';
  END IF;

  IF (SELECT relkind FROM pg_class WHERE oid = 'public.players_self'::regclass) <> 'v' THEN
    RAISE EXCEPTION '00134: public.players_self is not a view (relkind=%)',
      (SELECT relkind FROM pg_class WHERE oid = 'public.players_self'::regclass);
  END IF;

  -- The WHERE clause is the entire row-level protection once definer semantics
  -- are kept. If a future recreate ever drops it, this file's grant of SELECT
  -- to `authenticated` would publish every member's email to every member, so
  -- refuse to run rather than bless it.
  IF pg_get_viewdef('public.players_self'::regclass, true) NOT LIKE '%user_id = auth.uid()%' THEN
    RAISE EXCEPTION
      '00134: players_self no longer filters on user_id = auth.uid(); refusing to grant SELECT on it. Definition: %',
      pg_get_viewdef('public.players_self'::regclass, true);
  END IF;
END
$do$;

-- Every privilege currently held on `players` and on `players_self`, by
-- everyone, at both the table and the column level. The block at the foot
-- re-runs the identical query and requires the two sets to differ ONLY in the
-- four privileges section B removes.
--
-- A SNAPSHOT RATHER THAN AN EXPECTED COUNT, and this is 00128:138-143's lesson
-- rather than a preference. The obvious way to write "this file did not damage
-- 00032's column grant" is `IF n <> 16 THEN RAISE`. It is the wrong instrument:
-- 16 is what production and staging measure TODAY, but 00134 never runs against
-- today — it runs after 00122-00133, and 00133 belongs to a migration being
-- written in parallel with this one and cannot be read from here. One
-- legitimate `GRANT SELECT (something) ON players TO authenticated` in any of
-- them and this file aborts a deploy over a change it did not make and is not
-- watching for. And per 00128:455-457, an assertion nobody can satisfy gets
-- deleted, and then the real one goes with it.
--
-- Comparing the database against itself has no such coupling: it is false only
-- if THIS FILE moved something, which is the actual claim.
-- NOT `ON COMMIT DROP`, which is the one thing here that differs from 00128's
-- otherwise identical block. ON COMMIT DROP is correct only if the whole file
-- runs inside one transaction; applied statement-at-a-time (psql -f with no
-- BEGIN, which is how this was verified) the CREATE commits immediately and
-- takes the table with it, and the assertion at the foot then fails on a
-- missing relation rather than on anything real. A leading DROP IF EXISTS plus
-- an explicit DROP at the end is correct under both, and keeps re-running the
-- file in one psql session idempotent. Both shapes were exercised.
DROP TABLE IF EXISTS _00134_acl_before;
-- `rel` is stored as an oid, not as regclass::text: the text rendering of a
-- regclass depends on search_path, and this file has no control over the
-- search_path the migration runner connects with. An oid compares the same way
-- under every one of them, and is rendered back to a name only when a failure
-- is being reported.
CREATE TEMP TABLE _00134_acl_before AS
  SELECT c.oid AS rel, ''::name AS col, a.grantee, a.privilege_type
  FROM pg_class c
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid IN ('public.players'::regclass, 'public.players_self'::regclass)
  UNION ALL
  SELECT c.oid, att.attname, a.grantee, a.privilege_type
  FROM pg_class c
  JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0
  CROSS JOIN LATERAL aclexplode(att.attacl) a
  WHERE c.oid IN ('public.players'::regclass, 'public.players_self'::regclass);

-- ------------------------------------------------------------
-- B. THE VIEW IS A READ
-- ------------------------------------------------------------
-- REVOKE ALL, not `REVOKE INSERT, UPDATE, DELETE`: the ACL carries MAINTAIN
-- too, and 00128 is the file that learned a named-privilege sweep leaves it
-- behind. On a view MAINTAIN grants nothing interesting today, but "nothing
-- interesting today" is how `arwdm` got here in the first place.
--
-- PUBLIC and each role NAMED SEPARATELY, per 00126/00131: revoking from PUBLIC
-- does not touch an explicit `authenticated=.../postgres` entry, and revoking
-- from a role alone is a no-op while a PUBLIC entry survives, because every
-- role is a member of PUBLIC. Production carries no PUBLIC entry on this view
-- and `anon` was already correctly revoked by 00032 — both lines are restated
-- so the file does not depend on either of those staying true.
REVOKE ALL PRIVILEGES ON TABLE public.players_self FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.players_self FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.players_self FROM authenticated;

-- What 00032 asked for, now actually the whole of it.
GRANT SELECT ON TABLE public.players_self TO authenticated;

-- `service_role` IS DELIBERATELY UNTOUCHED. It keeps arwdDxtm. It is not a
-- privilege boundary: it holds SELECT/INSERT/UPDATE/DELETE on `players` itself
-- and has rolbypassrls, so it can already do everything the view offers and
-- more, directly. Removing its grants would change nothing about what a member
-- can reach and would risk a server-side path this file has not found. Every
-- server-side read in both apps runs as service_role; that is the role 00128's
-- collateral-damage assertion exists to protect.

-- ------------------------------------------------------------
-- C. WITH CHECK OPTION — belt and braces, on purpose
-- ------------------------------------------------------------
-- Section B already makes INSERT and UPDATE through the view impossible for
-- `authenticated`, so this changes nothing observable today. It is set anyway
-- because the failure this file is repairing is precisely a grant reappearing
-- by default: if `ALTER DEFAULT PRIVILEGES` ever mints `a`/`w` onto this view
-- again — a DROP + CREATE in some future migration would do exactly that — the
-- check option is what stops the re-minted UPDATE from moving a row to another
-- user_id, and stops the re-minted INSERT from planting one. A defence that
-- only works while the other defence works is not a second defence.
--
-- `cascaded` rather than `local`: the base is a table with no view beneath it,
-- so the two are equivalent today, and `cascaded` is the one that stays correct
-- if this view is ever stacked on another.
--
-- ONE CONSEQUENCE WORTH KNOWING ABOUT. `service_role` keeps INSERT/UPDATE on
-- the view (section B), and `auth.uid()` is NULL under the service-role key —
-- so a service-role write THROUGH THE VIEW would now fail the check option with
-- SQLSTATE 44000. Nothing does that: there are no `.from('players_self')`
-- writers in either app and no database routine writes through it. Every
-- server-side write already targets `players` directly, which is unaffected.
-- Stated here so the next author is told rather than left to discover it.
--
-- security_barrier and security_invoker are restated at their existing values
-- rather than left implicit, so that reading this line tells you the whole
-- setting instead of two-thirds of it. See the header for why invoker stays
-- false — it is not an oversight, it was measured.
ALTER VIEW public.players_self SET (
  security_barrier = true,
  security_invoker = false,
  check_option     = cascaded
);

-- ------------------------------------------------------------
-- D. ASSERTIONS — re-derive the whole answer from the catalogue
-- ------------------------------------------------------------
DO $do$
DECLARE
  privs    text;
  n        int;
  opts     text[];
  offender text;
BEGIN
  -- (1) `authenticated` holds EXACTLY SELECT on the view. aclexplode rather
  --     than has_table_privilege over a list of names, so MAINTAIN — the letter
  --     a named sweep misses — cannot survive unseen.
  SELECT string_agg(a.privilege_type, '+' ORDER BY a.privilege_type) INTO privs
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid = 'public.players_self'::regclass AND a.grantee = 'authenticated'::regrole;
  IF privs IS DISTINCT FROM 'SELECT' THEN
    RAISE EXCEPTION '00134: authenticated should hold exactly SELECT on players_self, holds %',
      coalesce(privs, '(nothing)');
  END IF;

  -- (2) Belt and braces on (1), through the other API, including the three
  --     that were the hole.
  IF has_table_privilege('authenticated', 'public.players_self', 'INSERT')
     OR has_table_privilege('authenticated', 'public.players_self', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.players_self', 'DELETE') THEN
    RAISE EXCEPTION '00134: authenticated can still write through players_self';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.players_self', 'SELECT') THEN
    RAISE EXCEPTION '00134: authenticated LOST SELECT on players_self — this breaks sign-in for everybody';
  END IF;

  -- (3) anon and PUBLIC hold nothing at all. grantee 0 is PUBLIC.
  SELECT count(*) INTO n
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.oid = 'public.players_self'::regclass
    AND a.grantee IN (0, 'anon'::regrole);
  IF n <> 0 THEN
    RAISE EXCEPTION '00134: % privilege(s) on players_self still belong to anon or PUBLIC', n;
  END IF;

  -- (4) service_role was NOT collateral. Named explicitly because every
  --     server-side read in both apps runs as this role, and a stray role name
  --     in section B would show up here rather than in production.
  IF NOT (has_table_privilege('service_role', 'public.players_self', 'SELECT')
          AND has_table_privilege('service_role', 'public.players_self', 'INSERT')
          AND has_table_privilege('service_role', 'public.players_self', 'UPDATE')
          AND has_table_privilege('service_role', 'public.players_self', 'DELETE')) THEN
    RAISE EXCEPTION '00134: service_role lost privileges on players_self';
  END IF;

  -- (5) The three view options are all three of what section C set. Checked as
  --     membership rather than array equality because reloptions order is not
  --     contractual.
  SELECT reloptions INTO opts FROM pg_class WHERE oid = 'public.players_self'::regclass;
  IF NOT ('security_barrier=true' = ANY(opts))
     OR NOT ('security_invoker=false' = ANY(opts))
     OR NOT ('check_option=cascaded' = ANY(opts)) THEN
    RAISE EXCEPTION '00134: players_self reloptions are %, expected all of security_barrier=true, security_invoker=false, check_option=cascaded',
      coalesce(opts::text, '(none)');
  END IF;

  -- (6) THE READS THE APPS DEPEND ON STILL RESOLVE. security_invoker is false,
  --     so these are checked against the view owner and the 16-column grant
  --     does not apply — but asserting it costs nothing and is the one thing
  --     whose failure would be invisible in production (see the header: the
  --     middleware fails open and Settings hangs rather than erroring).
  IF NOT has_column_privilege('authenticated', 'public.players_self', 'onboarding_completed', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.players_self', 'eligibility_flag', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.players_self', 'email', 'SELECT') THEN
    RAISE EXCEPTION '00134: authenticated cannot read a players_self column the player app selects';
  END IF;

  -- (7) NOTHING ELSE MOVED. Diffed against the snapshot taken before the first
  --     REVOKE, in BOTH directions, tables and columns together — so a mistyped
  --     relation name in section B, or a table-level revoke reaching down into
  --     a column grant it had no business touching, shows up here by name.
  --
  --     This is what protects `players` itself: the file never names it, but
  --     the grants a slip would eat are 00032's column-level SELECT grant (the
  --     one 00115 exists because a database once silently lost) and the absence
  --     of INSERT that made players_self the only member insert path.
  --
  --     THE EXPECTED DIFFERENCE IS ENUMERATED rather than ignored. Exactly four
  --     privileges should have disappeared and none should have appeared; the
  --     `EXCEPT` in the other direction is what makes a widening as loud as a
  --     narrowing.
  SELECT string_agg(d.rel::regclass::text || coalesce(nullif('.' || d.col, '.'), '') ||
                    ' ' || d.privilege_type || ' for ' ||
                    coalesce(pg_get_userbyid(d.grantee), 'PUBLIC'),
                    ', ' ORDER BY d.rel::regclass::text, d.col, d.privilege_type)
    INTO offender
  FROM (
    SELECT * FROM _00134_acl_before
    EXCEPT
    SELECT c.oid, ''::name, a.grantee, a.privilege_type
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid IN ('public.players'::regclass, 'public.players_self'::regclass)
    EXCEPT
    SELECT c.oid, att.attname, a.grantee, a.privilege_type
    FROM pg_class c
    JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0
    CROSS JOIN LATERAL aclexplode(att.attacl) a
    WHERE c.oid IN ('public.players'::regclass, 'public.players_self'::regclass)
    -- The four this file is here to remove, and only those four.
    EXCEPT
    SELECT 'public.players_self'::regclass, ''::name, 'authenticated'::regrole::oid, p
    FROM unnest(ARRAY['INSERT','UPDATE','DELETE','MAINTAIN']) p
  ) d;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION '00134: collateral damage — these privileges disappeared: %', offender;
  END IF;

  SELECT string_agg(d.rel::regclass::text || coalesce(nullif('.' || d.col, '.'), '') ||
                    ' ' || d.privilege_type || ' for ' ||
                    coalesce(pg_get_userbyid(d.grantee), 'PUBLIC'),
                    ', ' ORDER BY d.rel::regclass::text, d.col, d.privilege_type)
    INTO offender
  FROM (
    SELECT c.oid AS rel, ''::name AS col, a.grantee, a.privilege_type
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid IN ('public.players'::regclass, 'public.players_self'::regclass)
    UNION ALL
    SELECT c.oid, att.attname, a.grantee, a.privilege_type
    FROM pg_class c
    JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0
    CROSS JOIN LATERAL aclexplode(att.attacl) a
    WHERE c.oid IN ('public.players'::regclass, 'public.players_self'::regclass)
    EXCEPT
    SELECT * FROM _00134_acl_before
  ) d;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION '00134: this file GRANTED something it should not have: %', offender;
  END IF;

  --     And a spot-check by name, in case the snapshot itself was somehow
  --     empty — the two column grants 00115 exists to restate, and the one
  --     column whose appearance would mean 00032 had been undone.
  SELECT count(*) INTO n FROM _00134_acl_before;
  IF n < 40 THEN
    RAISE EXCEPTION '00134: the before-snapshot holds only % rows, too few to have checked anything', n;
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.players', 'handle', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.players', 'member_code', 'SELECT') THEN
    RAISE EXCEPTION '00134: players lost 00092/00115 column grants';
  END IF;
  IF has_column_privilege('authenticated', 'public.players', 'email', 'SELECT') THEN
    RAISE EXCEPTION '00134: authenticated can now SELECT players.email — 00032 has been undone';
  END IF;
  IF has_table_privilege('authenticated', 'public.players', 'INSERT') THEN
    RAISE EXCEPTION '00134: authenticated gained INSERT on players';
  END IF;

  -- (8) THE HOLE'S PRECONDITION IS STILL TRUE, and that is fine. Recorded
  --     rather than repaired: RLS on `players` is still bypassed through this
  --     view, because the owner owns both and relforcerowsecurity is false.
  --     That is now harmless — the only thing routed through the view is a
  --     SELECT already confined to auth.uid() by the WHERE — but if a later
  --     migration re-grants a write here, section C's check option is what is
  --     left, so the next author should read this as "the view has one lock,
  --     not two".
  IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.players'::regclass) THEN
    RAISE NOTICE '00134: players now FORCEs row security — the definer-bypass note in section D(8) is stale, and re-reading it is worthwhile';
  END IF;

  RAISE NOTICE '00134 OK: players_self is SELECT-only for authenticated, WITH CHECK OPTION, definer semantics retained';
END
$do$;

-- Dropped explicitly rather than left to ON COMMIT, for the reason given where
-- it is created: this file must behave the same whether the runner wraps it in
-- a transaction or applies it statement-at-a-time.
DROP TABLE IF EXISTS _00134_acl_before;

COMMENT ON VIEW public.players_self IS
  'The signed-in member''s own players row, all columns. Definer semantics '
  '(security_invoker=false) on purpose: 00032 replaced blanket SELECT on '
  'players with a 16-column grant, and this view is how a member reads the '
  'other 16 about themselves. READ ONLY — `authenticated` holds SELECT and '
  'nothing else (00134). Do not re-grant INSERT/UPDATE/DELETE here: under '
  'definer semantics they bypass every RLS policy on players. Do not '
  'CREATE OR REPLACE it either — the column list is deliberately frozen '
  '(00060, 00111, 00130) and a recreate re-mints the default write grants.';

-- ------------------------------------------------------------
-- FOUND, NOT FIXED
-- ------------------------------------------------------------
-- 1. WHAT A MEMBER CAN STILL DO, after this file. Stated so the next audit has
--    a baseline. `authenticated` keeps table-level UPDATE on `players` with a
--    45-column UPDATE grant, governed by `players_update_own`
--    (USING and WITH CHECK `user_id = auth.uid()`) and by
--    guard_player_privileged_columns. `user_id` is pinned by the policy's WITH
--    CHECK, and the privilege columns by the trigger — but the trigger does NOT
--    guard `email`, `handle`, `member_code`, `id`, `created_at` or `joined_at`,
--    so a member can still set their own players.email to an arbitrary string
--    by writing the base table directly. That is the same identity concern this
--    file describes for INSERT, surviving on a different path. It predates this
--    file, it is not reachable through players_self, and closing it is a change
--    to the guard trigger rather than to a grant — a different migration.
--
-- 2. `players_self_insert` IS STILL DEAD CODE, and is left in place. With the
--    view's INSERT gone, `authenticated` now has no INSERT path to `players` at
--    all, so the policy still never runs. Dropping it would be tidier and is
--    deliberately not done: it is the written statement of what a self-created
--    row is allowed to be, `create_player_with_rating` and
--    `ensure_player_for_user` both cite it as the rule they mirror
--    (00003:864, 00023:66, 00126:151), and a policy that grants nothing costs
--    nothing. Retiring it should happen in the same file that retires the last
--    thing quoting it.
--
-- 3. PRODUCTION STILL HAS `anon=wdm` ON `players` — UPDATE, DELETE and MAINTAIN
--    for the browser's anonymous key. Inert, because `anon` has no policy on
--    `players` and no column SELECT beyond `id`, so RLS refuses every row. It is
--    already fixed by 00131, which is committed and not yet deployed. Not
--    touched here; this file's subject is one view.
--
-- 4. STAGING AND PRODUCTION HAVE DRIFTED ON THIS VERY VIEW, measured
--    2026-08-16. Neither is repaired here — see "ALTER VIEW, never CREATE OR
--    REPLACE" for why a repair is more dangerous than the drift:
--      * players_self is 32 columns on production and 44 on staging. 00111:113
--        says "players_self is a view frozen at 00032's column list, so it does
--        not [expose competition_category]". That is TRUE on production and
--        FALSE on staging, where the view also carries permission_role,
--        permission_grants, permission_revokes, inactive_since and
--        inactivity_notice_sent_at. Own-row only, so it is a member seeing
--        their own permissions rather than anybody else's — an information
--        disclosure, not an escalation — but it means the two databases
--        disagree about what a documented invariant means, and somebody should
--        decide which one is correct before the next release.
--      * `purgeable_inactive_players` carries `authenticated=arwdm` on staging
--        and nothing at all on production. Same mechanism as this file's
--        subject — a view created after Supabase's default privileges, never
--        revoked. It is the other view in schema `public`, and it is the next
--        one somebody should look at.
--    This file is safe on both, and that was measured rather than assumed: the
--    whole 36-check container suite was run a second time with the view built to
--    staging's 44-column shape (and staging's `anon` state, which 00128/00131
--    already cleaned there), and all 36 pass unchanged. It names no column, and
--    ALTER VIEW ... SET leaves the column list alone whichever list it is.
-- ============================================================
