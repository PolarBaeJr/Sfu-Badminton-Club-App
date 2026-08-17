-- ============================================================
-- 00138 — four database-level loose ends: one fixed, one hardened,
--         two documented and deliberately left alone
-- ============================================================
-- FOUR ITEMS WERE HANDED OVER AS DEFECTS. Measured against both live databases
-- on 2026-08-17, TWO OF THEM WERE NOT DEFECTS, and saying so is the point of
-- this file as much as the two statements that change anything:
--
--   1. merge_players() marks a member onboarded who signed nothing.  TRUE.
--      FIXED here, in one line, derived from the LIVE body rather than written
--      out — because the two databases do not hold the same body (§0).
--
--   2. is_admin() is not gated on onboarding_completed.              TRUE, and
--      REACHABLE ON STAGING. DELIBERATELY NOT CHANGED. §B gives the mechanism,
--      the blast radius (48 policies, measured), the severity argument, and the
--      deploy-order consequence somebody has to decide on. A COMMENT goes into
--      the database so the next audit finds the asymmetry without re-deriving
--      it.
--
--   3. ratings.singles_k_factor / doubles_k_factor are "read by nothing".
--      FALSE. The player app RENDERS both, at
--      apps/player/src/app/leaderboard/[playerId]/page.tsx:145 and :152.
--      NOT DROPPED — dropping them breaks that page and the type-check. What is
--      true is worse than dead: the number on screen is WRONG. §C.
--
--   4a. tournament_matches.disputed is written by nothing.           There is no
--       such COLUMN — it is a value of the `status` CHECK, and 00136 already
--       traced it, documented it in COMMENT ON COLUMN, and explained why it
--       stays. NOTHING TO DO. §D.
--
--   4b. tournament_audit_log can be rewritten by the role every server action
--       runs as.                                                    TRUE, and it
--       matters far more than "an audit log", because that table is also a
--       CORRECTNESS LEDGER (§E). HARDENED here. Two sub-claims that came with
--       it are false and are corrected in place: it IS read, and 00072's
--       TRUNCATE sweep missing it had no effect.
--
-- NO COLUMN IS ADDED. NO FUNCTION IS CREATED. NO SIGNATURE CHANGES.
-- Therefore NO `NOTIFY pgrst, 'reload schema'` — and that is a decision, not an
-- omission, on the same grounds 00096:86, 00100:80 and 00130:151/198 state and
-- 00136 had to spend a whole section on: PostgREST caches function SIGNATURES
-- and column LISTS, and this file changes neither. merge_players keeps its exact
-- `(uuid, uuid, uuid) RETURNS jsonb` signature; the rest is grants, one policy
-- pair, and comments. Adding a NOTIFY would be harmless and would also be a
-- claim that something in the cache went stale, which nothing here did.
--
-- IDEMPOTENT THROUGHOUT. Every statement is either naturally repeatable
-- (REVOKE, GRANT, COMMENT, CREATE OR REPLACE) or guarded (DROP POLICY IF
-- EXISTS; the §0 rewrite detects its own finished state and returns). The
-- assertion block at the foot re-derives every claim from the catalogue rather
-- than trusting that a statement took.
--
-- DEPLOY ORDER: FREE, in both directions, for every statement. Argued per
-- section rather than asserted once — see §0, §E and the summary at the foot.
--
-- ------------------------------------------------------------
-- DRIFT MEASURED BETWEEN THE TWO DATABASES, 2026-08-17
-- ------------------------------------------------------------
--   production  ssh pi 'docker exec -i supabase-db         psql -U postgres -d postgres'
--   staging     ssh pi 'docker exec -i supabase-staging-db psql -U postgres -d postgres'
--
-- Both are PostgreSQL 17.6. Neither has a schema_migrations table — migrations
-- here are applied BY HAND — so "which migrations are on it" is inferred from
-- the objects each one creates:
--
--   * PRODUCTION HAS NEITHER `recompute_player_stats` (00123) NOR
--     `ensure_player_for_user` (00132) NOR `set_match_ready` (00135). Staging
--     has all three. Production therefore still carries roughly 00121 and
--     earlier, as 00131 already recorded.
--   * `admin_access_level` IS gated on onboarding_completed on staging (00132's
--     line, comment and all) and IS NOT on production.
--   * `merge_players` DIFFERS BETWEEN THEM. Staging's body carries 00123's
--     `recompute_player_stats(p_keep)` call, a `v_recomputed` variable and an
--     extra key in the returned jsonb; production's does not. See §0 — this is
--     the single fact that decided how §0 is written.
--   * tournament_audit_log: production carries `anon=arwdm`, staging does not
--     (00128/00131 cleaned it there). Neither carries `D` (TRUNCATE) for
--     anon or authenticated — see §E.
--   * tournament_matches has a `tournament_matches_court_len` CHECK on staging
--     (00135, NOT VALID) and none on production. Both already admit 'ready',
--     'live' and 'disputed' in the status CHECK — that list is from 00001.
--   * Row counts, for scale: players 7 on production / 100 on staging;
--     tournament_audit_log 0 usable on production / 595 rows and 27 distinct
--     action values on staging.
--
-- EVERY STATEMENT IN THIS FILE IS SAFE ON BOTH, and that was tested rather than
-- reasoned about: the container suite at the foot builds PRODUCTION's pre-state
-- (ungated is_admin, `anon=arwdm`, the single FOR ALL policy, production's
-- merge_players body) and then re-runs the whole thing against STAGING's
-- pre-state (gated admin_access_level, no anon, staging's merge_players body).
--
-- ============================================================
-- §0 — merge_players(): the line is patched IN THE LIVE BODY,
--      not replaced from a copy
-- ============================================================
-- THE BUG. The last thing merge_players does before auditing is adopt the
-- removed row's login when the survivor has none:
--
--     IF v_keep.user_id IS NULL AND v_remove.user_id IS NOT NULL THEN
--       UPDATE players
--          SET user_id = v_remove.user_id,
--              onboarding_completed = TRUE          <-- THIS
--        WHERE id = p_keep;
--
-- `onboarding_completed = TRUE` was CORRECT when it was written. Before 00132 a
-- `players` row only ever came into existence at the END of onboarding, from
-- completeOnboarding — so any row that had a login had, by construction,
-- finished onboarding, and a login arriving on the survivor really did mean
-- somebody had completed it.
--
-- 00132 ended that. It creates a STUB at first sign-in: a real person who has
-- proved an email address and given nothing else — no name, no waiver, no skill
-- tier — and it is emphatic about the one field it refuses to touch:
--
--     "onboarding_completed is NOT touched. The claim now happens at SIGN-IN,
--      and this person has given no name and signed no waiver — buildRosterClaim
--      used to set it TRUE because it ran at the END of onboarding, when it was
--      true. Setting it here would walk the member straight past the gate."
--                              — ensure_player_for_user, live on staging
--
-- merge_players then does exactly what that paragraph forbids. Merge a stub into
-- a pre-added roster row — which is the SINGLE MOST LIKELY MERGE there is, now
-- that a stub is created for anybody who signs up before an exec adds them —
-- and the survivor comes out flagged as having completed onboarding. Nobody
-- gave a name. Nobody accepted a waiver. The onboarding gate is satisfied and
-- only the separate waiver gate is left standing, on a member the club now
-- believes is fully set up.
--
-- Not reachable on production TODAY (00132 is not applied there, and all 7 rows
-- have onboarding_completed = TRUE, so there is no stub to merge). Reachable on
-- staging now, and reachable on production the moment 00132 lands.
--
-- THE FIX: OR, NOT FALSE, and not a literal either way.
--
--     onboarding_completed = (COALESCE(v_keep.onboarding_completed, FALSE)
--                             OR COALESCE(v_remove.onboarding_completed, FALSE))
--
-- OR rather than dropping the assignment, because dropping it changes nothing
-- (the column keeps the survivor's value) and says nothing, whereas OR states
-- the rule: A MERGE MAY NEVER MANUFACTURE A COMPLETION AND MAY NEVER ERASE ONE.
-- That is the same rule the function already applies, in its own words, to
-- walkover_flag one screen earlier — "walkover_flag is OR: merging must not be
-- a way to clear a flag." A completion is the mirror image: merging must not be
-- a way to invent one. Using the same operator for both is deliberate.
--
-- The branch only runs when v_keep.user_id IS NULL, so the survivor is a roster
-- row with no login and is USUALLY onboarding_completed = FALSE — but "usually"
-- is exactly the assumption that makes a literal wrong, and a survivor that
-- somehow already holds TRUE must not be demoted by a merge.
--
-- ------------------------------------------------------------
-- WHY THIS IS A regexp_replace ON pg_get_functiondef AND NOT A
-- CREATE OR REPLACE WITH THE BODY WRITTEN OUT
-- ------------------------------------------------------------
-- This is the unusual thing in this file and it is the measurement that forced
-- it. 00072's header lays down the house rule for this function class:
--
--     "THE BODY BELOW IS THE LIVE FUNCTION, COPIED VERBATIM, WITH ONE LINE
--      ADDED. CREATE OR REPLACE takes the whole body, so any column omitted
--      here loses its protection silently. ... Always dump the live definition
--      and add to it; never rebuild it from memory."
--
-- The live definition was dumped. THERE ARE TWO OF THEM.
--
--   pg_get_functiondef on production  -> 197 lines
--   pg_get_functiondef on staging     -> 209 lines
--
-- and the difference is not cosmetic. Staging carries 00123's work: a
-- `v_recomputed INTEGER := 0` declaration, a ten-line block after the DELETE
-- that calls `public.recompute_player_stats(p_keep)` and folds the count into
-- `rows_retained`, and an extra `stats_pairs_recomputed` key on the returned
-- jsonb. `recompute_player_stats` DOES NOT EXIST ON PRODUCTION.
--
-- So a single CREATE OR REPLACE carrying a literal body cannot be right:
--
--   * Built from PRODUCTION's text, applying it to staging SILENTLY REVERTS
--     00123 — the survivor's head-to-head counters stop being re-derived after
--     a merge, with no error and no symptom until somebody reads a stale row.
--     This is precisely the "any column omitted here loses its protection
--     silently" failure 00072 warns about, one function along.
--   * Built from STAGING's text, applying it to production installs a body that
--     calls a function that is not there. plpgsql resolves callees at RUN time,
--     so it would not fail now — it would fail on the first merge somebody
--     actually runs, in the middle of a merge, after the DELETE.
--   * Two branches, one per database, is not a migration. Hand-applied files in
--     this directory get run on both.
--
-- The one-line patch is therefore applied TO WHATEVER BODY IS LIVE. Everything
-- else about the function — every guard, every repoint, every GET DIAGNOSTICS,
-- the owner, SECURITY DEFINER, `SET search_path`, and the ACL (CREATE OR REPLACE
-- on an EXISTING function does not re-mint grants; only a fresh CREATE does) —
-- is carried through unaltered by construction rather than by careful copying,
-- which is the only way to be right on both databases at once.
--
-- The substitution is made SAFE by counting: the target text occurs EXACTLY
-- ONCE in each live body (verified on both, 2026-08-17 — `grep -c` = 1), the
-- block refuses to proceed on any other count, and it re-reads the definition
-- afterwards to prove the new expression is in and the old literal is out.
--
-- IDEMPOTENT: a second run finds zero occurrences of the old literal and one of
-- the new expression, and returns without touching anything.
--
-- DEPLOY ORDER: FREE. The signature is unchanged, so no cache reload is needed
-- and no build names anything new. Applying it before the code changes nothing
-- for the code (no app change accompanies this section); applying it after
-- leaves the old behaviour in place for exactly as long as it takes to run.

-- ============================================================
-- ONE TRANSACTION, on 00122/00126/00131's pattern
-- ============================================================
-- The assertion block at the foot is only worth having if a failure UNDOES the
-- statements above it. DDL, COMMENT, GRANT, REVOKE and CREATE POLICY are all
-- transactional in PostgreSQL, so wrapping the file makes it genuinely
-- all-or-nothing rather than nearly so — and this file has two independent
-- subjects, so a half-applied state would be a patched merge_players with an
-- unhardened ledger, or the reverse, with nothing on disk saying which.
BEGIN;

DO $merge_fix$
DECLARE
  v_def     text;
  v_old     text := 'onboarding_completed = TRUE';
  v_new     text := 'onboarding_completed = (COALESCE(v_keep.onboarding_completed, FALSE)' || E'\n'
                 || '                                   OR COALESCE(v_remove.onboarding_completed, FALSE))';
  v_hits    integer;
  v_newdef  text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'merge_players'
     AND p.pronargs = 3;

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      '00138 §0: public.merge_players(uuid,uuid,uuid) is not present. 00026/00079 must be applied first.';
  END IF;

  -- Already patched (a re-run, or somebody got there first). Nothing to do.
  IF position('COALESCE(v_remove.onboarding_completed' in v_def) > 0 THEN
    RAISE NOTICE '00138 §0: merge_players already carries the OR form; leaving it alone.';
    RETURN;
  END IF;

  -- Count before replacing. A body that grew a second `onboarding_completed =
  -- TRUE` somewhere else must be looked at by a person, not patched blind.
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '00138 §0: expected exactly 1 occurrence of "%" in the live merge_players body, found %. Refusing to patch — dump pg_get_functiondef and do it by hand.',
      v_old, v_hits;
  END IF;

  v_newdef := replace(v_def, v_old, v_new);
  EXECUTE v_newdef;

  -- Prove the replacement landed in the LIVE body, not just in the local string.
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_players' AND p.pronargs = 3;

  IF position('COALESCE(v_remove.onboarding_completed' in v_def) = 0 THEN
    RAISE EXCEPTION '00138 §0: the rewrite did not take — the OR form is not in the live body';
  END IF;
  IF position(v_old in v_def) > 0 THEN
    RAISE EXCEPTION '00138 §0: the old `onboarding_completed = TRUE` literal survived the rewrite';
  END IF;

  -- The rewrite must not have lost anything else. These are the load-bearing
  -- lines of the function; if replace() somehow mangled the body, one of these
  -- is what notices. Mirrors 00131's FOREACH check over the guard's columns.
  IF v_def !~ 'Cannot merge a player into themselves'
     OR v_def !~ 'merge_players_unhandled'
     OR v_def !~ 'merge_players_preview'
     OR v_def !~ 'Both accounts have a login'
     OR v_def !~ 'waiver_acceptances'
     OR v_def !~ 'passkey_credentials'
     OR v_def !~ 'walkover_flag'
     OR v_def !~ 'DELETE FROM players WHERE id = p_remove'
     OR v_def !~ 'players_merged' THEN
    RAISE EXCEPTION '00138 §0: a load-bearing line of merge_players is missing after the rewrite';
  END IF;

  RAISE NOTICE '00138 §0: merge_players patched — a merge no longer manufactures an onboarding completion.';
END
$merge_fix$;

COMMENT ON FUNCTION public.merge_players(uuid, uuid, uuid) IS
  'Merges a duplicate player into a survivor. The SURVIVOR''s own fields always win; only the login link is adopted. onboarding_completed is OR-ed rather than set (00138): a merge may neither manufacture a completion nor erase one — before 00138 it was set to TRUE unconditionally, which was correct while a players row only existed after onboarding and became a way to walk a 00132 stub straight past the gate. Do not CREATE OR REPLACE this from a migration file: the live bodies on staging and production DIFFER (staging carries 00123''s recompute_player_stats call, production has no such function), so a literal body reverts one database or breaks the other. Dump pg_get_functiondef and patch that.';

-- ============================================================
-- §B — is_admin(): the gap is real, is reachable, and is NOT
--      closed here. Only documented.
-- ============================================================
-- THE ASYMMETRY. 00132 added a standing line to admin_access_level:
--
--     AND COALESCE(onboarding_completed, FALSE) = TRUE
--     -- 00132: an unfinished account holds no console level.
--
-- is_admin() got nothing. Its whole body, live on both databases, is:
--
--     RETURN EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND role = 'admin');
--
-- so a `role = 'admin'` row that has not onboarded is refused the CONSOLE and
-- admitted by EVERY RLS POLICY THAT CALLS is_admin — which is the PostgREST
-- surface, i.e. direct read/write over players and most of the schema with
-- nothing but the browser's own anon key and a session.
--
-- IT IS REACHABLE, and this is the part the handover did not have. On staging,
-- `ensure_player_for_user` claims a pre-added roster row at FIRST SIGN-IN and
-- does not always strip what the row carries — when claim_privilege_attribution
-- can show the grant was deliberate, it KEEPS it:
--
--     IF v_role <> 'player' THEN
--       IF v_attr ? 'role' THEN v_kept := v_kept || jsonb_build_object('role', v_role);
--
-- and, per its own comment, "onboarding_completed is NOT touched". So an admin
-- deliberately pre-added through the console, signing in for the first time,
-- lands on role = 'admin' with onboarding_completed = FALSE. Not theoretical.
--
-- WHY IT IS NOT CHANGED HERE. Three reasons, in the order they matter:
--
--   1. BLAST RADIUS, MEASURED. 48 policies on production reference is_admin in
--      their USING or WITH CHECK expression:
--        SELECT count(*) FROM pg_policy p
--         WHERE pg_get_expr(p.polqual, p.polrelid) LIKE '%is_admin%'
--            OR pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%is_admin%';   -- 48
--      (The handover said 44. Either count is a lot; 48 is what the catalogue
--      says today.) is_admin is also called by
--      guard_player_privileged_columns, so narrowing it narrows the trigger's
--      admin bypass at the same time. A regression here is not "a screen looks
--      wrong" — it is an admin locked out of writing the roster, discovered on
--      a Saturday.
--
--   2. THE ACTOR IN THE HOLE IS TRUSTED. The only route into
--      admin + not-onboarded is a row an exec DELIBERATELY made an admin
--      through the console, whose grant claim_privilege_attribution can
--      evidence — anything it cannot evidence is stripped to 'player' on the
--      spot. So the window is between that person's first sign-in and their
--      finishing a form, measured in minutes, and the person inside it is one
--      the club just chose to make an admin. Compare what narrowing risks.
--
--   3. NOBODY IS IN IT. Every `role = 'admin'` row on both databases has
--      onboarding_completed = TRUE (2 on production, 2 on staging; 0 rows in
--      any role with FALSE, on either). So the change would be provably inert
--      today — which is also why the container proof the brief asks for
--      ("prove a normal admin still passes every policy path") would have to
--      construct all 48 paths from scratch to be worth anything, and 00137 is
--      in flight over admin actions around fees and players.
--
-- WHAT SOMEBODY HAS TO DECIDE, and it is a deploy-order decision:
--
--   THE HOLE OPENS ON PRODUCTION THE MOMENT 00132 IS APPLIED THERE. Today
--   production has no ensure_player_for_user and no stubs, so is_admin's missing
--   gate has nothing to bite on. 00132 is committed and unapplied. Whoever
--   applies it should either narrow is_admin in the same sitting or accept the
--   window above knowingly.
--
--   AND THERE IS A BIGGER GAP IN THE SAME FUNCTION, found while measuring this
--   one and not fixed either: admin_access_level also gates on is_banned,
--   status NOT IN ('suspended','pending_approval') and active_flag. is_admin
--   gates on NONE of them. A BANNED ADMIN STILL PASSES ALL 48 POLICIES. That is
--   a strictly worse hole than the onboarding one — a banned admin is by
--   definition not trusted, where a fresh one is — and it has been there since
--   00003. If is_admin is ever narrowed, it should be narrowed to
--   admin_access_level(p_user_id) = 'admin' in one move rather than one
--   predicate at a time, so the two functions cannot drift again.
--
-- The COMMENT below is the whole of this section's effect on the database. It is
-- there so the next person reading pg_get_functiondef sees the asymmetry without
-- re-deriving it, which is how this one was missed.

COMMENT ON FUNCTION public.is_admin(uuid) IS
  'TRUE when the user holds role = ''admin''. DELIBERATELY WEAKER THAN admin_access_level(), and the difference is not documented anywhere else: admin_access_level refuses a row that is banned, suspended, pending_approval, inactive, or (since 00132) not onboarded, and is_admin refuses none of those. 48 RLS policies call this function, so a banned or un-onboarded admin still passes every one of them while being refused the console. Measured 2026-08-17: no row on either database is in that state. Reachable on staging via ensure_player_for_user, which claims a deliberately-granted admin roster row at first sign-in and leaves onboarding_completed FALSE; reachable on production as soon as 00132 is applied there. If this is ever narrowed, narrow it to admin_access_level(p_user_id) = ''admin'' in one move — see 00138 §B — and re-verify all 48 policies, not just the console.';

-- ============================================================
-- §C — ratings.singles_k_factor / doubles_k_factor are NOT dropped
-- ============================================================
-- THE CLAIM WAS "written by every season reset and by
-- create_player_with_rating, and READ BY NOTHING." The second half is false,
-- and the house rule for a column drop — nothing may select it first — is
-- therefore not satisfied. A grep of both apps:
--
--   apps/player/src/app/leaderboard/[playerId]/page.tsx:145
--     {r.singles_provisional ? 'Provisional' : `K=${r.singles_k_factor}`} · ...
--   apps/player/src/app/leaderboard/[playerId]/page.tsx:152
--     {r.doubles_provisional ? 'Provisional' : `K=${r.doubles_k_factor}`} · ...
--
-- Both are RENDERED, on a member-facing profile. The read is `select('*')`, so
-- a DROP would not 400 the request — it would render "K=undefined" into the
-- page, silently, on every non-provisional player. And
-- packages/shared/src/types/database.ts:192-193 declares both as non-optional
-- `number`, so a drop plus a regenerate breaks type-check in the admin app too.
-- Dropping them needs the page changed and shipped FIRST; that is a UI decision,
-- not hygiene, and it is not made here.
--
-- WHAT IS TRUE IS WORSE THAN "DEAD". The claim's FIRST half holds — the rating
-- maths does not read these columns. It derives K per match from
-- platform_settings and the provisional threshold:
--
--     v_k_factor := CASE WHEN v_provisional_k AND (... < v_threshold)
--                        THEN <settings k_provisional> ELSE <settings k_settled> END
--                                     — apply_match_result, 00127:504-508
--
-- The only writers left are `create_player_with_rating` (seeds 80 / 64) and
-- `activate_season` (resets every row to 80 / 64) — confirmed by dumping every
-- function body on production that names the column, which returns exactly
-- those two and nothing else.
--
-- SO EVERY ROW HOLDS THE SEED VALUE, AND THAT WAS MEASURED:
--
--   SELECT singles_k_factor, doubles_k_factor, count(*) FROM ratings GROUP BY 1,2;
--     production   80 | 64 |   7      (1 row — no other combination exists)
--     staging      80 | 64 | 100      (1 row — no other combination exists)
--
-- 80 and 64 are the PROVISIONAL K values. The page shows them ONLY when the
-- player is NOT provisional. So the one place these columns surface prints the
-- provisional K to settled players — a number that is wrong twice over: wrong
-- because it is the provisional constant, and wrong because the real K comes
-- from platform_settings and an exec can change it there without this column
-- moving. A member reading "K=80" beside a settled rating is being told
-- something untrue.
--
-- DECISION: DOCUMENTED AS VESTIGIAL, NOT RESERVED, NOT DROPPED. "Reserved"
-- would be a lie — nothing plans to use them, and a reader who believed it
-- might wire the maths to them. The comment says what they are, who still
-- writes them, who still reads them, and what has to happen before a drop, so
-- the next person does not have to re-run this measurement. Two COMMENTs, no
-- DDL, no deploy-order constraint of any kind.
--
-- The display bug is reported to the owner rather than fixed here: the fix is
-- either "delete the chip" or "show the real K from platform_settings", and
-- that is the owner's call about what a member should see, on a page inside
-- another agent's area of the tree this week.

COMMENT ON COLUMN public.ratings.singles_k_factor IS
  'VESTIGIAL, NOT RESERVED (00138). The rating maths does NOT read this: apply_match_result derives K per match from platform_settings and the provisional threshold (00127:504). Written only by create_player_with_rating (seeds 80) and activate_season (resets to 80), so EVERY ROW ON BOTH DATABASES HOLDS 80 — measured 2026-08-17, one distinct value on each. Not dropped because it is still RENDERED, at apps/player/src/app/leaderboard/[playerId]/page.tsx:145, where it prints the PROVISIONAL constant beside a SETTLED rating and is therefore wrong on screen. Before dropping: change that page, ship it, regenerate database.gen.ts, and drop packages/shared/src/types/database.ts:192 — the page reads select(''*''), so a drop degrades to "K=undefined" rather than erroring.';

COMMENT ON COLUMN public.ratings.doubles_k_factor IS
  'VESTIGIAL, NOT RESERVED (00138). See ratings.singles_k_factor. Seeded and reset to 64, the DOUBLES PROVISIONAL constant; every row on both databases holds 64. Rendered at apps/player/src/app/leaderboard/[playerId]/page.tsx:152 for players who are NOT provisional, which is what makes it wrong rather than merely unused.';

-- ============================================================
-- §D — tournament_matches: 'disputed' needs nothing from this file
-- ============================================================
-- THERE IS NO `tournament_matches.disputed` COLUMN. The 37-column table has no
-- such field on either database. `disputed` is one of seven values admitted by
-- tournament_matches_status_check, and that CHECK is identical on production and
-- staging:
--
--     status = ANY (ARRAY['pending','ready','live','completed','walkover','disputed','voided'])
--
-- 00136 ALREADY DID THIS WORK, three days ago, and did it more thoroughly than
-- this file would: it traced every UPDATE of that column in both apps, listed
-- the five values actually produced, established that 'live' and 'disputed' were
-- produced by nothing, GAVE 'live' A WRITER (setMatchLive, behind Court
-- Management), and wrote the finding for 'disputed' into the database:
--
--     "disputed = admitted by the CHECK and still written by nothing."
--                        — COMMENT ON COLUMN tournament_matches.status, 00136
--
-- The handover's "00136 may have just added a live transition, so check the
-- current state" is exactly right, and the current state is: 'live' is fixed,
-- 'disputed' is surfaced, and NOTHING IS OUTSTANDING.
--
-- IT MUST NOT BE REMOVED FROM THE CHECK, which is the one action that might
-- look tidy. Two readers exist and both would be broken by it:
--   * apps/player/src/app/tournaments/[id]/events/[eventId]/page.tsx:53 maps
--     `disputed: 'Result disputed'` — a label whose absence 00136 discusses at
--     length for 'live'.
--   * apps/admin/src/lib/tournament-actions/scheduling.ts:238 refuses to act on
--     it by name: "'disputed' is somebody else's open question."
-- And tournament matches have no dispute FLOW at all — the `disputes` table
-- hangs off `matches` (member challenges), not off tournament_matches — so the
-- value is a placeholder for a feature, not a broken half of one. 00136 chose
-- to keep and document it; that judgement stands and is not relitigated here.
--
-- NO STATEMENT. This section is the reason there isn't one.

-- ============================================================
-- §E — tournament_audit_log: it is a LEDGER, and the role every
--      server action runs as could rewrite it
-- ============================================================
-- FIRST, TWO SUB-CLAIMS THAT CAME WITH THIS ITEM AND ARE FALSE. Correcting them
-- is not pedantry — the first changes what the fix has to preserve, and the
-- second would have had this file writing a statement that does nothing.
--
--   "25 action values written and ZERO rendered anywhere — no screen queries
--    it."  The "no screen" half is TRUE (the admin /audit page reads
--   `audit_logs`, the OTHER table, at apps/admin/src/app/audit/page.tsx:71).
--   The count is 27 distinct actions on staging today, not 25. But "read by
--   nothing" is FALSE, and this is the whole point of the section:
--
--       apps/admin/src/lib/tournament-actions/finalize.ts:67
--         adminClient.from('tournament_audit_log')
--           .select('details').eq('event_id', eventId).eq('action', BONUS_APPLIED_ACTION)
--
--   THIS TABLE IS THE IDEMPOTENCY LEDGER FOR PLACEMENT BONUSES. finalize.ts
--   says so in its own words: "applyPlacementBonuses reads a rating and writes
--   `current + bonus`, which is not idempotent: run it twice and everyone is
--   awarded twice. ... The ledger is append-only and lives in
--   `tournament_audit_log.details`". The reader refuses to proceed if it cannot
--   read the ledger, because "guessing wrong doubles every bonus on the event".
--   Staging holds 2 `placement_bonuses_applied` rows right now.
--
--   So `FOR ALL` is not a tidiness problem. A DELETE of one ledger row makes
--   the next applyPlacementBonuses run believe it is the first, and it awards
--   every bonus on the event a second time — permanently, to live ratings, with
--   no error anywhere. That is the risk this section exists to remove, and it is
--   also why SELECT and INSERT must both survive it (below).
--
--   "It was also missed by 00072's TRUNCATE revoke."  TRUE that the table is
--   not in 00072's list, and IRRELEVANT, because those roles never held
--   TRUNCATE here. The live ACL on production:
--
--       postgres=arwdDxtm/postgres
--       anon=arwdm/postgres            a,r,w,d,m  — INSERT SELECT UPDATE DELETE MAINTAIN
--       authenticated=arwdm/postgres   same
--       service_role=arwdDxtm/postgres +D (TRUNCATE) +x (REFERENCES) +t (TRIGGER)
--
--   No `D` on anon or authenticated. Supabase's ALTER DEFAULT PRIVILEGES grants
--   the browser roles four verbs, not seven; 00072's sweep on the OTHER tables
--   was removing grants those tables had for a different reason. Adding this
--   table to that list would have been a no-op that read as a fix. The TRUNCATE
--   that actually exists belongs to `service_role`, and THAT is revoked below.
--
-- ------------------------------------------------------------
-- WHAT IS ACTUALLY LOAD-BEARING HERE, and it is not the policy
-- ------------------------------------------------------------
-- The item as handed over blames RLS: `FOR ALL USING (auth.role() =
-- 'service_role')`. Narrowing that policy would, on its own, ACCOMPLISH
-- NOTHING, and the catalogue says why:
--
--     SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN (...);
--       service_role   | t
--       postgres       | t
--       authenticated  | f
--       anon           | f
--
-- service_role HAS BYPASSRLS. Every RLS policy on this table is invisible to
-- the role every server action runs as. The only thing standing between the
-- admin client and a DELETE of the bonus ledger is the TABLE GRANT — so the
-- table grant is what this section changes, and the policy split that follows
-- it is documented as defence in depth rather than as the fix.
--
-- FOUR STATEMENTS, and what each is for:
--
--   1. anon loses everything. Inert today (anon has no policy on this table, so
--      RLS refuses every row) but it is INSERT/UPDATE/DELETE on the audit trail
--      held by the key that ships in the browser bundle, and 00131's rule
--      applies verbatim: Supabase's ALTER DEFAULT PRIVILEGES creates EXPLICIT
--      `anon=.../postgres` entries, so `REVOKE ... FROM PUBLIC` alone is a
--      no-op against them, and `REVOKE ... FROM anon` alone is a no-op whenever
--      a PUBLIC entry survives (anon is a member of PUBLIC). BOTH ARE NAMED.
--      No-op on staging, where 00128/00131 already cleared it — that is the
--      drift, and a final-state statement passes on both.
--
--   2. authenticated loses INSERT, UPDATE and DELETE and KEEPS SELECT.
--      SELECT stays on purpose: the `Admin read tournament_audit_log` policy
--      gates it to is_admin(auth.uid()), it is the path a tournament audit
--      SCREEN would use, and there is one being designed (design/admin-audit-log).
--      Revoking it would pre-break that and gain nothing — the policy already
--      refuses every non-admin row. The three write verbs gain nothing either:
--      no policy admits an authenticated write, so they are grants with no
--      reachable path, which is exactly the state 00128/00131/00134 keep finding
--      and closing. Written as REVOKE ALL then GRANT SELECT, which avoids naming
--      PostgreSQL 17's MAINTAIN verb explicitly and is idempotent as a pair.
--
--   3. service_role loses UPDATE, DELETE and TRUNCATE. THE STATEMENT THAT
--      MATTERS. It keeps INSERT (logAudit, and finalize.ts's ledger write) and
--      SELECT (readBonusLedger — and note is_admin(NULL) is FALSE, so the admin
--      read policy would NOT cover the admin client even if BYPASSRLS were
--      taken away; SELECT has to be a grant). After this the ledger is
--      genuinely append-only from every application path.
--
--      NOTHING LEGITIMATE LOSES ANYTHING, and that was checked rather than
--      assumed:
--        * Every use of this table in both apps is an INSERT or a SELECT —
--          audit.ts:18, finalize.ts:67, finalize.ts:262, participants.ts:705.
--          There is no UPDATE and no DELETE anywhere in either app.
--        * merge_players DOES `UPDATE tournament_audit_log SET performed_by =
--          p_keep`. It survives because it is SECURITY DEFINER owned by
--          `postgres`, which is the table's OWNER — so the UPDATE runs with
--          postgres's grants, not the caller's. Proven in the container rather
--          than argued: the suite calls merge_players AS service_role after the
--          revokes and asserts the repoint happened.
--        * No trigger, cron job or publication touches it. It is not in
--          supabase_realtime (only `ratings` of the three tables looked at is).
--        * All four FKs are NO ACTION, so no cascade needs DELETE either — see
--          FOUND, NOT FIXED below, because that turns out to be its own bug.
--
--   4. The `FOR ALL` policy becomes `FOR INSERT` + `FOR SELECT`. NO MEASURABLE
--      EFFECT TODAY, stated plainly: service_role bypasses RLS, so the policy
--      never runs for the only role whose auth.role() could equal
--      'service_role'. It is done anyway for two reasons — it stops the policy
--      list from ASSERTING that the ledger is rewritable, which is what sent
--      this item in as an RLS problem in the first place; and if BYPASSRLS is
--      ever taken off service_role (a reasonable future hardening) the policy
--      becomes the control, and it should already say the right thing. The pair
--      is split rather than dropped precisely because dropping SELECT would
--      break placement bonuses in that future.
--
-- DEPLOY ORDER: FREE, in both directions, for all four. Grants and policies are
-- evaluated per statement by Postgres and are not in PostgREST's schema cache,
-- no column or signature changes, and no application path exercises any verb
-- being removed. Applying it before or after any build makes no difference; the
-- ledger is protected from the moment it runs.

REVOKE ALL PRIVILEGES ON TABLE public.tournament_audit_log FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.tournament_audit_log FROM anon;

REVOKE ALL PRIVILEGES ON TABLE public.tournament_audit_log FROM authenticated;
GRANT  SELECT             ON TABLE public.tournament_audit_log TO   authenticated;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.tournament_audit_log FROM service_role;

-- All three DROPs are IF EXISTS, including the two names this file itself
-- creates. The second one is not decoration: the first draft dropped only the
-- old FOR ALL policy, and the container's idempotence pass — a straight second
-- application of the whole file — died on
-- `policy "Service append tournament_audit" ... already exists`. CREATE POLICY
-- has no OR REPLACE and no IF NOT EXISTS, so drop-then-create is the only
-- repeatable form.
DROP POLICY IF EXISTS "Service write tournament_audit"  ON public.tournament_audit_log;
DROP POLICY IF EXISTS "Service append tournament_audit" ON public.tournament_audit_log;
DROP POLICY IF EXISTS "Service read tournament_audit"   ON public.tournament_audit_log;

CREATE POLICY "Service append tournament_audit" ON public.tournament_audit_log
  FOR INSERT TO public
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service read tournament_audit" ON public.tournament_audit_log
  FOR SELECT TO public
  USING (auth.role() = 'service_role');

COMMENT ON TABLE public.tournament_audit_log IS
  'APPEND-ONLY. Not only an audit trail: `details` is also the IDEMPOTENCY LEDGER for placement bonuses. applyPlacementBonuses writes `current + bonus` to live ratings, and readBonusLedger (apps/admin/src/lib/tournament-actions/finalize.ts:67) decides from the `placement_bonuses_applied` rows here whether a run is a first run — so losing or editing one row makes the next run award every bonus on the event a second time, permanently and silently. 00138 therefore revoked UPDATE, DELETE and TRUNCATE from service_role (which holds BYPASSRLS, so the RLS policies never applied to it and the table grant was the only control), took everything from anon, and left authenticated with SELECT only, gated to admins by the "Admin read tournament_audit_log" policy. Do not add an UPDATE or DELETE path. No screen renders this table yet — the admin /audit page reads the separate `audit_logs`.';

-- ============================================================
-- ASSERTIONS — every claim above re-derived from the catalogue
-- ============================================================
-- Written as FINAL-STATE checks, so the file passes identically on production
-- and on staging despite the drift catalogued in the header. Each raises rather
-- than warns: a statement that did not take aborts the whole file instead of
-- leaving a half-applied state that reads as done.
DO $assert$
DECLARE
  v_def    text;
  v_count  integer;
  v_txt    text;
BEGIN
  -- ---- §0. merge_players carries the OR form, and nothing else moved ----
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_players' AND p.pronargs = 3;

  IF v_def IS NULL THEN
    RAISE EXCEPTION '00138 assert: merge_players(uuid,uuid,uuid) is gone';
  END IF;
  IF position('onboarding_completed = TRUE' in v_def) > 0 THEN
    RAISE EXCEPTION
      '00138 assert: merge_players still sets onboarding_completed = TRUE — a merge can still manufacture a completion';
  END IF;
  IF position('COALESCE(v_keep.onboarding_completed' in v_def) = 0
     OR position('COALESCE(v_remove.onboarding_completed' in v_def) = 0 THEN
    RAISE EXCEPTION '00138 assert: merge_players does not carry the OR form on both sides';
  END IF;
  -- It must still be SECURITY DEFINER with a pinned search_path, owned by the
  -- role whose grants the tournament_audit_log repoint depends on (§E.3).
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'merge_players' AND p.pronargs = 3
     AND p.prosecdef
     AND p.proowner = 'postgres'::regrole
     AND p.proconfig @> ARRAY['search_path=public, pg_temp'];
  IF v_count <> 1 THEN
    RAISE EXCEPTION
      '00138 assert: merge_players lost SECURITY DEFINER, its pinned search_path, or its postgres ownership — the tournament_audit_log repoint depends on all three';
  END IF;
  -- The repoint the revokes in §E have to keep working must still be in there.
  IF v_def !~ 'UPDATE tournament_audit_log\s+SET performed_by' THEN
    RAISE EXCEPTION '00138 assert: merge_players no longer repoints tournament_audit_log.performed_by';
  END IF;

  -- ---- §B. is_admin is UNCHANGED, and carries the note ----
  -- Asserted deliberately: this file's position is that is_admin must NOT be
  -- narrowed here, and a later edit that quietly narrows it should collide with
  -- something rather than land unremarked.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'is_admin' AND p.pronargs = 1;
  IF v_def IS NULL THEN
    RAISE EXCEPTION '00138 assert: is_admin(uuid) is missing';
  END IF;
  IF position('onboarding_completed' in v_def) > 0 THEN
    RAISE EXCEPTION
      '00138 assert: is_admin now mentions onboarding_completed. 00138 §B argues it should be narrowed to admin_access_level(p_user_id) = ''admin'' in ONE move with all 48 policies re-verified, not one predicate at a time. Re-read §B, then delete this assertion in the file that does it.';
  END IF;
  IF obj_description('public.is_admin(uuid)'::regprocedure, 'pg_proc') IS NULL THEN
    RAISE EXCEPTION '00138 assert: the is_admin COMMENT did not take';
  END IF;

  -- The blast radius quoted in §B, re-counted. Not pinned to 48 — policies are
  -- added weekly — but it must not be zero, which would mean is_admin had
  -- stopped being load-bearing and §B's whole argument had gone stale.
  SELECT count(*) INTO v_count
    FROM pg_policy p
   WHERE pg_get_expr(p.polqual, p.polrelid) LIKE '%is_admin%'
      OR pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%is_admin%';
  IF v_count = 0 THEN
    RAISE EXCEPTION '00138 assert: no policy references is_admin any more — §B is measuring something that no longer exists';
  END IF;
  RAISE NOTICE '00138: % policies reference is_admin (48 on production, 2026-08-17)', v_count;

  -- ---- §C. both columns still exist and now carry a comment ----
  FOREACH v_txt IN ARRAY ARRAY['singles_k_factor', 'doubles_k_factor'] LOOP
    SELECT count(*) INTO v_count
      FROM pg_attribute
     WHERE attrelid = 'public.ratings'::regclass AND attname = v_txt AND NOT attisdropped;
    IF v_count <> 1 THEN
      RAISE EXCEPTION
        '00138 assert: ratings.% is gone. 00138 §C says it is still RENDERED by the player leaderboard and must not be dropped before that page changes.', v_txt;
    END IF;
    IF col_description('public.ratings'::regclass,
                       (SELECT attnum FROM pg_attribute
                         WHERE attrelid = 'public.ratings'::regclass AND attname = v_txt)) IS NULL THEN
      RAISE EXCEPTION '00138 assert: the COMMENT on ratings.% did not take', v_txt;
    END IF;
  END LOOP;

  -- ---- §D. 00136's finding, if 00136 has been applied here ----
  -- A NOTICE AND NOT AN EXCEPTION, and the first draft of this file had it the
  -- other way round — which is how the container caught it. Requiring 00136's
  -- COMMENT to be present would have made 00138 REFUSE TO APPLY TO PRODUCTION,
  -- where 00136 is not applied yet (header). This file must not acquire an
  -- ordering dependency on another file just to check somebody else's work, so
  -- the hard assertion below is on the CHECK constraint, which has been there
  -- since 00001 and is identical on both databases.
  v_txt := col_description('public.tournament_matches'::regclass,
             (SELECT attnum FROM pg_attribute
               WHERE attrelid = 'public.tournament_matches'::regclass AND attname = 'status'));
  IF v_txt IS NULL OR v_txt !~ 'disputed' THEN
    RAISE NOTICE
      '00138 §D: tournament_matches.status carries no comment naming `disputed` — 00136 is not applied to this database yet. Nothing for 00138 to do either way; 00136 is where that finding lives.';
  END IF;
  -- The value 00136 documents must still be admitted, or the two readers §D
  -- names are dead code. THIS one is hard: the CHECK predates both files.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tournament_matches'::regclass
       AND conname = 'tournament_matches_status_check'
       AND pg_get_constraintdef(oid) LIKE '%disputed%'
  ) THEN
    RAISE EXCEPTION '00138 assert: `disputed` was removed from tournament_matches_status_check — §D explains why it must not be';
  END IF;

  -- ---- §E. the ledger is append-only from every application path ----
  -- THE FOUR THAT MATTER. service_role holds BYPASSRLS, so these grants — not
  -- the policies — are what protect the placement-bonus ledger.
  IF NOT has_table_privilege('service_role', 'public.tournament_audit_log', 'INSERT') THEN
    RAISE EXCEPTION '00138 assert: service_role lost INSERT on tournament_audit_log — logAudit and the bonus ledger write would fail';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.tournament_audit_log', 'SELECT') THEN
    RAISE EXCEPTION '00138 assert: service_role lost SELECT on tournament_audit_log — readBonusLedger refuses to apply bonuses without it';
  END IF;
  IF has_table_privilege('service_role', 'public.tournament_audit_log', 'UPDATE')
     OR has_table_privilege('service_role', 'public.tournament_audit_log', 'DELETE')
     OR has_table_privilege('service_role', 'public.tournament_audit_log', 'TRUNCATE') THEN
    RAISE EXCEPTION
      '00138 assert: service_role can still UPDATE, DELETE or TRUNCATE tournament_audit_log. It has BYPASSRLS, so this grant is the only thing between the admin client and doubling every placement bonus on an event.';
  END IF;

  -- anon: nothing at all. Checked verb by verb because REVOKE FROM PUBLIC alone
  -- does not remove Supabase's explicit anon entry, and vice versa (00131).
  FOREACH v_txt IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.tournament_audit_log', v_txt) THEN
      RAISE EXCEPTION '00138 assert: anon still holds % on tournament_audit_log', v_txt;
    END IF;
  END LOOP;

  -- authenticated: SELECT and nothing else.
  IF NOT has_table_privilege('authenticated', 'public.tournament_audit_log', 'SELECT') THEN
    RAISE EXCEPTION
      '00138 assert: authenticated lost SELECT on tournament_audit_log. §E.2 keeps it deliberately — the Admin read policy gates it to is_admin and a tournament audit screen is being designed against it.';
  END IF;
  FOREACH v_txt IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('authenticated', 'public.tournament_audit_log', v_txt) THEN
      RAISE EXCEPTION '00138 assert: authenticated still holds % on tournament_audit_log', v_txt;
    END IF;
  END LOOP;

  -- postgres must keep UPDATE: merge_players is SECURITY DEFINER owned by it and
  -- repoints performed_by. This is the assertion that makes §E.3's argument a
  -- check rather than a claim.
  IF NOT has_table_privilege('postgres', 'public.tournament_audit_log', 'UPDATE') THEN
    RAISE EXCEPTION
      '00138 assert: postgres cannot UPDATE tournament_audit_log — merge_players cannot repoint performed_by and every merge involving a tournament officer would fail';
  END IF;

  -- No FOR ALL policy may remain: the point of the split is that the policy list
  -- stops claiming the ledger is rewritable.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tournament_audit_log'::regclass AND polcmd = '*') THEN
    RAISE EXCEPTION '00138 assert: a FOR ALL policy still exists on tournament_audit_log';
  END IF;
  -- And the read paths must still have a policy each, or a future without
  -- BYPASSRLS breaks placement bonuses and the audit screen.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tournament_audit_log'::regclass
                   AND polcmd = 'a' AND pg_get_expr(polwithcheck, polrelid) LIKE '%service_role%') THEN
    RAISE EXCEPTION '00138 assert: the service_role INSERT policy is missing';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policy
   WHERE polrelid = 'public.tournament_audit_log'::regclass AND polcmd = 'r';
  IF v_count <> 2 THEN
    RAISE EXCEPTION
      '00138 assert: expected 2 SELECT policies on tournament_audit_log (admin, service_role), found %', v_count;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tournament_audit_log'::regclass) THEN
    RAISE EXCEPTION '00138 assert: RLS is disabled on tournament_audit_log; every policy above is decoration';
  END IF;

  RAISE NOTICE '00138: all assertions passed.';
END
$assert$;

COMMIT;

-- ============================================================
-- FOUND, NOT FIXED
-- ============================================================
-- 1. DELETING A TOURNAMENT EVENT IS ALREADY BROKEN, and tournament_audit_log is
--    why. This came out of §E and is the largest thing this file leaves alone.
--
--    All four of its foreign keys are NO ACTION — no CASCADE, no SET NULL:
--      tournament_audit_log_tournament_id_fkey -> tournaments(id)
--      tournament_audit_log_event_id_fkey      -> tournament_events(id)
--      tournament_audit_log_match_id_fkey      -> tournament_matches(id)
--      tournament_audit_log_performed_by_fkey  -> players(id)
--
--    And every row has the first two populated. Measured on staging:
--      total 595 | tournament_id 595 | event_id 595 | match_id 54
--
--    `event_created` is logged with event_id set the moment an event is created,
--    so EVERY event has at least one referencing audit row from birth. Therefore:
--
--      * deleteTournamentEvent (apps/admin/src/lib/tournament-actions/events.ts:538)
--        must fail with 23503 for every event it is allowed to delete. Its own
--        guard is `status = 'registration'`, which does not help — the audit row
--        predates registration closing.
--      * deleteTournament (apps/admin/src/lib/actions/tournaments.ts:355) deletes
--        the events first and relies on their CASCADE, so it fails at the same
--        FK, one statement earlier than its comment expects.
--      * regenerating a draw does
--        `from('tournament_matches').delete().eq('event_id', eventId)`
--        (brackets.ts:195), which fails once any match has an audit row — 54 rows
--        across result_entered, result_edited, match_court_set, match_entry_set,
--        match_ready_marked, match_entry_cleared and walkover_entered. So
--        REGENERATE AFTER A RESULT HAS BEEN ENTERED is broken too.
--
--    No trigger compensates: tournament_events and tournament_matches have no
--    non-internal triggers at all, and tournaments has only set_updated_at.
--    Nothing in either app deletes from tournament_audit_log.
--
--    NOT FIXED HERE, for one reason: the repair is a DESIGN CHOICE about the
--    audit trail, not hygiene. ON DELETE CASCADE on tournament_id/event_id makes
--    deleting a tournament ERASE ITS AUDIT TRAIL — including the placement-bonus
--    ledger §E just spent four statements protecting. ON DELETE SET NULL keeps
--    the rows and makes them unattributable, and would orphan ledger rows whose
--    only key is event_id. Both are defensible and the owner should pick. It also
--    lands squarely on the branch another agent is holding this week
--    (fix/audit-integrity-gaps), and it needs its own container proof of the
--    23503 and of the chosen repair.
--
--    THE 23503 ITSELF IS PROVEN, in the container suite at the foot: check 31
--    builds an event with an `event_created` audit row and asserts the DELETE
--    fails with foreign_key_violation. That is the part that should not have to
--    be re-derived by whoever fixes it.
--
-- 2. THE PLAYER LEADERBOARD SHOWS A WRONG K. §C measures it: every ratings row
--    on both databases holds 80/64, the provisional constants, and the page
--    prints them only to players who are NOT provisional. Fixing it is a UI
--    decision (delete the chip, or read the real K out of platform_settings) on
--    a page another agent's tree touches this week. The COMMENTs in §C are so
--    the next person does not have to measure it again.
--
-- 3. create_player_with_rating HAS THE SAME SHAPE AS §0's BUG and is left alone:
--      INSERT INTO players (..., onboarding_completed) VALUES (..., p_user_id IS NOT NULL)
--    "has a login, therefore has onboarded" is the same inference §0 removes.
--    It is NOT a defect today: both callers
--    (apps/admin/src/lib/actions/players.ts:135, an exec creating a roster row,
--    which passes p_user_id NULL; apps/player/src/lib/actions/profile.ts:483,
--    which runs at the END of onboarding) make it true at the point of call.
--    It becomes a defect the day something calls it with a user_id BEFORE
--    onboarding — which is exactly what 00132 introduced for a different
--    function. Flagged rather than changed, because changing it needs both
--    callers re-argued and the second one is inside the onboarding flow.
--
-- 4. audit_logs (the OTHER table) carries `anon=arwdm` on production, same as
--    tournament_audit_log did. Inert — its two policies are `authenticated`-only
--    and both gated on is_admin(auth.uid()), so anon is refused every row and
--    every insert — and already closed by 00131, which is committed and
--    unapplied. Not touched here; this file's subject is the tournament ledger.
--
-- ============================================================
-- DEPLOY ORDER — the whole file
-- ============================================================
-- FREE, IN BOTH DIRECTIONS. No column is added or dropped, so no NAMED select
-- in either app can go stale (00135's rule) and no drop can outrun a deploy
-- (00109's). No function is created, so 00126/00131's "new functions are born
-- anon-EXECUTE-able" trap does not apply — and CREATE OR REPLACE on the
-- EXISTING merge_players leaves its ACL alone, which is asserted above by
-- checking ownership and SECURITY DEFINER survived. No signature changes, so
-- PostgREST's cache cannot be stale and no NOTIFY is warranted (00096:86,
-- 00100:80, 00130:151/198). The grant and policy changes remove verbs no
-- application path uses, so no build depends on this file having run, and this
-- file does not depend on any build.
--
-- ONE ORDERING NOTE THAT IS NOT ABOUT THIS FILE, repeated from §B because it is
-- the actionable item: applying 00132 to production opens the is_admin gap
-- described there. Decide that consciously.
--
-- ============================================================
-- VERIFICATION STATUS — read this before applying
-- ============================================================
-- *** SEE THE FOOT OF THIS SECTION FOR WHAT IS AND IS NOT PROVEN. ***
--
-- THE CONTAINER. A disposable `supabase/postgres:17.6.1.136` container — the
-- SAME IMAGE FAMILY AND THE SAME 17.6 SERVER as both live databases — loaded
-- with a read-only `pg_dump --schema-only` OF PRODUCTION ITSELF, so the
-- pre-state is production's real 55-table public schema rather than a stub
-- somebody wrote to make a test pass. Nothing was run against the live
-- databases; every statement issued to them was a catalogue read or a schema
-- dump.
--
-- THE PRE-STATE IS ASSERTED BEFORE ANYTHING IS EXERCISED, because a test built
-- against a straw pre-state proves nothing. Nine checks abort the run unless the
-- container really reproduces production:
--   1-3. merge_players present, carrying `onboarding_completed = TRUE` EXACTLY
--        ONCE, postgres-owned and SECURITY DEFINER
--   4.   is_admin with NO standing gate at all
--   5.   service_role and postgres WITH BYPASSRLS, anon/authenticated without —
--        the fact §E's whole argument turns on
--   6.   the ACL rebuilt to production's verb-for-verb `anon=arwdm` /
--        `authenticated=arwdm` / `service_role=arwdDxtm` and ASSERTED, because
--        pg_dump emits GRANT ALL and a REVOKE test against a straw ACL is
--        worthless (00131's lesson)
--   7.   exactly one FOR ALL policy, named as production names it, RLS on
--   8.   merge_players' run-time helpers present
--   9.   the k_factor columns present and UNCOMMENTED, the status CHECK already
--        admitting 'disputed'
--
-- THE BUG IS THEN REPRODUCED BEFORE IT IS FIXED (check 10), because a run that
-- only inspects the end state cannot tell a fix from a coincidence. Then 00138
-- is applied, then 13 behavioural checks, then the WHOLE FILE IS APPLIED A
-- SECOND TIME to prove idempotence.
--
--   >>> RESULT: 23/23 CHECKS PASSED, TWICE — once with the pre-state built
--   >>> from PRODUCTION's dumped schema and once from STAGING's, plus a clean
--   >>> second application of the file in both. <<<
--
-- The behavioural checks that matter most:
--   10. THE BUG, REPRODUCED: merging a stub set onboarding_completed = TRUE.
--   11. Fixed: the stub merges, the login is still adopted, the flag stays FALSE.
--   12. OR never DEMOTES — a survivor that had already onboarded keeps it.
--   13. OR still CONFERS — merging a genuinely onboarded login still sets it,
--       which is the case the original TRUE existed for and must not be lost.
--   14. merge_players called AS service_role STILL repoints
--       tournament_audit_log.performed_by after the revokes. §E.3's
--       definer-bypass argument as evidence, not assertion.
--   15-16. service_role can still INSERT and SELECT the ledger (logAudit,
--       readBonusLedger) — the two verbs whose loss would break placement bonuses.
--   17-19. service_role UPDATE, DELETE and TRUNCATE all refused with 42501.
--       ATTEMPTED, not inferred from has_table_privilege.
--   20-22. anon refused even SELECT; authenticated keeps SELECT, loses INSERT.
--   23. FOUND, NOT FIXED item 1 PROVEN: deleting a tournament_events row with an
--       `event_created` audit row raises 23503.
--
-- THE STAGING RUN IS THE ONE THAT JUSTIFIES §0's REGEXP. After applying 00138 to
-- staging's body, the live definition was queried for BOTH markers:
--
--     recompute_player_stats present -> t     (00123's work SURVIVED)
--     COALESCE(v_remove.onboarding…) -> t     (the fix LANDED)
--
-- A literal CREATE OR REPLACE built from production's text would have returned
-- f | t there — the fix applied and 00123 silently reverted. That is the failure
-- mode the approach exists to prevent, and it is now measured rather than argued.
--
-- TWO THINGS THE CONTAINER CAUGHT AND SENT BACK INTO THIS FILE:
--   * §D's check on 00136's COMMENT was written as an EXCEPTION and would have
--     made 00138 REFUSE TO APPLY to production. It is now a NOTICE. And the
--     notice fired on BOTH pre-states, which is its own finding: 00136 added no
--     DDL — only a NOTIFY and a COMMENT — so it is UNAPPLIED ON BOTH DATABASES,
--     and its 'disputed' finding currently exists only in the repository. Worth
--     knowing when 00136 is applied: there is nothing to see afterwards either,
--     which is exactly the sort of file that gets skipped.
--   * The two new policies were created without a matching DROP IF EXISTS, so
--     the second application died on "policy already exists". CREATE POLICY has
--     no OR REPLACE. Fixed; idempotence now passes on both pre-states.
--
-- NOT PROVEN, and it is the one thing left: no PostgREST was put in front of the
-- container, so the claim that no app path loses a verb rests on the grep of
-- both apps recorded in §E.3 (four call sites, all INSERT or SELECT) rather than
-- on an exercised request.
-- ============================================================
