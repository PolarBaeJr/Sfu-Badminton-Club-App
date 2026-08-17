-- ============================================================
-- 00140 — a banned admin is not an admin
-- ============================================================
-- DEPENDENCY, STATED FIRST BECAUSE IT DECIDES THE APPLY ORDER:
--
--   APPLY 00140 BEFORE 00132, OR IN THE SAME SITTING. NEVER 00132 ALONE.
--
-- 00132 (`ensure_player_for_user`) moves the roster claim from the END of
-- onboarding to the FIRST SIGN-IN. A pre-added roster row therefore acquires a
-- user_id while its owner has given no name and signed no waiver. 00132 handles
-- the console side by gating `admin_access_level` on onboarding_completed, so
-- such an account gets no console level — but it leaves `is_admin` untouched,
-- and `is_admin` is what 45 RLS policies evaluate. Applying 00132 to production
-- on its own therefore OPENS a window in which a just-claimed, not-yet-
-- onboarded admin row returns TRUE from is_admin and NULL from
-- admin_access_level: no console, full data access. This file is what closes
-- it. See §3.
--
-- ============================================================
-- WHAT IS BROKEN
-- ============================================================
-- `is_admin(uuid)` has, since 00003, been:
--
--     RETURN EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND role = 'admin');
--
-- It gates on NONE of banned, suspended, or deactivated. A BANNED ADMIN PASSES
-- EVERY POLICY THAT REFERENCES IT. Fixed nowhere; 00138 §B measured the blast
-- radius and deliberately left it, and this is the file that acts on it.
--
-- "inactive" in the bug report means `active_flag = FALSE`. There is no
-- `inactive` label in the player_status enum (it is competitive / recreational /
-- pending_approval / suspended) — a reader who goes hunting for one will not
-- find it. See the note at 00092's validate_challenge_creation, which carries a
-- dead 'inactive' string for the same reason.
--
-- ============================================================
-- §1. THE BLAST RADIUS IS 48 POLICIES, BUT IT IS NOT ONE FUNCTION
-- ============================================================
-- 48 policies reference `is_admin` — confirmed on BOTH databases, 2026-08-17.
-- The count is right and the attribution is not, because it comes from a
-- LIKE '%is_admin%' match, and `is_admin_or_coach` contains that substring. The
-- true split, measured with LIKE '%is_admin(%' vs LIKE '%is_admin_or_coach(%':
--
--     is_admin(uuid)           45 policies
--     is_admin_or_coach(uuid)   3 policies   varsity_notes vn_select / vn_insert / vn_update
--     -------------------------------------
--                              48
--
-- `is_admin_or_coach` is a SEPARATE FUNCTION CARRYING THE IDENTICAL UNGUARDED
-- BODY (its own comment records that 'coach_executive' was removed from the
-- role enum and the function collapsed to the same `role = 'admin'` test). A
-- fix to `is_admin` alone would leave a banned admin with full read AND write
-- access to varsity_notes — private coaching notes on named members, which is
-- close to the most sensitive table in the schema. BOTH FUNCTIONS ARE FIXED
-- HERE, with the same predicate, and 00126 already treats them as a pair.
--
-- ============================================================
-- §2. NO LEGITIMATE CALLER DEPENDS ON A BANNED ADMIN PASSING
-- ============================================================
-- All 48 were enumerated and their quals read. They fall into four groups, and
-- the four counts are given because they have to add up to 48 for the
-- enumeration to be worth anything: 28 + 6 + 1 + 13.
--
--   (a) 28 policies named `*_admin` whose qual is the helper alone, covering
--       ALL on announcements, challenges, challenge_participants,
--       club_expenses, club_fees, disputes, event_feedback, head_to_head_stats,
--       legacy_tournament_participants, match_games, match_participants,
--       matches, notifications, other_income, partnership_stats,
--       platform_settings, players, ratings, reliability_metrics,
--       season_final_ratings, season_snapshots, seasons, session_attendance,
--       sessions, tournament_fee_tiers, tournaments, varsity_notes (DELETE),
--       walkovers. Denying a banned admin is the entire point.
--
--   (b) 6 MORE that are admin-only, they just are not named `*_admin`:
--         audit_logs.audit_select        is_admin alone
--         audit_logs.audit_insert        is_admin alone (WITH CHECK)
--         tournament_audit_log
--           "Admin read tournament_audit_log"   is_admin alone
--         varsity_notes.vn_select        is_admin_or_coach alone
--         varsity_notes.vn_insert        is_admin_or_coach alone (WITH CHECK)
--         varsity_notes.vn_update        is_admin_or_coach alone (USING + CHECK)
--       THE THREE varsity_notes POLICIES HAVE NO `OR` BRANCH AT ALL — private
--       coaching notes are admin-only, full stop, which is exactly why §1's
--       point about fixing both functions matters. Losing the audit trail and
--       the coaching notes is the desired outcome for a banned admin, not a
--       regression.
--
--   (c) 1 where the other branch is not the caller's own row but a public one:
--         announcements_select   status = 'published' OR is_admin
--       A banned admin still reads published announcements and loses drafts.
--
--   (d) 13 where the helper is ONE BRANCH OF AN `OR` and the other branch is
--       the caller's OWN ROW:
--         players_select        status <> 'pending_approval' OR user_id = auth.uid() OR is_admin
--         push_sub_select       player_id = get_player_id(auth.uid()) OR is_admin
--         wa_select / ewa_select / rm_select_own / event_feedback_select   same shape
--         disputes_select       opened_by = mine OR is_admin OR I am in the match
--         walkovers_select      reported_by = mine OR forfeit_player_id = mine OR is_admin
--         matches_insert / matches_update / mg_insert / mp_insert / cp_insert
--                               submitted_by (or player_id) = mine OR is_admin
--       A BANNED ADMIN LOSES NOTHING THEY NEED HERE. Their own row, their own
--       waivers, their own reliability metrics, their own notifications all
--       still resolve through the self branch. What they lose is other members'
--       pending rows and other members' data — correct.
--
-- NON-POLICY CALLERS also change behaviour, all in the safe direction. THREE ON
-- STAGING, TWO ON PRODUCTION — guard_competition_category_lock exists only on
-- staging (00129 is not on prod yet), which is the same prod/staging drift §3
-- is about:
--
--   guard_player_privileged_columns()  `IF auth.uid() IS NULL OR is_admin(auth.uid())
--       THEN RETURN NEW`. A banned admin now falls through to the strict branch
--       and can no longer edit role / is_banned / is_exec / permission_* on any
--       row, including their own. THIS IS THE ONE WAY THIS FIX COULD BRICK
--       ITSELF — a banned admin unbanning themselves is exactly what we are
--       stopping, so recovery must not depend on it. IT DOES NOT: the console's
--       unban runs through the service-role client, for which auth.uid() IS
--       NULL, and that arm short-circuits before is_admin is ever called. The
--       recovery path is untouched.
--
--   apply_match_result()  two `NOT is_admin(auth.uid())` guards: force-confirming
--       a match you are not part of, and confirming your own submission. A
--       banned admin loses both bypasses. Correct.
--
--   guard_competition_category_lock()  (STAGING ONLY, 00129) is_admin is one of
--       three OR'd escape hatches from "gender is set once"; the other two are
--       current_user = 'service_role' and "not a browser key". A banned admin
--       loses their own hatch and the console keeps both of its. Correct, and
--       for the same reason as the guard above: recovery runs as service_role.
--
-- ============================================================
-- §3. THE ONBOARDING PREDICATE, AND THE PROD/STAGING ASYMMETRY
-- ============================================================
-- `admin_access_level` IS ONBOARDING-GATED ON STAGING AND NOT ON PRODUCTION —
-- staging has had 00132 applied and production has not. Both live bodies were
-- read before a line of this file was written, precisely because the two
-- databases are known to diverge.
--
-- `is_admin`, by contrast, is BYTE-IDENTICAL on the two databases, so one
-- replacement text serves both. That is why this file patches is_admin and
-- is_admin_or_coach and DOES NOT TOUCH admin_access_level: replacing a function
-- whose bodies differ, from a literal, would silently revert whichever database
-- is ahead. 00132 owns admin_access_level.
--
-- The new predicate MIRRORS admin_access_level's standing gate verbatim,
-- INCLUDING onboarding_completed, so the two are textually comparable and a
-- reviewer can diff them by eye. Including onboarding is what closes the 00132
-- window named in the header — and it is A MEASURED NO-OP TODAY:
--
--     production   5 privileged rows (2 admin, 3 exec/trainer); every one has
--                  onboarding_completed = TRUE, is_banned = FALSE,
--                  active_flag = TRUE, status recreational/competitive
--     staging      the same, 2 admin + 3 exec
--
-- and pre-00132 production CANNOT produce a counterexample, because before
-- 00132 a player row only acquired a user_id at the END of onboarding, which is
-- also where onboarding_completed was set. So there is no live account that
-- this predicate newly denies. It becomes load-bearing at the moment 00132
-- lands — which is the whole point.
--
-- ORDERING CONSEQUENCE, STATED PLAINLY. Applying 00140 first leaves production
-- with is_admin STRICTER than admin_access_level for one predicate: an admin
-- with onboarding_completed = FALSE would be offered a console level and
-- refused by RLS. No such row exists (measured above) and none can be created
-- until 00132 lands, so the window is empty. Applying 00132 first leaves the
-- reverse and the window is NOT empty. Hence the order in the header.
--
-- DOES THIS CLOSE THE 00132 CASE? YES, twice over. 00132's stub row is created
-- with status = 'pending_approval', which the status clause already refuses;
-- and a CLAIMED roster row that keeps role = 'admin' through
-- claim_privilege_attribution carries onboarding_completed = FALSE, which the
-- onboarding clause refuses. Both halves of the gap are shut.
--
-- ============================================================
-- §4. MECHANICS
-- ============================================================
-- CREATE OR REPLACE, NEVER DROP + CREATE. Replace preserves the ACL; a drop
-- would discard the `authenticated` and `anon` EXECUTE grants that 45 policies
-- and 00126's assertion block depend on, and the policies would start failing
-- for everyone. The signature is unchanged for the same reason — 00126 asserts
-- `public.is_admin(uuid)` and `public.is_admin_or_coach(uuid)` by exact
-- signature. §5 re-asserts both grants after the replace so a future edit that
-- reaches for DROP is caught here rather than in production.
--
-- Idempotent by construction: CREATE OR REPLACE of a fixed body.

BEGIN;

-- ---- 1. is_admin ---------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The standing gate and the role test in ONE EXISTS, so the function stays a
  -- single indexed lookup on idx_players_user_id. This is evaluated per row by
  -- 45 RLS policies on a live database; delegating to admin_access_level()
  -- would have kept one copy of the predicate but turned each of those into up
  -- to four sequential EXISTS, which is not a trade worth making here. The
  -- price is that this predicate and admin_access_level's must be kept in step
  -- BY HAND — they are written identically so the diff is trivial.
  RETURN EXISTS (
    SELECT 1 FROM players
     WHERE user_id = p_user_id
       AND role = 'admin'
       AND COALESCE(is_banned, FALSE) = FALSE
       AND status NOT IN ('suspended', 'pending_approval')
       AND COALESCE(active_flag, TRUE) = TRUE
       -- 00132: an unfinished account holds no privilege. A claimed roster row
       -- can now be linked to a login before its owner has given a name or
       -- signed a waiver, and admin-level data access must not arrive first.
       AND COALESCE(onboarding_completed, FALSE) = TRUE
  );
END;
$function$;

-- ---- 2. is_admin_or_coach ------------------------------------
-- The same defect in a second function; see §1. Kept a separate function rather
-- than rewritten to call is_admin, because 00126's grant assertions name it by
-- signature and the varsity_notes policies reference it directly — the point
-- here is to close the hole, not to reorganise the helpers.
CREATE OR REPLACE FUNCTION public.is_admin_or_coach(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- user_role was simplified to player/admin; 'coach_executive' no longer
  -- exists (the old IN ('admin','coach_executive') literal errored at runtime
  -- post-simplification). Body kept identical to is_admin so the two cannot
  -- drift — the three varsity_notes policies are the reason this matters.
  RETURN EXISTS (
    SELECT 1 FROM players
     WHERE user_id = p_user_id
       AND role = 'admin'
       AND COALESCE(is_banned, FALSE) = FALSE
       AND status NOT IN ('suspended', 'pending_approval')
       AND COALESCE(active_flag, TRUE) = TRUE
       AND COALESCE(onboarding_completed, FALSE) = TRUE
  );
END;
$function$;

COMMENT ON FUNCTION public.is_admin(uuid) IS
  'TRUE only for an admin IN GOOD STANDING: not banned, not suspended, not '
  'pending_approval, active_flag TRUE, onboarding complete (00140). Before '
  '00140 it tested role = ''admin'' alone, so a banned admin passed all 45 RLS '
  'policies that call it. The predicate is a verbatim copy of '
  'admin_access_level()''s standing gate and MUST BE KEPT IN STEP WITH IT.';

COMMENT ON FUNCTION public.is_admin_or_coach(uuid) IS
  'Identical predicate to is_admin (00140). Gates varsity_notes vn_select / '
  'vn_insert / vn_update — private coaching notes — which is why fixing '
  'is_admin alone would not have been a fix.';

-- ---- 3. assert the grants survived ---------------------------
-- CREATE OR REPLACE preserves the ACL. This block exists so that if anyone ever
-- turns these into DROP + CREATE, the migration fails here instead of taking
-- every admin policy down in production.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.is_admin(uuid)',
    'public.is_admin_or_coach(uuid)'
  ]) AS sig
  WHERE NOT has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00140: lost the authenticated EXECUTE grant on: %', v_bad;
  END IF;

  -- 00126 left both readable by anon as well, because RLS evaluates them for
  -- anon-role requests. Asserted for the same reason as above.
  SELECT string_agg(sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.is_admin(uuid)',
    'public.is_admin_or_coach(uuid)'
  ]) AS sig
  WHERE NOT has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00140: lost the anon EXECUTE grant on: %', v_bad;
  END IF;
END $$;

-- ---- 4. assert the policies still resolve --------------------
-- Replacing a function that 48 policies depend on is the kind of change that
-- can leave a dangling reference if the signature drifts. 48 is the number
-- measured on both databases on 2026-08-17; if a sibling branch adds or removes
-- one, this fires and the number here gets updated deliberately rather than the
-- check being silently wrong.
DO $$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%is_admin%';
  IF v_n <> 48 THEN
    RAISE WARNING '00140: expected 48 policies referencing is_admin/is_admin_or_coach, found % — check that the split is still 45/3', v_n;
  END IF;
END $$;

COMMIT;

-- ============================================================
-- VERIFICATION (2026-08-17)
-- ============================================================
-- Run in a disposable supabase/postgres:17.6.1.136 container, loaded from
-- read-only `pg_dump --schema-only` of production and of staging, separately.
-- Nothing was written to either live database.
--
--   pre-state   is_admin body byte-identical on both databases and carrying no
--               standing gate; admin_access_level differing between them
--               (onboarding clause present on staging only) — confirming why
--               this file does not rewrite it
--   FAILURE     seed an admin, UPDATE players SET is_banned = TRUE,
--               SELECT is_admin(user_id)          -> TRUE     (the bug)
--               SELECT is_admin_or_coach(user_id) -> TRUE
--   after       both -> FALSE, and likewise for status = 'suspended',
--               status = 'pending_approval', active_flag = FALSE and
--               onboarding_completed = FALSE, one at a time
--   unaffected  a healthy admin -> TRUE; a non-admin -> FALSE
--   grants      has_function_privilege('authenticated'|'anon', ..., 'EXECUTE')
--               TRUE before and after — the DROP-vs-REPLACE trap
--   policies    48 before, 48 after, split 45/3
--   re-apply    running the file a second time is a no-op and every block passes
