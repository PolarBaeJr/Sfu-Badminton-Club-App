-- 00217 — the last anon-executable mutator loses a grant it never used
--
-- WHAT THIS IS, stated plainly so nobody later reads it as bigger than it is:
-- this is defence in depth, NOT the closure of a live hole. consume_discord_link_token
-- opens its body with
--
--     IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
--
-- so an anonymous caller who reaches it learns nothing and changes nothing. The
-- reason to take the grant away anyway is that this is a SECURITY DEFINER
-- MUTATOR — it consumes a single-use token and writes player_discord_links,
-- executing as postgres, outside the caller's RLS — and it is reachable by an
-- unauthenticated role. That combination is one edit to one guard away from
-- being a real hole, and the guard is a line in a function body rather than a
-- privilege the database enforces. Grants are the durable half.
--
-- It is the last of the nine anon-executable SECURITY DEFINER functions that
-- was worth deciding about. Of the other eight:
--   - is_admin(uuid) and get_player_id(uuid) are closed by 00208.
--   - get_active_season, get_executives, get_leaderboard back the public
--     landing, /exec and /leaderboard pages, plus the two health routes, all of
--     which the middleware matcher excludes and which therefore genuinely
--     execute as anon. Their anon grant is load-bearing.
--   - is_admin_or_coach and session_checkin_open are named in RLS policies
--     (00005_rls.sql:319-327, 00008_richer_attendance.sql:91). RLS is evaluated
--     against the CALLER, so revoking EXECUTE from anon breaks the policy, not
--     just the direct call. 00140:270-288 raises if either loses it.
--   - get_session_attendee_counts backs a pre-login view.
-- Reads that back pre-login pages stay. The one mutator goes.
--
-- THE TRAP, the same one 00208 documents: 00165:274 already ran
--   REVOKE ALL ON FUNCTION public.consume_discord_link_token(text) FROM PUBLIC;
-- and it changed nothing, because Supabase ships
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, ...
-- which creates an EXPLICIT anon entry, not a PUBLIC one. The live prod ACL is
--   {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- — the revoke from PUBLIC left anon=X standing while the ACL read as though it
-- had been dealt with. Both halves have to be named.
--
-- WHAT KEEPS WORKING, checked rather than assumed:
--   - The sole call site is apps/player/src/app/link/[token]/actions.ts:39, a
--     server action that returns 'Please sign in first' unless getUser() yields
--     a user. It has never been reachable by an anonymous caller.
--   - No RLS policy names this function (grepped: the only SQL references are
--     its own DROP/CREATE/REVOKE/GRANT in 00165).
--   - No generated column or trigger body calls it.
--   - authenticated and service_role keep explicit grants, restated below.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.consume_discord_link_token(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.consume_discord_link_token(text) FROM anon;

-- Restated, because a revoke from PUBLIC also strips the implicit grant these
-- roles would otherwise inherit. authenticated already held one explicitly
-- (00165:275); service_role is named so the bot's own path is a property of
-- this migration rather than of Supabase's defaults.
GRANT EXECUTE ON FUNCTION public.consume_discord_link_token(text) TO authenticated, service_role;

DO $verify$
DECLARE
  v_anon_priv    BOOLEAN;
  v_auth_priv    BOOLEAN;
  v_svc_priv     BOOLEAN;
  v_anon_denied  BOOLEAN := FALSE;
  v_auth_reached BOOLEAN := FALSE;
  v_acl          TEXT;
BEGIN
  -- (1) The ACL fact. has_function_privilege, not a hand-read of proacl: it
  -- resolves PUBLIC and role inheritance, which is exactly what reading the
  -- ACL string by eye got wrong for years here.
  v_anon_priv := has_function_privilege('anon',          'public.consume_discord_link_token(text)', 'EXECUTE');
  v_auth_priv := has_function_privilege('authenticated', 'public.consume_discord_link_token(text)', 'EXECUTE');
  v_svc_priv  := has_function_privilege('service_role',  'public.consume_discord_link_token(text)', 'EXECUTE');

  IF v_anon_priv THEN
    RAISE EXCEPTION '00217: anon can still execute consume_discord_link_token(text) — a revoke naming only one of PUBLIC/anon leaves the other standing';
  END IF;
  IF NOT v_auth_priv THEN
    RAISE EXCEPTION '00217: authenticated LOST consume_discord_link_token(text) — every Discord /link would fail';
  END IF;
  IF NOT v_svc_priv THEN
    RAISE EXCEPTION '00217: service_role LOST consume_discord_link_token(text)';
  END IF;

  -- (2) The bare PUBLIC entry, asserted separately. There is none today, but
  -- 00208 exists because that assumption cost a migration once. An empty
  -- grantee before the '=' is PUBLIC.
  SELECT array_to_string(p.proacl, ',') INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'consume_discord_link_token';
  IF v_acl ~ '(^|,)=' THEN
    RAISE EXCEPTION '00217: a PUBLIC grant survives on consume_discord_link_token — acl is %', v_acl;
  END IF;

  -- (3) The behavioural probe, which is the only half that means anything: a
  -- superuser psql bypasses grants entirely, so calling the function as
  -- postgres would succeed no matter what the ACL says. SET ROLE drops that.
  BEGIN
    SET ROLE anon;
    PERFORM * FROM public.consume_discord_link_token('deadbeef');
    RESET ROLE;
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_anon_denied := TRUE;                       -- 42501, refused at the grant
    WHEN OTHERS THEN
      RAISE EXCEPTION '00217: anon reached the function BODY (SQLSTATE %, %) — the grant did not stop it', SQLSTATE, SQLERRM;
  END;
  RESET ROLE;

  IF NOT v_anon_denied THEN
    RAISE EXCEPTION '00217: anon executed consume_discord_link_token without being refused';
  END IF;

  -- The other half. A revoke that also locked out the signed-in app would pass
  -- every check above. As `authenticated` with no JWT, auth.uid() is NULL, so
  -- the function's own first guard fires — and reaching that guard at all is
  -- the proof that EXECUTE survived.
  BEGIN
    SET ROLE authenticated;
    PERFORM * FROM public.consume_discord_link_token('deadbeef');
    RESET ROLE;
    RAISE EXCEPTION '00217: consume_discord_link_token accepted a call with no session — its auth.uid() guard is gone';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION '00217: authenticated was REFUSED consume_discord_link_token — the revoke took the wrong role with it';
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%00217:%' THEN
        RAISE;                                     -- our own assertion, not the function's
      END IF;
      v_auth_reached := TRUE;                      -- 'Not signed in' — body reached
  END;
  RESET ROLE;

  IF NOT v_auth_reached THEN
    RAISE EXCEPTION '00217: authenticated never reached the function body';
  END IF;

  RAISE NOTICE '00217 verified: anon is refused at the grant (42501); authenticated still reaches the body and is stopped by its own auth.uid() guard';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
