-- ============================================================
-- 00131 — The `anon` reach 00126 and 00128 deliberately left
-- ============================================================
-- 00126 took EXECUTE on the SECURITY DEFINER RPCs away from the browser key.
-- 00128 took the table grants. Each named, in its own "FOUND, NOT FIXED"
-- section, work it was not going to do. This file is that work, plus two
-- things neither of them could see from where they stood.
--
-- THE TRAP BOTH OF THEM DOCUMENT STILL APPLIES TO EVERY LINE BELOW. Supabase
-- runs, on every project:
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ... TO anon, authenticated, service_role;
-- so a new object does not get the PUBLIC default; it gets EXPLICIT
-- `anon=.../postgres` entries. `REVOKE ... FROM PUBLIC` removes only the
-- `=.../postgres` entry and leaves those. And `REVOKE ... FROM anon` alone is
-- equally a no-op whenever a PUBLIC entry survives, because anon is a member of
-- PUBLIC. Every statement here names PUBLIC **and** the role, for that reason.
--
-- FIVE THINGS ARE CLOSED. Three more are measured and left, with the reason.
--
--   1. guard_player_privileged_columns opens with `auth.uid() IS NULL`, which
--      is true for anon as well as for the console.            — section A
--   2. anon and authenticated hold CREATE on schema public.     — section B
--   3. Three SECURITY DEFINER mutators are anon-EXECUTE-able on STAGING while
--      being correctly closed on production.                    — section C
--   4. Two sequences in public still carry anon; 00128's sweep could not see
--      them because it filtered relkind IN ('r','v','m','p').   — section D
--   5. supabase_functions' three relations, which are provably dead.
--                                                               — section E
--
--   NOT FIXED: storage (9 relations), realtime (4).             — foot of file
--
-- MEASURED ON BOTH DATABASES, 2026-08-16, because they have drifted and
-- section C exists only because they have:
--   production  ssh pi 'docker exec -i supabase-db psql -U postgres'
--   staging     ssh pi 'docker exec -i supabase-staging-db psql -U postgres'
-- Production carries 00121 and earlier. Staging carries 00122-00130.
--
-- IDEMPOTENT throughout. REVOKE is naturally so, CREATE OR REPLACE is, and the
-- assertion block at the foot re-derives every claim from the catalogue rather
-- than trusting that a statement took.
--
-- ------------------------------------------------------------
-- VERIFIED IN A THROWAWAY PostgreSQL 17 CONTAINER
-- ------------------------------------------------------------
-- Three things about how it was built, each of which the test would have been
-- worthless without:
--
--   * SUPABASE'S `ALTER DEFAULT PRIVILEGES` WAS APPLIED BEFORE THE STUB
--     OBJECTS WERE CREATED, and the resulting ACLs were ASSERTED against the
--     ones measured here — anon holding SELECT/INSERT/UPDATE/DELETE/MAINTAIN on
--     players, rwU on the sequences, UC on schema public, EXECUTE on the three
--     mutators. An object created before those defaults exist comes out with
--     relacl = NULL and every REVOKE below "passes" having done nothing.
--
--   * THE BOOTSTRAP SUPERUSER WAS `supabase_admin`, AND `postgres` WAS AN
--     ORDINARY NOSUPERUSER ROLE, because that is what production is
--     (pg_roles.rolsuper: supabase_admin true, postgres false). A superuser is
--     implicitly a member of every role and can revoke privileges it never
--     granted. An earlier run of this harness used the container's own
--     superuser `postgres` and "proved" that section F's storage revoke would
--     work — which is false. With the roles laid out as production has them,
--     `REVOKE ALL ON storage.objects FROM anon` issued by postgres returns
--     `WARNING: no privileges could be revoked for "objects"` and leaves
--     `anon=arwdDxtm/supabase_storage_admin` exactly where it was, while the
--     identical statement against supabase_functions.hooks takes effect —
--     which is the whole distinction between sections E and F.
--
--   * anon DELIBERATELY HELD SELECT/INSERT/UPDATE ON players FOR THE
--     BEHAVIOURAL RUN. With 00128's revokes in force, `SET ROLE anon; UPDATE
--     players` fails with `42501: permission denied for table players` and says
--     nothing whatever about the trigger. The grant was restored after this
--     file applied — which is precisely the "one GRANT written by a future
--     migration in a hurry" that section A exists to survive — and the refusal
--     then comes back as `P0001: Not authorized to modify privileged player
--     fields`, i.e. from the guard.
--
-- RUN ON TWO DATABASES, because production and staging disagree about who owns
-- schema public (postgres vs pg_database_owner). Identical results on both.
--
-- THE MATRIX, before -> after. Every "MUST STAY" line is a path that works
-- today and had to keep working:
--
--   anon: promote self to admin                    ALLOWED -> REFUSED (trigger)
--   anon: INSERT a privileged player row           ALLOWED -> REFUSED (trigger)
--   anon: EXECUTE reverse_match_result             ALLOWED -> REFUSED (42501)
--   authenticated: EXECUTE activate_season         ALLOWED -> REFUSED (42501)
--   anon: CREATE TABLE in public                   ALLOWED -> REFUSED (42501)
--   authenticated: CREATE FUNCTION in public       ALLOWED -> REFUSED (42501)
--   anon: nextval on a public sequence             ALLOWED -> REFUSED (42501)
--   anon: SELECT supabase_functions.hooks          ALLOWED -> REFUSED (42501)
--   service_role: promote a member         MUST STAY ALLOWED -> ALLOWED
--   service_role: EXECUTE activate_season  MUST STAY ALLOWED -> ALLOWED
--   admin on the browser key: promote      MUST STAY ALLOWED -> ALLOWED
--   member: write an unguarded column      MUST STAY ALLOWED -> ALLOWED
--   postgres (a migration): promote        MUST STAY ALLOWED -> ALLOWED
--   anon: get_leaderboard()                MUST STAY ALLOWED -> ALLOWED
--   anon: SELECT public.ratings            MUST STAY ALLOWED -> ALLOWED
--   authenticated: nextval on a sequence   MUST STAY ALLOWED -> ALLOWED
--   member -> postgres-owned SECDEF fn ->
--     a guarded column                    MUST STAY REFUSED -> REFUSED
--
-- TWO NEGATIVE CONTROLS, because a green matrix on its own only shows that the
-- tests agree with the code:
--
--   1. Flip the NEW body back to SECURITY DEFINER and change nothing else:
--      anon is ADMITTED again on both rows. That is what the prosecdef
--      assertion at the foot exists to catch, and run against that state it
--      does abort the file.
--   2. Install 00129's three-branch OR-form verbatim: the last row of the
--      matrix — a member reaching a guarded column through a postgres-owned
--      SECURITY DEFINER function — flips from REFUSED to ALLOWED. That single
--      line is the entire reason this file ANDs the two tests instead.
-- ============================================================

BEGIN;

-- ============================================================
-- A. guard_player_privileged_columns — TELL anon FROM THE CONSOLE
-- ============================================================
-- WHAT IS WRONG. The function opens
--
--     -- auth.uid() IS NULL covers the service-role console, which has already
--     -- checked the caller's level in a server action.
--     IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN RETURN NEW; END IF;
--
-- and the comment is only half true. auth.uid() reads the JWT `sub` claim out
-- of a GUC PostgREST sets per request. The service-role key has no `sub`, so
-- the console lands in that branch — but neither does the ANON key, so an
-- anonymous caller lands in exactly the same branch and every check below it
-- is skipped. It is the shape 00126:37-39 documented on apply_match_result,
-- where `IF auth.uid() IS NOT NULL AND NOT is_admin(...)` let anon force-confirm
-- any match in the club, and the shape 00129:45-49 said was the one mistake it
-- could not copy.
--
-- NOT EXPLOITABLE TODAY, and that is the whole point: the only thing standing
-- between anon and a self-service promotion to admin is 00128 having taken
-- anon's UPDATE on players away. A guard is not supposed to be load-bearing
-- somewhere else. One `GRANT UPDATE ON players TO anon` written by a future
-- migration in a hurry and this is a live privilege-escalation hole with no
-- second line behind it.
--
-- ------------------------------------------------------------
-- THE BODY BELOW IS THE LIVE ONE, NOT A RECONSTRUCTION
-- ------------------------------------------------------------
-- 00093:346's own COMMENT says "Replaced wholesale on every change: CREATE OR
-- REPLACE takes the whole body, so a column omitted here loses its protection
-- silently. Dump the live definition before editing." That was done. The body
-- below is `pg_get_functiondef()` off PRODUCTION, taken 2026-08-16, with the
-- five-line opening replaced and nothing else touched; the same dump off
-- STAGING is byte-identical, and both are byte-identical to 00093:274-344, so
-- this function has not drifted from its file the way others in this directory
-- have. Every one of the seventeen guarded columns is still named.
--
-- ------------------------------------------------------------
-- IT BECOMES SECURITY **INVOKER**, AND THAT IS THE MECHANISM
-- ------------------------------------------------------------
-- The test that tells anon from the console is `current_user`, which PostgREST
-- sets per request from the verified key (00128 counted the call: 94819
-- `set_config('role', ...)` statements attributed to anon in nineteen days).
-- 00129 established the pattern here and explains why it is the right one: it
-- is set by the server from a signed token and no request body can influence
-- it.
--
-- current_user is only useful in a SECURITY INVOKER function. Left SECURITY
-- DEFINER, current_user reports the OWNER (postgres) for every caller, the
-- first branch below degenerates to `auth.uid() IS NULL`, and the fix is
-- silently vacuous. That is why the closing assertion checks prosecdef = false:
-- a later CREATE OR REPLACE that restores SECURITY DEFINER would reopen anon
-- with no other symptom at all.
--
-- The flip is safe. The body touches NO table — it reads NEW/OLD, calls
-- auth.uid() and is_admin(), and RAISEs — so there is no RLS consequence and
-- nothing that needed the owner's rights. auth.uid() is EXECUTE-able by PUBLIC
-- (`=X/supabase_auth_admin`) and is_admin(uuid) by anon and authenticated
-- (00126:70-77 keeps both deliberately, because 44 RLS policies call it), so no
-- caller can hit 42501 on the way in. A trigger's own firing never consults the
-- invoker's EXECUTE grant on the trigger function either — that is checked once
-- against the creator at CREATE TRIGGER time.
--
-- ------------------------------------------------------------
-- WHY THE GUARD IS **NOT** 00129'S THREE-BRANCH FORM
-- ------------------------------------------------------------
-- 00129 writes
--     current_user = 'service_role'
--       OR current_user NOT IN ('anon','authenticated')
--       OR (auth.uid() IS NOT NULL AND is_admin(auth.uid()))
-- and that form, copied here, would LOOSEN this function. 00129:362-372 says so
-- itself, as a standing condition: because the trigger reads current_user, any
-- postgres-owned SECURITY DEFINER function that `authenticated` may EXECUTE
-- gets `current_user = 'postgres'` inside its body and sails through branch two.
--
-- For one column that is acceptable. For the seventeen below it is not, and the
-- caller that makes it concrete already exists: create_player_with_rating is
-- SECURITY DEFINER, postgres-owned, writes players.role and players.status, and
-- `authenticated` still holds EXECUTE on it (00126:147-156 keeps it on purpose
-- — onboarding needs it). TODAY, a member calling it gets auth.uid() = their
-- own uid inside the trigger, is_admin() false, and the guard ENFORCES.
-- Under 00129's form it would not. Its own internal guard would still refuse
-- the escalation, so nothing is exploitable either way, but trading a layer of
-- defence in depth across the whole privilege surface for a fix to an anon hole
-- is not a trade worth making.
--
-- SO THE TWO TESTS ARE **ANDed**, NOT ORed:
--
--     IF (current_user = 'service_role' OR current_user NOT IN ('anon','authenticated'))
--        AND auth.uid() IS NULL
--     THEN RETURN NEW;                     -- the console, or a DB-level caller
--
--     IF auth.uid() IS NOT NULL AND is_admin(auth.uid())
--     THEN RETURN NEW;                     -- an admin on a browser key
--
-- The result is STRICTLY TIGHTER than what is live. Enumerated, every caller:
--
--   anon over PostgREST      current_user 'anon' → branch 1 false;
--                            auth.uid() NULL → branch 2 false. ENFORCED.
--                            *** This is the entire behaviour change. ***
--   service_role (console)   current_user 'service_role', auth.uid() NULL
--                            → branch 1. Bypass, exactly as today. And it
--                            needs no new verification: today's bypass ALREADY
--                            depends on auth.uid() being NULL for that key, and
--                            the console works, therefore it is NULL.
--   authenticated, member    branch 1 false (browser role), branch 2 false.
--                            ENFORCED, exactly as today.
--   authenticated, admin     branch 2. Bypass, exactly as today. Kept for
--                            00092's reason: an admin editing their own row
--                            from the player app must not be locked out of it.
--   psql / postgres / pg_cron / a migration
--                            current_user 'postgres', auth.uid() NULL
--                            → branch 1. Bypass, exactly as today.
--   supabase_auth_admin, and any other server role
--                            same shape → branch 1. Bypass, as today. Written
--                            as NOT IN over the two browser keys rather than
--                            IN over a list of server roles, for 00129's
--                            reason: a role nobody has thought of yet should
--                            not be silently refused.
--   a member inside a postgres-owned SECURITY DEFINER function
--                            current_user 'postgres' BUT auth.uid() is their
--                            uid → branch 1 false, branch 2 false unless they
--                            are an admin. ENFORCED, exactly as today. This is
--                            the row 00129's form would have lost.
--
-- The bypass set loses exactly `auth.uid() IS NULL AND current_user IN
-- ('anon','authenticated')` and gains nothing. Nothing except anon changes.
CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY INVOKER (the default, spelled out because it is load-bearing —
-- see above, and see the prosecdef assertion at the foot).
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
BEGIN
  -- The console, or a caller that is not a browser key at all. BOTH halves are
  -- required: current_user alone would admit a member inside a postgres-owned
  -- SECURITY DEFINER function, and auth.uid() alone is what let anon through.
  IF (current_user = 'service_role' OR current_user NOT IN ('anon', 'authenticated'))
     AND auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- An admin editing a row from the player app, on the browser key.
  -- auth.uid() IS NOT NULL first, so this branch can never be the one that
  -- decides an anonymous request; is_admin(NULL) is already false and saying so
  -- explicitly is for the reader.
  IF auth.uid() IS NOT NULL AND is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- ---- EVERYTHING BELOW THIS LINE IS 00093'S BODY, UNCHANGED ----
  IF TG_OP = 'INSERT' THEN
    -- A self-created row may only ever be an ordinary, unapproved member.
    IF COALESCE(NEW.is_exec, FALSE)
       OR COALESCE(NEW.is_trainer, FALSE)
       OR COALESCE(NEW.fee_exempt, FALSE)
       OR COALESCE(NEW.is_banned, FALSE)
       OR NEW.role IS DISTINCT FROM 'player'
       OR NEW.status IS DISTINCT FROM 'pending_approval'
       -- Added: a self-created row claiming an office is the same escalation as
       -- editing one in, and get_executives() would publish it.
       OR NEW.exec_title IS NOT NULL
       -- REPLACES 00086's portfolio line, for the same reason it existed: a
       -- self-created row cannot be an exec at all (is_exec is refused above),
       -- so permissions on one are meaningless — but they must not be a way to
       -- pre-stage values that come into force the moment an admin grants
       -- is_exec. cardinality(), not IS NOT NULL: see the note above.
       OR NEW.permission_role IS NOT NULL
       OR cardinality(COALESCE(NEW.permission_grants, '{}')) > 0
       OR cardinality(COALESCE(NEW.permission_revokes, '{}')) > 0
       -- 00093. Pre-staging in its purest form: a label that grants nothing
       -- today and is filled in by the next edit to that baseline.
       OR NEW.permission_baseline_id IS NOT NULL THEN
      RAISE EXCEPTION 'Not authorized to create a privileged player row';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     -- Published to anonymous visitors by get_executives(), so an unguarded
     -- write is a public claim to an office the member does not hold, not a
     -- cosmetic field on their own profile.
     OR NEW.exec_title   IS DISTINCT FROM OLD.exec_title
     -- THE 00087 REPLACEMENT for 00086's portfolio line. All three, because
     -- omitting any one of them leaves a complete escalation path: the role
     -- alone chooses the base, a grant alone adds to it, and clearing a revoke
     -- alone hands back whatever the club took away.
     OR NEW.permission_role IS DISTINCT FROM OLD.permission_role
     OR NEW.permission_grants IS DISTINCT FROM OLD.permission_grants
     OR NEW.permission_revokes IS DISTINCT FROM OLD.permission_revokes
     -- 00093's fourth. See the column comment: this one is a promise of access
     -- rather than access, and the promise is kept by the next propagation.
     OR NEW.permission_baseline_id IS DISTINCT FROM OLD.permission_baseline_id
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_player_privileged_columns() IS
  'Blocks a member — or an anonymous caller — from granting themselves privilege via a direct PostgREST write to their own players row. Replaced wholesale on every change: CREATE OR REPLACE takes the whole body, so a column omitted here loses its protection silently. Dump the live definition before editing. SECURITY INVOKER ON PURPOSE (00131): the console is told apart from anon by current_user, which PostgREST sets per request from the verified key, and a SECURITY DEFINER rewrite would report the owner for every caller and collapse the first branch back to the `auth.uid() IS NULL` test that admitted anon.';

-- 00129:276's COMMENT on the neighbouring trigger says this function "waves
-- through the service-role console AND anon alike". True when it was written,
-- false as of the statement above. 00129's FILE is not edited — 00128:263-268
-- sets the precedent that rewriting an applied-order migration to chase a
-- dependency a later one removed is how migration pairs get skewed — but the
-- COMMENT lives in the catalogue, not in the file, so it is corrected here.
COMMENT ON FUNCTION public.guard_competition_category_lock() IS
  'Makes players.competition_category write-once for a member: NULL to a value is theirs to make, every later change (including back to NULL) needs the console. SECURITY INVOKER ON PURPOSE — it tells an exec edit from a member edit by current_user, which PostgREST sets per request from the verified key, and a SECURITY DEFINER rewrite would report the owner for every caller and open the lock to everybody. Deliberately NOT folded into guard_player_privileged_columns, which 00131 has since given the same current_user test (ANDed with auth.uid() IS NULL rather than ORed, so it does not lose the nested-SECURITY-DEFINER case). See 00129 and 00131.';

-- ============================================================
-- B. CREATE ON SCHEMA public
-- ============================================================
-- MEASURED. nspacl on production reads
--   {postgres=UC/postgres,anon=UC/postgres,authenticated=UC/postgres,service_role=UC/postgres}
-- and on staging
--   {pg_database_owner=UC/pg_database_owner,postgres=U/pg_database_owner,
--    anon=UC/pg_database_owner,authenticated=UC/pg_database_owner,service_role=UC/pg_database_owner}
-- — the two databases disagree on who owns the schema, which is why the grantor
-- was checked rather than assumed (below). `public` is the ONLY schema in
-- either database where anon or authenticated holds CREATE; the other twelve
-- are already U-only.
--
-- NOT EXPLOITABLE TODAY. anon and authenticated are NOLOGIN, so the only way to
-- become them is PostgREST's per-request `set_config('role', ...)`, and
-- PostgREST issues no DDL — it emits SELECT/INSERT/UPDATE/DELETE and CALL and
-- nothing else. Nineteen days of pg_stat_statements under the anon role show
-- seven statement shapes and not one of them is DDL.
--
-- IT IS REVOKED ANYWAY, for 00128's reason: nobody chose it, it is the second
-- copy of a permission decision pointing the wrong way, and CREATE on a schema
-- is not a small privilege to be holding by accident — it is the right to add a
-- table, a view or a FUNCTION to the schema PostgREST exposes.
--
-- USAGE IS KEPT, AND IS ESSENTIAL. Without USAGE on public, anon cannot resolve
-- public.get_leaderboard() and the logged-out landing page and /leaderboard
-- both stop rendering. Only the C is taken.
--
-- WHAT BREAKS: nothing. No app code issues DDL; migrations run as postgres,
-- which keeps its own rights (it is the database owner on both databases, so
-- it holds them through pg_database_owner on staging even though its explicit
-- entry there is only U).
--
-- service_role IS LEFT ALONE. It is not a browser key — it never leaves the
-- server — so it is outside this file's subject, and no evidence was gathered
-- about what a server action might one day need. Left as found, deliberately.
--
-- THE GRANTOR WAS CHECKED, because a REVOKE by a role that is neither the
-- object's owner nor the recorded grantor emits `WARNING: not all privileges
-- could be revoked` and changes nothing. On staging the grantor is
-- pg_database_owner, and pg_has_role('postgres','pg_database_owner','MEMBER')
-- is TRUE on both databases (postgres is the owner of database `postgres`, and
-- pg_database_owner implicitly contains the current database's owner), so one
-- statement is correct on both. Contrast section F, where the same check comes
-- back false and no statement is written.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- ============================================================
-- C. THREE SECURITY DEFINER MUTATORS THAT ARE OPEN ON STAGING
-- ============================================================
-- 00126 measured production and closed what it found there. These three were
-- already closed on production, so it never named them. On STAGING all three
-- carry the full default-privilege ACL:
--
--   FUNCTION                                 production            staging
--   activate_season(uuid,text,numeric)       postgres,service_role postgres,anon,authenticated,service_role
--   apply_walkover_result(uuid,uuid,text)    postgres,service_role postgres,anon,authenticated,service_role
--   reverse_match_result(uuid)               postgres,service_role postgres,anon,authenticated,service_role
--
-- HOW THE TWO DATABASES DIVERGED. 00018:95 revoked EXECUTE on these from
-- PUBLIC, anon and authenticated. CREATE OR REPLACE preserves an ACL, but a
-- DROP-then-CREATE does not: the recreated function inherits Supabase's
-- ALTER DEFAULT PRIVILEGES afresh. Staging's schema was built by replaying the
-- whole directory, production's was not, and somewhere in that replay these
-- three were recreated after 00018 rather than replaced. 00125:680-718 called
-- this class out as systemic and predicted exactly it: "Every other SECURITY
-- DEFINER function added since should be audited the same way."
--
-- WHY IT MATTERS EVEN THOUGH PRODUCTION IS FINE. Staging is what the owner
-- tests on, and a hole that exists only on the database used to prove things
-- are safe is worse than one that exists on both. And the next DROP-and-CREATE
-- of any of these — a signature change, a rebuild, a restore — reopens it on
-- production too.
--
-- WHAT THEY DO, and it is the worst three to have open. reverse_match_result
-- unwinds a confirmed match and every Elo delta it caused. activate_season
-- closes a season, snapshots season_final_ratings and resets the ladder.
-- apply_walkover_result confirms a forfeit and calls apply_match_result.
-- None of the three checks its caller: their authorisation lives in the admin
-- app's capability gates, which a direct PostgREST RPC never runs.
--
-- CALLERS, resolved the way 00126 resolved them — grep for `.rpc('name'` and
-- name the client each call site holds. All three, and only these three:
--   activate_season       apps/admin/src/lib/actions/seasons.ts:126  adminClient
--   apply_walkover_result apps/admin/src/lib/actions/walkovers.ts:42 adminClient
--   reverse_match_result  apps/admin/src/lib/actions/matches.ts:112  adminClient
--                         apps/admin/src/lib/actions/matches.ts:188  adminClient
-- `adminClient` is createAdminClient(), which holds SUPABASE_SERVICE_ROLE_KEY,
-- and service_role keeps its grant below. No app change ships with this file.
--
-- THE EVIDENCE THAT `authenticated` IS NOT NEEDED IS UNIMPROVABLE: production
-- has run these three at exactly postgres+service_role for months, live, and
-- the admin app works. This section makes staging match production; on
-- production it is a no-op.
REVOKE EXECUTE ON FUNCTION public.activate_season(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_walkover_result(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_match_result(uuid)
  FROM PUBLIC, anon, authenticated;

-- service_role is re-granted rather than assumed, so this section is correct
-- on a database where the function was recreated with no ACL at all.
GRANT EXECUTE ON FUNCTION public.activate_season(uuid, text, numeric)       TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_walkover_result(uuid, uuid, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_match_result(uuid)                 TO service_role;

-- ============================================================
-- D. THE SEQUENCES 00128'S SWEEP COULD NOT SEE
-- ============================================================
-- 00128's sweep read `WHERE c.relkind IN ('r','v','m','p')` — tables,
-- partitioned tables, views, matviews. Sequences are relkind 'S' and were
-- therefore never in its FROM clause, and neither was
-- `ALTER DEFAULT PRIVILEGES ... ON SEQUENCES`, which is a separate defaclobjtype
-- ('S') from the one it reset. So after 00128, on BOTH databases:
--
--   club_expenses_ref_no_seq  {postgres=rwU, anon=rwU, authenticated=rwU, service_role=rwU}
--   other_income_ref_no_seq   {postgres=rwU, anon=rwU, authenticated=rwU, service_role=rwU}
--   pg_default_acl 'S' in public: {anon=rwU/postgres, authenticated=rwU/postgres, service_role=rwU/postgres}
--
-- `U` is USAGE, which is nextval(). `r` is SELECT, which is reading last_value.
--
-- UNREACHABLE, but for a reason that is not about the sequences: anon holds no
-- INSERT anywhere in public after 00128, so there is no statement it can issue
-- that would consume a default, and PostgREST does not expose sequences as
-- endpoints. It is the same "nobody chose it" residue as section B.
--
-- ONLY anon IS REVOKED. `authenticated` keeps USAGE, and that is deliberate:
-- a sequence USAGE grant is what makes a column DEFAULT nextval() work for the
-- INSERTING role, so revoking it from authenticated risks breaking an insert
-- path that nothing in this file has measured. Section B's rule applies —
-- breaking a working path is worse than leaving a grant nothing can use.
--
-- A SWEEP AS WELL AS THE TWO NAMES, for 00128:175-186's reason: the two
-- databases carry different relations and a hand-written list cannot be right
-- on both. The names are kept below the sweep as documentation of what it
-- matched when this was written.
DO $seq_sweep$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS ident
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'S'
       AND c.relacl IS NOT NULL
       AND c.relacl::text LIKE '%anon=%'
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM PUBLIC, anon', r.ident);
  END LOOP;
END
$seq_sweep$;

-- Matched by the sweep above on both databases, 2026-08-16.
--   public.club_expenses_ref_no_seq
--   public.other_income_ref_no_seq

-- The postgres-owned default entry, so the next sequence created in public does
-- not arrive with the grant already on it. 00128 did exactly this for TABLES;
-- the SEQUENCES entry is a different row in pg_default_acl and it missed it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ============================================================
-- E. supabase_functions — THREE RELATIONS, PROVABLY DEAD
-- ============================================================
-- MEASURED. anon holds arwdDxtm on supabase_functions.hooks and .migrations,
-- and rwU on hooks_id_seq — the whole default-privilege set, on both databases.
--
-- POSTGRES CAN REVOKE HERE, unlike storage (section F). The relations are owned
-- by and were granted by supabase_functions_admin, and postgres holds INHERITED
-- membership in it.
--
-- THE PREDICATE MATTERS, AND IT IS NOT THE OBVIOUS ONE. REVOKE picks its
-- grantor through has_privs_of_role(), i.e. the INHERITED path, so the test is
--   pg_has_role('postgres','supabase_functions_admin','USAGE')   -- TRUE
-- and NOT
--   pg_has_role('postgres','supabase_functions_admin','MEMBER')  -- also TRUE
-- which is satisfied by a SET-only membership that REVOKE would ignore. Both
-- come back true here (pg_auth_members.inherit_option = t, rolinherit = t on
-- postgres), on both databases, so the distinction does not bite — but a future
-- reader checking the wrong one would be right by luck. Section F's storage
-- case is false under BOTH predicates, so it is settled either way.
--
-- AND IT IS PROVABLY SAFE, three independent ways, all measured on production:
--   * The schema is not exposed. PGRST_DB_SCHEMAS on supabase-rest is
--     `public,storage,graphql_public`. PostgREST cannot address a
--     supabase_functions relation at all, so no anon request can reach one.
--   * The mechanism is unused. supabase_functions.hooks holds 0 rows, no
--     trigger in the database calls a supabase_functions function, and no
--     pg_proc body outside the schema references it. It is the legacy Database
--     Webhooks plumbing; this project's scheduled work goes through pg_cron and
--     pg_net (schema `net`), not through here.
--   * Nothing in either app mentions it.
--
-- authenticated IS LEFT, for section D's reason: this file's subject is anon,
-- authenticated's grant here is equally dead, and removing it would be a change
-- made on no evidence about what a signed-in path might use. Noted at the foot.
REVOKE ALL PRIVILEGES ON TABLE supabase_functions.hooks      FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON TABLE supabase_functions.migrations FROM PUBLIC, anon;
REVOKE ALL PRIVILEGES ON SEQUENCE supabase_functions.hooks_id_seq FROM PUBLIC, anon;

-- ============================================================
-- ASSERTIONS — every claim above re-derived from the catalogue
-- ============================================================
-- Each block raises rather than warns, so a statement that did not take aborts
-- the whole file instead of leaving a half-applied state that reads as done.
-- Written as final-state checks, so section C passes as a no-op on production
-- and as a real change on staging.
DO $assert$
DECLARE
  v_secdef  boolean;
  v_src     text;
  v_count   integer;
  v_names   text;
BEGIN
  -- ---- A. the guard ----
  SELECT p.prosecdef, p.prosrc
    INTO v_secdef, v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_player_privileged_columns';

  IF v_secdef IS NULL THEN
    RAISE EXCEPTION '00131: guard_player_privileged_columns is missing';
  END IF;

  -- THE ASSERTION THIS FILE MOST NEEDS. SECURITY DEFINER would make
  -- current_user report the owner, collapse branch 1 to `auth.uid() IS NULL`,
  -- and reopen anon with no other symptom.
  IF v_secdef THEN
    RAISE EXCEPTION
      '00131: guard_player_privileged_columns is SECURITY DEFINER; it reads current_user and must be SECURITY INVOKER or anon is admitted again';
  END IF;

  -- The old opening must be gone, and the new one present.
  IF v_src ~ 'IF\s+auth\.uid\(\)\s+IS\s+NULL\s+OR' THEN
    RAISE EXCEPTION '00131: the `auth.uid() IS NULL OR is_admin(...)` opening survived';
  END IF;
  IF v_src !~ 'current_user\s+NOT\s+IN' THEN
    RAISE EXCEPTION '00131: the current_user test is not in the live body';
  END IF;

  -- Nothing was lost from 00093's body. All seventeen guarded columns, plus
  -- both RAISE messages, must still appear — this is the check that catches a
  -- copy-paste that dropped a line.
  FOREACH v_names IN ARRAY ARRAY[
    'role', 'status', 'is_banned', 'is_exec', 'eligibility_flag', 'fee_exempt',
    'active_flag', 'waiver_reset_at', 'deletion_requested_at', 'membership_type',
    'exec_photo_url', 'exec_title', 'permission_role', 'permission_grants',
    'permission_revokes', 'permission_baseline_id', 'is_trainer'
  ] LOOP
    IF v_src !~ ('NEW\.' || v_names || '\M') THEN
      RAISE EXCEPTION '00131: guarded column % is no longer named in the body', v_names;
    END IF;
  END LOOP;
  IF v_src !~ 'Not authorized to create a privileged player row'
     OR v_src !~ 'Not authorized to modify privileged player fields' THEN
    RAISE EXCEPTION '00131: a RAISE arm of the guard was lost';
  END IF;

  -- Both triggers must still be attached to it, or the body is decoration.
  SELECT count(*) INTO v_count
    FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE t.tgrelid = 'public.players'::regclass
     AND NOT t.tgisinternal
     AND n.nspname = 'public'
     AND p.proname = 'guard_player_privileged_columns';
  IF v_count <> 2 THEN
    RAISE EXCEPTION '00131: expected 2 guard triggers on players (INSERT + UPDATE), found %', v_count;
  END IF;

  -- The functions the new body calls must be reachable by the browser roles,
  -- or SECURITY INVOKER turns a refusal into a 42501 for everyone.
  IF NOT has_function_privilege('anon', 'public.is_admin(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.is_admin(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00131: is_admin(uuid) is not EXECUTE-able by a browser role; the SECURITY INVOKER guard would raise 42501';
  END IF;
  IF NOT has_function_privilege('anon', 'auth.uid()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION '00131: auth.uid() is not EXECUTE-able by a browser role';
  END IF;

  -- ---- B. schema public ----
  IF has_schema_privilege('anon', 'public', 'CREATE') THEN
    RAISE EXCEPTION '00131: anon still holds CREATE on schema public';
  END IF;
  IF has_schema_privilege('authenticated', 'public', 'CREATE') THEN
    RAISE EXCEPTION '00131: authenticated still holds CREATE on schema public';
  END IF;
  -- USAGE is the half that must SURVIVE. Without it the public leaderboard
  -- cannot resolve get_leaderboard() and the landing page stops rendering.
  IF NOT has_schema_privilege('anon', 'public', 'USAGE')
     OR NOT has_schema_privilege('authenticated', 'public', 'USAGE')
     OR NOT has_schema_privilege('service_role', 'public', 'USAGE') THEN
    RAISE EXCEPTION '00131: USAGE on schema public was lost — this file must never take it';
  END IF;

  -- ---- C. the three mutators ----
  FOREACH v_names IN ARRAY ARRAY[
    'public.activate_season(uuid,text,numeric)',
    'public.apply_walkover_result(uuid,uuid,text)',
    'public.reverse_match_result(uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_names, 'EXECUTE') THEN
      RAISE EXCEPTION '00131: anon can still EXECUTE %', v_names;
    END IF;
    IF has_function_privilege('authenticated', v_names, 'EXECUTE') THEN
      RAISE EXCEPTION '00131: authenticated can still EXECUTE %', v_names;
    END IF;
    IF NOT has_function_privilege('service_role', v_names, 'EXECUTE') THEN
      RAISE EXCEPTION '00131: service_role LOST EXECUTE on % — the admin app calls it', v_names;
    END IF;
  END LOOP;

  -- The three RPCs the logged-out pages depend on must be untouched. 00126
  -- asserts this too; it is repeated because this file revokes in the same
  -- schema and a mistake here takes the public site down.
  FOREACH v_names IN ARRAY ARRAY[
    'public.get_leaderboard()', 'public.get_active_season()', 'public.get_executives()'
  ] LOOP
    IF NOT has_function_privilege('anon', v_names, 'EXECUTE') THEN
      RAISE EXCEPTION '00131: anon LOST EXECUTE on % — the logged-out site needs it', v_names;
    END IF;
  END LOOP;

  -- ---- D. sequences ----
  SELECT count(*), coalesce(string_agg(c.relname, ', '), '')
    INTO v_count, v_names
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S'
     AND c.relacl::text LIKE '%anon=%';
  IF v_count > 0 THEN
    RAISE EXCEPTION '00131: anon still holds privileges on % sequence(s) in public: %', v_count, v_names;
  END IF;
  SELECT count(*) INTO v_count
    FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
   WHERE n.nspname = 'public' AND d.defaclobjtype = 'S'
     AND d.defaclrole = 'postgres'::regrole
     AND d.defaclacl::text LIKE '%anon=%';
  IF v_count > 0 THEN
    RAISE EXCEPTION '00131: the postgres-owned SEQUENCES default privilege in public still names anon';
  END IF;
  -- authenticated must NOT have been swept up with it.
  IF NOT has_sequence_privilege('authenticated', 'public.club_expenses_ref_no_seq', 'USAGE') THEN
    RAISE EXCEPTION '00131: authenticated lost USAGE on a sequence; only anon was in scope';
  END IF;

  -- ---- E. supabase_functions ----
  SELECT count(*), coalesce(string_agg(c.relname, ', '), '')
    INTO v_count, v_names
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'supabase_functions' AND c.relacl::text LIKE '%anon=%';
  IF v_count > 0 THEN
    RAISE EXCEPTION
      '00131: anon still reaches % relation(s) in supabase_functions (%); postgres is a member of supabase_functions_admin so this REVOKE should have taken',
      v_count, v_names;
  END IF;

  -- ---- THE WHOLE POINT, stated once as a total ----
  -- After this file, the only relation anywhere in `public` that anon may touch
  -- is ratings, SELECT only — 00128's single deliberate exception, kept so the
  -- logged-out /leaderboard's realtime channel keeps behaving as it does today.
  SELECT count(*), coalesce(string_agg(c.relname || ':' || c.relacl::text, ' | '), '')
    INTO v_count, v_names
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relacl::text LIKE '%anon=%';
  IF v_count <> 1 OR v_names NOT LIKE 'ratings:%' THEN
    RAISE EXCEPTION '00131: expected anon to reach exactly public.ratings, found %: %', v_count, v_names;
  END IF;
  IF NOT has_table_privilege('anon', 'public.ratings', 'SELECT') THEN
    RAISE EXCEPTION '00131: anon LOST SELECT on ratings — the public leaderboard channel needs it (00128 section B)';
  END IF;
  IF has_table_privilege('anon', 'public.ratings', 'INSERT')
     OR has_table_privilege('anon', 'public.ratings', 'UPDATE')
     OR has_table_privilege('anon', 'public.ratings', 'DELETE') THEN
    RAISE EXCEPTION '00131: anon regained a write privilege on ratings';
  END IF;
END
$assert$;

COMMIT;

-- ============================================================
-- FOUND, NOT FIXED — with the measurement, so the next reader starts here
-- ============================================================
--
-- 1. STORAGE. anon holds grants on nine relations in schema `storage`:
--      buckets, objects                      arwdDxtm  (ALL)
--      buckets_analytics                     arwdDxtm  (ALL)
--      buckets_vectors, iceberg_namespaces, iceberg_tables,
--      s3_multipart_uploads, s3_multipart_uploads_parts, vector_indexes   r
--
--    POSTGRES CANNOT REVOKE THEM. Every one is owned by, and was granted by,
--    supabase_storage_admin, and postgres is not a member of it under EITHER
--    predicate — pg_has_role(...,'USAGE') and pg_has_role(...,'MEMBER') are both
--    FALSE on both databases, and there is no pg_auth_members row at all. This
--    was demonstrated rather than reasoned: in the container, with the roles laid
--    out as production has them, `REVOKE ALL PRIVILEGES ON storage.objects FROM
--    PUBLIC, anon` issued by postgres returns ten
--    `WARNING: no privileges could be revoked` lines, reports success, and
--    leaves `anon=arwdDxtm/supabase_storage_admin` exactly as it was. So no
--    statement is written above, rather than one that silently fails and then
--    trips its own assertion, aborting sections A-E with it. Applying it needs
--    a session as supabase_storage_admin or supabase_admin, which is a decision
--    about Supabase-managed plumbing rather than about this app's schema.
--
--    AND IT WOULD BE THE WRONG THING TO DO ANYWAY, which is the more important
--    half. Unlike realtime and supabase_functions, `storage` IS exposed to
--    PostgREST — PGRST_DB_SCHEMAS is `public,storage,graphql_public` — and the
--    avatars bucket is PUBLIC (storage.buckets.public = true) with a
--    PUBLIC-role SELECT policy on storage.objects:
--        avatars_public_read  {public}  SELECT  (bucket_id = 'avatars')
--    so anon's SELECT on storage.objects is deliberate and load-bearing for any
--    unauthenticated visitor who sees a member photo. The three write policies
--    (avatars_auth_insert/update/delete) are TO authenticated and key on
--    get_player_id(auth.uid()), so anon's surplus INSERT/UPDATE/DELETE grant on
--    storage.objects is held shut by RLS exactly the way 00128 found in public —
--    a redundant second copy pointing the wrong way, worth tightening one day
--    but not worth guessing at.
--
--    HOW AVATARS ARE ACTUALLY SERVED, since it decides the above: the player app
--    never reads storage through PostgREST. AvatarUpload.tsx:30 calls
--    getPublicUrl(), which builds a string client-side with no request at all,
--    and the browser then fetches /supabase/storage/v1/object/public/avatars/…
--    from storage-api. Uploads (AvatarUpload.tsx:123) go through storage-api on
--    the signed-in user's key, i.e. as `authenticated`. The exec page renders
--    players.exec_photo_url, a plain URL column. So the only anon path into
--    storage is storage-api's own per-request role switch on a public bucket.
--
-- 2. REALTIME. anon holds `arw` on realtime.messages and `r` on
--    realtime.subscription and realtime.schema_migrations, plus `U` on
--    realtime.subscription_id_seq.
--
--    THREE OF THE FOUR ARE UNREVOKABLE BY POSTGRES: subscription,
--    schema_migrations and subscription_id_seq are owned by and granted by
--    supabase_admin, and pg_has_role('postgres','supabase_admin', ...) is FALSE
--    under both the USAGE and MEMBER predicates. The fourth, realtime.messages,
--    IS owned by supabase_realtime_admin, in which postgres holds INHERITED
--    membership (pg_has_role(...,'USAGE') = true, which is the predicate REVOKE
--    uses) — so that one could be revoked.
--
--    IT IS NOT, ON PURPOSE. realtime.messages is the table the Realtime server
--    uses for its own channel authorization, and the logged-out /leaderboard
--    opens a channel (leaderboard-client.tsx:228, postgres_changes on
--    public.ratings) on every anonymous visit. The Realtime container connects
--    as supabase_admin and switches role per subscriber to evaluate visibility,
--    which is precisely the shape where an anon grant can turn out to be
--    load-bearing in a way no static read of the app will show. Nineteen days
--    of pg_stat_statements attribute nothing in `realtime` to the anon role,
--    but pg_stat_statements is keyed on the role a statement RAN as and the
--    authorization probe may run as supabase_admin, so that is absence of
--    evidence rather than evidence of absence. Breaking the public leaderboard
--    is worse than leaving a grant that PostgREST cannot address — `realtime`
--    is not in PGRST_DB_SCHEMAS, so nothing anon sends can reach these tables
--    over the API. Left, deliberately, on an explicit "cannot establish the
--    need either way".
--
-- 3. THE postgres-OWNED DEFAULT PRIVILEGES IN storage AND supabase_functions.
--    pg_default_acl carries postgres-owned entries for both schemas
--    (`postgres | storage | r | {…anon=arwdDxtm/postgres…}` and the same shape
--    for supabase_functions), and postgres CAN alter its own entries. They are
--    not touched: they govern only objects postgres itself creates in those
--    schemas, there are none and no migration in this directory creates one, so
--    the change would have no observable effect today and its only
--    justification would be a hypothetical future file. Recorded rather than
--    written.
--
-- 4. `authenticated` IN supabase_functions. It holds the same dead arwdDxtm
--    that section E took from anon, and the same three proofs of deadness
--    apply. It is left because this file's subject is the browser's anonymous
--    key and no evidence was gathered about signed-in paths. One line whenever
--    somebody wants it:
--      REVOKE ALL PRIVILEGES ON TABLE supabase_functions.hooks, supabase_functions.migrations
--        FROM PUBLIC, authenticated;
--
-- 5. anon INSIDE A postgres-OWNED SECURITY DEFINER FUNCTION STILL BYPASSES THIS
--    GUARD, and that is unchanged rather than introduced. Measured in the
--    container: an anon caller invoking a postgres-owned SECURITY DEFINER
--    function that writes a guarded column gets current_user = 'postgres' and
--    auth.uid() = NULL inside the trigger, so branch 1 admits it — ALLOWED
--    before this file and ALLOWED after. It is not closed here for two reasons.
--    First, closing it needs `current_setting('role', true)` rather than
--    current_user, since that GUC survives the SECURITY DEFINER switch, and
--    00129:74-76 rejected that on purpose: it is a GUC that happens to track
--    the role rather than the role itself. Second, it is already closed one
--    layer up — 00126 took anon's EXECUTE on every postgres-owned SECURITY
--    DEFINER function in public that writes players (create_player_with_rating,
--    merge_players, apply_skill_tier_seed, assign_member_code are all
--    anon=false on staging), so there is no function for anon to route through.
--    The rule for the next author is 00129:372's: a SECURITY DEFINER routine
--    that writes a guarded column has to make the authorization decision
--    itself, exactly as updatePlayer does.
--
-- 6. STAGING IS LOOSER THAN PRODUCTION IN MORE PLACES THAN SECTION C.
--    Comparing has_function_privilege for anon and authenticated over all of
--    `public` on both databases turned up one drift in the other direction too:
--    check_session_caps(uuid,uuid,text) is EXECUTE-able by `authenticated` on
--    production and NOT on staging. That is staging being tighter, so it is not
--    a hole — but it means the two databases disagree about a function an RLS
--    policy calls (00126:79 lists session_checkin_open, not this one), and
--    somebody should establish which state is correct before the next release.
--    Not touched here: this file closes anon reach and that is a different
--    question about a different role.
--
-- 7. WHAT anon CAN STILL REACH, AFTER THIS FILE. Stated so the next audit has a
--    baseline rather than a starting point:
--      * USAGE on schemas public, auth, extensions, graphql, graphql_public,
--        net, realtime, storage, supabase_functions (Supabase boilerplate).
--      * EXECUTE on 43 functions in public: the three the logged-out site
--        genuinely calls (get_leaderboard, get_active_season, get_executives),
--        the four an RLS policy evaluates for it (is_admin, is_admin_or_coach,
--        get_player_id, session_checkin_open — 00126:63-77 explains why taking
--        these would turn an empty result into a 42501), the nine trigger
--        functions that cannot be called over PostgREST at all, and the rest
--        pure/immutable arithmetic helpers (format_target, points_cap, …) that
--        read nothing.
--      * SELECT on public.ratings, and nothing else in public. Asserted above.
--      * The storage and realtime grants in items 1 and 2.
-- ============================================================
