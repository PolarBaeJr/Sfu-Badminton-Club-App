-- ============================================================
-- 00126 — Take EXECUTE on the SECURITY DEFINER RPCs away from the browser key
-- ============================================================
-- THE HOLE, MEASURED ON PRODUCTION (pg_proc.proacl, 2026-08-15):
-- 36 of the 43 SECURITY DEFINER functions in `public` are EXECUTE-able by
-- `anon`. The anon key ships inside the browser bundle, so `anon` means anyone
-- who has read the JavaScript. `authenticated` means any signed-in member,
-- including a pending_approval account.
--
-- CAUSE. Supabase runs, on every project:
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- so a freshly created function does not get proacl = NULL (the PUBLIC
-- default). It gets EXPLICIT ACL entries `anon=X/postgres` and
-- `authenticated=X/postgres`. 00102:324 and its siblings wrote
--   REVOKE EXECUTE ... FROM PUBLIC;
-- which removes the `=X/postgres` entry and nothing else. The two explicit
-- entries survive, and has_function_privilege('anon', ...) stays true.
--
-- 00053:230 documented this exact trap for check_session_caps and revoked from
-- anon by name, which is why check_session_caps is the ONE function in the
-- whole schema that anon cannot reach. 00125:684 ("FOUND, NOT FIXED") found it
-- again on the three tournament-pair functions and handed the fix to its own
-- migration. This is that migration, widened to the whole schema.
--
-- THE TRAP RUNS BOTH WAYS, so every statement below names PUBLIC as well as the
-- role. `REVOKE ... FROM anon` on its own is just as much a no-op whenever the
-- `=X/postgres` entry is still present, because anon is a member of PUBLIC.
-- Verified: revoking get_player_id from `authenticated` alone left it callable;
-- revoking it from `PUBLIC, authenticated` denied it. Two revokes, one grant —
-- neither half is sufficient.
--
-- WHAT MADE IT URGENT. Six of the reachable functions mutate and check nothing
-- about their caller — their authorisation lives in app code (splitPairImpl's
-- requireCapability, mergePlayers' admin gate) which a direct PostgREST RPC
-- never runs. merge_players deletes a member row; apply_rating_delta rewrites
-- ratings. A seventh, apply_match_result, DOES check its caller but only
-- inside `IF auth.uid() IS NOT NULL AND NOT is_admin(auth.uid()) ...` — for
-- anon, auth.uid() is NULL and every branch of that guard is skipped.
--
-- ============================================================
-- THIS IS A BEHAVIOUR CHANGE, SO IT IS TRIAGED, NOT SWEPT
-- ============================================================
-- A blanket revoke breaks the app. Four categories, decided from evidence:
--
-- (1) TRIGGER FUNCTIONS — 9 of the 36. `RETURNS trigger` cannot be invoked
--     over PostgREST at all; Postgres itself refuses with "trigger functions
--     can only be called as triggers" before the body runs, and PostgREST does
--     not expose them in the OpenAPI surface. Their grants are unexploitable,
--     so they are left untouched rather than churned:
--       announcements_orphaned_to_evergreen, guard_last_admin_passkey_delete,
--       guard_last_admin_role, guard_player_privileged_columns,
--       touch_event_on_entry_delete, trigger_check_noshow_threshold,
--       trigger_init_player_records, trigger_match_confirmed,
--       trigger_match_participants_inserted
--     (A trigger's own firing does not consult the invoker's EXECUTE grant
--     either — it is checked once against the trigger's creator at CREATE
--     TRIGGER time — so revoking would have been harmless. It would also have
--     been noise.)
--
-- (2) FUNCTIONS CALLED FROM INSIDE RLS POLICIES — untouchable in BOTH roles.
--     A policy expression executes as the QUERYING role, so revoking
--     `authenticated` from one of these does not tighten anything; it makes
--     every policy that names it raise 42501 and takes the app down. Measured
--     with pg_get_expr(polqual, polrelid) || pg_get_expr(polwithcheck,
--     polrelid) over all of pg_policy, not guessed from names:
--       get_player_id        — 38 policies (challenges, matches, notifications,
--                              push_subscriptions, storage.objects, ...)
--       is_admin             — 44 policies (players_select, matches_admin, ...)
--       is_admin_or_coach    —  3 policies (varsity_notes vn_select/insert/update)
--       session_checkin_open —  1 policy  (session_attendance attendance_insert)
--     Not even the anon grant is free here. `tournament_audit_log`'s policy
--     "Admin read tournament_audit_log" has polroles = {} — i.e. PUBLIC, so it
--     is evaluated for anon too — and it calls is_admin. Revoking anon would
--     convert an empty result set into "permission denied for function
--     is_admin" for any anonymous read of that table. is_admin(NULL) is already
--     false, so the anon grant buys an attacker nothing; it is left in place.
--
-- (3) FUNCTIONS THE APPS CALL WITH THE USER'S CLIENT keep `authenticated`.
--     Established by grepping both apps for `.rpc('name'` and resolving which
--     client each call site holds. createAdminClient() (admin) and
--     createServiceRoleClient() (player) use SUPABASE_SERVICE_ROLE_KEY, whose
--     role bypasses these grants entirely, so those call sites impose no
--     requirement. createServerSupabaseClient() / the browser client carry the
--     anon key plus the user's cookie, so PostgREST runs them as
--     `authenticated` (or `anon` when signed out) and the grant is load-bearing.
--     A fifth, invisible-to-grep path also counts: a COLUMN DEFAULT is
--     evaluated with the INSERTING role's privileges. challenges.expires_at
--     defaults to
--       now() + make_interval(hours => platform_setting_int('challenge_rules',
--                                        'challenge_expiry_hours', 72))
--     and challenges_insert admits `authenticated`, so platform_setting_int
--     must keep EXECUTE for authenticated or every player-created challenge
--     fails. (sessions.starts_at/ends_at default through club_local_instant,
--     which is SECURITY INVOKER and out of scope here, but keep it in mind
--     before touching its grants.)
--
-- (4) WHAT IS LEFT is revoked below, each with the caller and client named.
--
-- ONE APP CHANGE SHIPS WITH THIS FILE:
--   apps/player/src/lib/actions/challenges.ts — increment_challenges_issued
--   moves from the user's client to createServiceRoleClient(). See its entry
--   in group C.
--
-- IDEMPOTENT. REVOKE and GRANT are naturally so. The assertion block at the
-- foot re-derives the final state from pg_proc and raises if any line did not
-- take, which also makes a signature typo fail loudly instead of silently
-- revoking nothing. Every signature below was read off pg_proc on production
-- and re-checked against 00122-00125, which are not yet applied there;
-- 00123/00125 use CREATE OR REPLACE with identical argument lists, so no
-- signature drifts between prod and this branch.
-- ============================================================

BEGIN;

-- ============================================================
-- A. REVOKE anon ONLY — the app calls these with a signed-in user's client
-- ============================================================
-- Nothing here is reachable by a legitimate logged-out visitor. Each still
-- needs `authenticated`, so each keeps it.

-- admin_access_level(uuid) — returns the console access level for ANY user id.
-- Callers: apps/admin/src/app/auth/callback/route.ts:71 and
-- apps/admin/src/middleware.ts:148, both on the request-scoped server client
-- (createServerClient + anon key + the admin's cookie => `authenticated`), both
-- passing the *verified session's* own user.id. No anonymous caller.
REVOKE EXECUTE ON FUNCTION public.admin_access_level(uuid) FROM PUBLIC, anon;

-- admin_console_access(uuid) — the full per-page capability set for a user id.
-- Callers: apps/admin/src/components/sidebar.tsx:82 (a 'use client' component,
-- so the browser client, but only after a session exists => `authenticated`)
-- and apps/admin/src/middleware.ts:116 (server client, same). No anonymous
-- caller: both read user.id off an already-verified session.
REVOKE EXECUTE ON FUNCTION public.admin_console_access(uuid) FROM PUBLIC, anon;

-- apply_match_result(uuid, uuid) — applies Elo and flips a match to confirmed.
-- Caller: apps/player/src/lib/actions/matches.ts:142 on the USER's client (the
-- confirming player attests the opponent's result), plus three admin call
-- sites on createAdminClient(). `authenticated` is therefore load-bearing.
-- THE anon GRANT IS THE DANGEROUS ONE: the two internal guards are both
-- `IF auth.uid() IS NOT NULL AND NOT is_admin(auth.uid()) AND ...`, so an anon
-- caller, for whom auth.uid() is NULL, skips "only a participant can confirm"
-- AND "the submitter cannot confirm their own result" and can force-confirm any
-- pending match in the club, moving everybody's rating.
REVOKE EXECUTE ON FUNCTION public.apply_match_result(uuid, uuid) FROM PUBLIC, anon;

-- create_player_with_rating(...) — inserts a player + ratings row atomically.
-- Caller: apps/player/src/lib/actions/profile.ts:472 on the user's server
-- client during onboarding (the user is signed in but has no player row yet),
-- and apps/admin/src/lib/actions/players.ts:125 on createAdminClient().
-- Its internal guard mirrors players_self_insert (user_id = auth.uid(),
-- status = 'pending_approval', role = 'player'), so `authenticated` is safe and
-- required. anon has no onboarding to do.
REVOKE EXECUTE ON FUNCTION public.create_player_with_rating(
  uuid, text, text, text, text, text, player_status, user_role
) FROM PUBLIC, anon;

-- dispute_match_result(uuid, dispute_reason, text) — opens a dispute.
-- Caller: apps/player/src/lib/actions/matches.ts:222 on the user's client.
-- Guarded internally: `v_player := get_player_id(auth.uid()); IF v_player IS
-- NULL THEN RAISE 'Not authenticated'`, then a participant check. anon already
-- fails that first line, so this revoke removes a wasted round trip rather than
-- an exploit — but it also removes the SECURITY DEFINER row locks
-- (`SELECT ... FOR UPDATE` on matches) that anon could take out before hitting
-- the RAISE.
REVOKE EXECUTE ON FUNCTION public.dispute_match_result(uuid, dispute_reason, text)
  FROM PUBLIC, anon;

-- has_passkeys(uuid) — whether a user id has any passkey enrolled.
-- Caller: apps/admin/src/middleware.ts:224 on the server client, for the
-- already-verified user.id, to decide whether the passkey gate applies.
-- `authenticated` is required. For anon it is a free oracle over arbitrary user
-- ids ("does this account use a passkey?"), which is exactly the reconnaissance
-- an attacker wants before phishing.
REVOKE EXECUTE ON FUNCTION public.has_passkeys(uuid) FROM PUBLIC, anon;

-- submit_match_result(uuid, jsonb, boolean) — creates the match, participants
-- and games from a challenge.
-- Caller: apps/player/src/lib/actions/matches.ts:70 on the user's client; that
-- IS the player-submits-a-score path, so `authenticated` must stay. Internally
-- guarded on get_player_id(auth.uid()) being a participant of the challenge.
REVOKE EXECUTE ON FUNCTION public.submit_match_result(uuid, jsonb, boolean)
  FROM PUBLIC, anon;

-- validate_challenge_creation(uuid, uuid, text, uuid, uuid) — read-only
-- pre-flight for a challenge.
-- Caller: apps/player/src/lib/actions/challenges.ts:33 on the user's client, so
-- `authenticated` stays. It takes p_creator_id as a parameter and checks
-- nothing about auth.uid(), and being SECURITY DEFINER it reads players.status,
-- players.banned and ladder position for arbitrary ids past RLS — a membership
-- and standing oracle that had no business being open to the anon key.
REVOKE EXECUTE ON FUNCTION public.validate_challenge_creation(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon;

-- platform_setting_bool / _int / _numeric — SECURITY DEFINER readers of
-- platform_settings, whose RLS (settings_admin) otherwise restricts it to
-- admins. No app code calls any of them over PostgREST; every in-database
-- caller (session_cap_for, validate_challenge_creation, session_checkin_open,
-- ...) is itself SECURITY DEFINER and so runs them as the owner regardless of
-- these grants.
-- `authenticated` STAYS, for platform_setting_int because challenges.expires_at
-- DEFAULTs through it and a column default is evaluated with the inserting
-- role's privileges — revoking it would break every player-created challenge —
-- and for the other two by symmetry: they are scalar getters with no user-role
-- call path found in defaults, policies, constraints or app code, so the
-- revoke would buy little against the risk of a default I did not find. The
-- residual read exposure is written up under WHAT AN ATTACKER CAN STILL DO.
REVOKE EXECUTE ON FUNCTION public.platform_setting_bool(text, text, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_setting_int(text, text, integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_setting_numeric(text, text, numeric) FROM PUBLIC, anon;

-- ============================================================
-- B. REVOKE BOTH — no caller outside the database or the service-role key
-- ============================================================
-- For each of these the decision was (a) revoke rather than (b) add an internal
-- caller check. (b) means rewriting the body of a SECURITY DEFINER function,
-- which 00049 warns about, to re-derive an authorisation the app already
-- enforces one layer up; and for the four with no app call site at all there is
-- no caller left to check. (a) matches how every one of them is already
-- invoked, so it is a no-op for the app.
--
-- REVOKING `authenticated` NEEDS ONE MORE PROOF THAN REVOKING `anon`: an
-- in-database caller only ignores these grants if it is itself SECURITY
-- DEFINER. A SECURITY INVOKER intermediary would pass the caller's role
-- straight through and this migration would break it silently. Measured on
-- production over pg_proc.prosrc — every caller of every function in this
-- group, and of the group in section C and D:
--   activate_season                 -> platform_setting_bool, _numeric   secdef
--   apply_tournament_match_rating   -> apply_rating_delta                secdef
--   check_session_caps              -> session_cap_for                   secdef
--   guard_last_admin_passkey_delete -> admins_with_passkeys              secdef
--   guard_last_admin_role           -> admins_with_passkeys              secdef
--   merge_players                   -> merge_players_preview             secdef
--   submit_match_result             -> session_cap_for, check_session_caps  secdef
-- Seven callers, all SECURITY DEFINER, zero SECURITY INVOKER intermediaries.

-- admins_with_passkeys(uuid, uuid) — counts admins holding an admin-enrolled
-- passkey. NO `.rpc('admins_with_passkeys'` anywhere in either app. Its only
-- callers are guard_last_admin_passkey_delete and guard_last_admin_role, both
-- SECURITY DEFINER trigger functions that execute it as the owner and are
-- unaffected by these grants. Open, it counted admins for an anonymous caller.
REVOKE EXECUTE ON FUNCTION public.admins_with_passkeys(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admins_with_passkeys(uuid, uuid) TO service_role;

-- apply_rating_delta(...) — UNGUARDED MUTATOR #1. Reads a ratings row, applies
-- a signed delta, rewrites elo/wins/losses/streak. No caller check of any kind.
-- NO app call site exists: grep finds it only in database.gen.ts (a generated
-- type) and in migrations 00082-00084. Its only callers are
-- apply_tournament_match_rating and merge_players, both SECURITY DEFINER, both
-- running it as the owner. Revoking both roles costs nothing and closes the
-- single worst primitive in the schema: anyone with the browser bundle could
-- set any player's rating to anything, one delta at a time.
REVOKE EXECUTE ON FUNCTION public.apply_rating_delta(
  uuid, text, integer, boolean, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_rating_delta(
  uuid, text, integer, boolean, integer, integer, integer, integer
) TO service_role;

-- merge_players(uuid, uuid, uuid) — UNGUARDED MUTATOR #2. Repoints every
-- foreign key from p_remove to p_keep and DELETES the p_remove player row. No
-- caller check. Sole call site: apps/admin/src/lib/actions/players.ts:443 on
-- createAdminClient() (service-role key), behind the admin gate in app code.
-- Nothing legitimate calls it as anon or authenticated.
REVOKE EXECUTE ON FUNCTION public.merge_players(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players(uuid, uuid, uuid) TO service_role;

-- merge_players_preview(uuid, uuid) — the dry run for the above. Read-only, but
-- SECURITY DEFINER, so it reports row counts across match_participants,
-- challenges, session_attendance, club_fees and the rest for an arbitrary
-- player id, straight past RLS. Sole call site:
-- apps/admin/src/lib/actions/players.ts:425 on createAdminClient().
REVOKE EXECUTE ON FUNCTION public.merge_players_preview(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_preview(uuid, uuid) TO service_role;

-- pair_tournament_entrants(...) — UNGUARDED MUTATOR #3. Creates a doubles pair
-- and moves both entrants into it. Sole call site:
-- apps/admin/src/lib/tournament-actions/participants.ts:1224 on
-- createAdminClient(); the capability check (tournaments.pairs.write) is in the
-- surrounding app code and a direct RPC skips it. This is one of the three
-- 00125:709 prescribed.
REVOKE EXECUTE ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid)
  TO service_role;

-- swap_tournament_pair_member(...) — UNGUARDED MUTATOR #4. Substitutes one half
-- of a pair. Sole call site:
-- apps/admin/src/lib/tournament-actions/participants.ts:1561 on
-- createAdminClient(). Second of the three from 00125:713.
REVOKE EXECUTE ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid)
  TO service_role;

-- unpair_tournament_pair(uuid, uuid, text, uuid) — UNGUARDED MUTATOR #5. Splits
-- a pair and can withdraw a member from an event. Sole call site:
-- apps/admin/src/lib/tournament-actions/participants.ts:1392 on
-- createAdminClient(), from splitPairImpl, whose requireCapability
-- (tournaments.draw.exit.write / .pairs.remove.write) is exactly the check a
-- direct RPC bypasses. Third of the three from 00125:709 — this file is the
-- "own migration" that comment hands the fix to.
REVOKE EXECUTE ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid) TO service_role;

-- session_cap_for(text) — SECURITY DEFINER wrapper over platform_setting_int
-- for the per-session rated-match cap. No `.rpc('session_cap_for'` anywhere;
-- its only caller is check_session_caps, which is SECURITY DEFINER and runs it
-- as the owner. Revoked in both roles for the same reason 00053 revoked
-- check_session_caps: a function with no client caller should have no client
-- grant.
REVOKE EXECUTE ON FUNCTION public.session_cap_for(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.session_cap_for(text) TO service_role;

-- ============================================================
-- C. THE ONE THAT NEEDED AN APP CHANGE
-- ============================================================
-- increment_challenges_issued(uuid) — UNGUARDED MUTATOR #6. Body in full:
--   INSERT INTO reliability_metrics (player_id, challenges_issued)
--   VALUES (p_player_id, 1)
--   ON CONFLICT (player_id) DO UPDATE
--     SET challenges_issued = reliability_metrics.challenges_issued + 1, ...
-- It takes the player id as a parameter and checks nothing, so any caller could
-- inflate any member's issued-challenge counter — the input to the reliability
-- score shown on their profile.
--
-- Unlike the other five it had a real user-client caller
-- (apps/player/src/lib/actions/challenges.ts:127 on
-- createServerSupabaseClient()), so revoking alone would have broken challenge
-- creation. Choice (b), an internal `p_player_id = get_player_id(auth.uid())`
-- check, is not enough on its own either: auth.uid() is NULL under the
-- service-role key, so (b) would need a second branch re-admitting
-- service_role — most of the argument for (a).
--
-- CHOSEN: (a), with the call site moved to createServiceRoleClient(). The same
-- function body already switches to the service-role client 28 lines earlier
-- for the participants insert, so this is the established shape in that file;
-- the id passed is player.id from requirePlayer(), i.e. the verified session;
-- and it avoids rewriting a SECURITY DEFINER body, which 00049 warns about.
-- APPLY ORDER: the app change and this migration must ship together. If the
-- migration lands first, challenge creation raises 42501 until the deploy
-- catches up. Deploy the app, then run this.
REVOKE EXECUTE ON FUNCTION public.increment_challenges_issued(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_challenges_issued(uuid) TO service_role;

-- ============================================================
-- D. HYGIENE, NOT A HOLE — safe to drop this one line
-- ============================================================
-- check_session_caps(uuid, uuid, text) — 00053:230 already revoked PUBLIC and
-- anon and wrote "No client ever calls this directly — the only caller is
-- submit_match_result, which is SECURITY DEFINER and so runs it as the owner
-- regardless of grants." It left `authenticated` behind, because at the time
-- the trap it had just diagnosed was the PUBLIC one. There is no exploit behind
-- this line: the function returns a boolean about a cap. It is here only so the
-- schema states the same rule once. Drop this statement without touching
-- anything else if it makes the change easier to reason about.
REVOKE EXECUTE ON FUNCTION public.check_session_caps(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_session_caps(uuid, uuid, text) TO service_role;

-- ============================================================
-- E. ASSERT THE RESULT
-- ============================================================
-- Re-derives the final state from pg_proc rather than trusting that the
-- statements above matched. A signature typo would otherwise revoke nothing at
-- all and still COMMIT. Also makes the file safe to re-run: on a second pass
-- every REVOKE is a no-op and this block still passes.
DO $$
DECLARE
  v_bad TEXT;
BEGIN
  -- Everything named above must exist. to_regprocedure returns NULL, not an
  -- error, for a signature that does not resolve.
  SELECT string_agg(sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.admin_access_level(uuid)',
    'public.admin_console_access(uuid)',
    'public.admins_with_passkeys(uuid,uuid)',
    'public.apply_match_result(uuid,uuid)',
    'public.apply_rating_delta(uuid,text,integer,boolean,integer,integer,integer,integer)',
    'public.check_session_caps(uuid,uuid,text)',
    'public.create_player_with_rating(uuid,text,text,text,text,text,player_status,user_role)',
    'public.dispute_match_result(uuid,dispute_reason,text)',
    'public.has_passkeys(uuid)',
    'public.increment_challenges_issued(uuid)',
    'public.merge_players(uuid,uuid,uuid)',
    'public.merge_players_preview(uuid,uuid)',
    'public.pair_tournament_entrants(uuid,uuid,uuid,text,integer,uuid)',
    'public.platform_setting_bool(text,text,boolean)',
    'public.platform_setting_int(text,text,integer)',
    'public.platform_setting_numeric(text,text,numeric)',
    'public.session_cap_for(text)',
    'public.submit_match_result(uuid,jsonb,boolean)',
    'public.swap_tournament_pair_member(uuid,uuid,uuid,text,integer,uuid)',
    'public.unpair_tournament_pair(uuid,uuid,text,uuid)',
    'public.validate_challenge_creation(uuid,uuid,text,uuid,uuid)'
  ]) AS sig
  WHERE to_regprocedure(sig) IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00126: signature did not resolve, so its REVOKE did nothing: %', v_bad;
  END IF;

  -- No function touched by this file may remain anon-executable.
  SELECT string_agg(sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.admin_access_level(uuid)',
    'public.admin_console_access(uuid)',
    'public.admins_with_passkeys(uuid,uuid)',
    'public.apply_match_result(uuid,uuid)',
    'public.apply_rating_delta(uuid,text,integer,boolean,integer,integer,integer,integer)',
    'public.check_session_caps(uuid,uuid,text)',
    'public.create_player_with_rating(uuid,text,text,text,text,text,player_status,user_role)',
    'public.dispute_match_result(uuid,dispute_reason,text)',
    'public.has_passkeys(uuid)',
    'public.increment_challenges_issued(uuid)',
    'public.merge_players(uuid,uuid,uuid)',
    'public.merge_players_preview(uuid,uuid)',
    'public.pair_tournament_entrants(uuid,uuid,uuid,text,integer,uuid)',
    'public.platform_setting_bool(text,text,boolean)',
    'public.platform_setting_int(text,text,integer)',
    'public.platform_setting_numeric(text,text,numeric)',
    'public.session_cap_for(text)',
    'public.submit_match_result(uuid,jsonb,boolean)',
    'public.swap_tournament_pair_member(uuid,uuid,uuid,text,integer,uuid)',
    'public.unpair_tournament_pair(uuid,uuid,text,uuid)',
    'public.validate_challenge_creation(uuid,uuid,text,uuid,uuid)'
  ]) AS sig
  WHERE has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00126: still EXECUTE-able by anon: %', v_bad;
  END IF;

  -- Group B/C/D must be closed to authenticated too.
  SELECT string_agg(sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.admins_with_passkeys(uuid,uuid)',
    'public.apply_rating_delta(uuid,text,integer,boolean,integer,integer,integer,integer)',
    'public.check_session_caps(uuid,uuid,text)',
    'public.increment_challenges_issued(uuid)',
    'public.merge_players(uuid,uuid,uuid)',
    'public.merge_players_preview(uuid,uuid)',
    'public.pair_tournament_entrants(uuid,uuid,uuid,text,integer,uuid)',
    'public.session_cap_for(text)',
    'public.swap_tournament_pair_member(uuid,uuid,uuid,text,integer,uuid)',
    'public.unpair_tournament_pair(uuid,uuid,text,uuid)'
  ]) AS sig
  WHERE has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00126: still EXECUTE-able by authenticated: %', v_bad;
  END IF;

  -- The kept grants are as load-bearing as the revoked ones. If one of these
  -- were dropped by accident the app would break at runtime, not here, so
  -- assert them: group A needs authenticated, the RLS helpers need it in every
  -- policy that names them, and the three public readers need anon.
  SELECT string_agg(sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.admin_access_level(uuid)',
    'public.admin_console_access(uuid)',
    'public.apply_match_result(uuid,uuid)',
    'public.create_player_with_rating(uuid,text,text,text,text,text,player_status,user_role)',
    'public.dispute_match_result(uuid,dispute_reason,text)',
    'public.has_passkeys(uuid)',
    'public.platform_setting_bool(text,text,boolean)',
    'public.platform_setting_int(text,text,integer)',
    'public.platform_setting_numeric(text,text,numeric)',
    'public.submit_match_result(uuid,jsonb,boolean)',
    'public.validate_challenge_creation(uuid,uuid,text,uuid,uuid)',
    'public.get_player_id(uuid)',
    'public.is_admin(uuid)',
    'public.is_admin_or_coach(uuid)',
    'public.session_checkin_open(uuid)'
  ]) AS sig
  WHERE NOT has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00126: lost a required authenticated grant: %', v_bad;
  END IF;

  SELECT string_agg(sig, ', ') INTO v_bad
  FROM unnest(ARRAY[
    'public.get_active_season()',
    'public.get_executives()',
    'public.get_leaderboard()'
  ]) AS sig
  WHERE NOT has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '00126: lost a required anon grant on a public reader: %', v_bad;
  END IF;
END $$;

COMMIT;

-- ============================================================
-- WHAT AN ATTACKER CAN STILL DO AFTERWARDS
-- ============================================================
-- With nothing but the anon key from the bundle:
--   * get_leaderboard(), get_active_season(), get_executives() — deliberately
--     public. get_leaderboard exposes every player's display name, handle,
--     avatar, status, both Elo ratings, W/L and streaks; the landing page at
--     apps/player/src/app/page.tsx renders it logged out, so this is by design.
--   * is_admin(uuid) and is_admin_or_coach(uuid) — a yes/no oracle over
--     arbitrary auth user ids. Kept because RLS policies call them; see (2).
--     Enumeration needs an auth.users id, which is not otherwise disclosed.
--   * get_player_id(uuid) — maps an auth user id to a player id, same caveat.
--   * session_checkin_open(uuid) — whether a session is open for check-in.
--   * Every trigger function's grant, which is not callable.
--
-- With any signed-in account, INCLUDING one still in pending_approval:
--   * platform_setting_bool/_int/_numeric — reads ANY key in platform_settings
--     past its admin-only RLS, one key at a time, if the section and key names
--     are guessed. Today that is fee amounts, caps and expiry windows, not
--     credentials. THIS IS THE MAIN THING LEFT OPEN, and it is left open
--     because challenges.expires_at DEFAULTs through platform_setting_int. If a
--     secret is ever stored in platform_settings, this becomes a real leak and
--     the fix is to move the challenge expiry out of a column default and then
--     revoke authenticated here too.
--   * validate_challenge_creation — status, banned flag, Elo and ladder
--     position of arbitrary player ids, past RLS. Not revoked from
--     authenticated because it is the player-facing pre-flight; the data is
--     largely on the leaderboard anyway, minus the banned flag.
--   * admin_access_level / admin_console_access / has_passkeys — still answer
--     for ANY user id, not just the caller's. Each is called with the session's
--     own id everywhere in both apps, so adding `p_user_id = auth.uid() OR
--     is_admin(auth.uid())` would be a tightening with no app change. Not done
--     here: this file is about grants, and those are three SECURITY DEFINER
--     body rewrites.
--   * apply_match_result — the participant and submitter guards DO bind an
--     authenticated caller, so what remains is the legitimate confirm path.
--
-- WITH THE SERVICE-ROLE KEY everything above is moot; that key was already
-- total authority and this file does not change that. It is only ever read
-- server-side (SUPABASE_SERVICE_ROLE_KEY, no NEXT_PUBLIC_ prefix).
--
-- ============================================================
-- FOUND, NOT FIXED
-- ============================================================
-- 1. THE ROOT CAUSE SURVIVES. Supabase's ALTER DEFAULT PRIVILEGES for schema
--    public is untouched, so the NEXT function created here inherits
--    `anon=X, authenticated=X` all over again, and the next migration author
--    has to remember this file. The durable fix is
--      ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS
--        FROM anon, authenticated;
--    which would flip the default from open to closed and make every future
--    RPC opt in with an explicit GRANT. Not done here: it changes the meaning
--    of every subsequent CREATE FUNCTION in the repo, including ones written by
--    Supabase's own tooling, and that belongs in a migration whose only job it
--    is. 00123:750 shows the per-function shape to use in the meantime
--    (REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT TO service_role).
--
-- 2. THE ANON KEY REACHES FAR MORE THAN FUNCTIONS. `anon` holds
--    SELECT/INSERT/UPDATE/DELETE table grants on 41 tables in public, including
--    players (UPDATE, DELETE), platform_settings, audit_logs and
--    passkey_credentials. Every one of those tables has relrowsecurity = true
--    and no policy admitting the anon role, so RLS is what is actually holding
--    the line — the table grants are a second copy of the same default-privilege
--    mistake. Nothing is exploitable today, but the schema is one
--    `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` or one policy written
--    `TO public` away from being wide open, with no grant left to catch it.
--    Worth its own audit.
--
-- 3. NOT AUDITED HERE: the 20-odd SECURITY INVOKER functions that are also
--    anon-executable (calculate_elo_update, club_local_instant, format_*,
--    recompute_head_to_head_pair, update_head_to_head, ...). They run with the
--    CALLER's privileges, so they can do nothing the caller could not do
--    directly and are not a privilege hole. Two of the mutating ones
--    (recompute_head_to_head_pair, recompute_partnership_pair, both recreated
--    SECURITY INVOKER by 00123) write to head_to_head_stats and
--    partnership_stats, whose RLS admits only admins — checked, and the reason
--    they are safe. If either is ever converted to SECURITY DEFINER it must be
--    revoked in the same breath.
-- ============================================================
