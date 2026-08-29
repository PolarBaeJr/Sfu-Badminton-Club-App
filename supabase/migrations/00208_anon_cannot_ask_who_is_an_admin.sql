-- 00208 — two functions that answered questions about other people to nobody
--
-- is_admin(uuid) and get_player_id(uuid) both take a user id as an argument
-- rather than reading auth.uid(), and both are executable by anon. So an
-- unauthenticated caller holding a user id -- which is not a secret; it appears
-- in JWTs, in logs, and in any prior session -- can ask the database whether
-- that person is an admin, and can turn their auth id into their player id.
-- Neither is catastrophic on its own. Both are a straight answer to a question
-- an anonymous caller has no business asking, and is_admin in particular hands
-- an attacker the list of accounts worth attacking.
--
-- THE TRAP THIS MIGRATION EXISTS TO AVOID: the obvious fix is
--   REVOKE EXECUTE ... FROM anon;
-- and on this database that would have changed nothing at all. Both functions
-- carry a PUBLIC grant as well:
--
--   is_admin(p_user_id uuid)  acl= =X/postgres  anon=X/postgres  authenticated=X/postgres ...
--
-- The bare `=X/postgres` is PUBLIC, and PUBLIC includes anon. Revoke the named
-- grant, keep the PUBLIC one, and anon still executes it -- with the ACL now
-- reading as though the hole had been closed. Both grants have to go.
--
-- WHAT KEEPS WORKING, checked rather than assumed:
--   - authenticated and service_role hold explicit grants, which a revoke from
--     PUBLIC does not touch.
--   - 68 RLS policies reference these functions. 67 are scoped to
--     `authenticated`. The one scoped to `public` is on tournament_audit_log,
--     and anon holds no grant on that table, so the policy is never evaluated
--     for anon.
--   - Every other function whose body calls these is either SECURITY DEFINER
--     (executing as postgres, who keeps its grant) or granted to authenticated
--     only. The trigger functions among them cannot be invoked directly by
--     anyone -- Postgres refuses with 0A000.

BEGIN;

REVOKE EXECUTE ON FUNCTION public.is_admin(uuid)      FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_admin(uuid)      FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_player_id(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_player_id(uuid) FROM anon;

-- Restated, because a revoke from PUBLIC also removes the implicit grant these
-- roles would otherwise have inherited. They both had explicit grants already;
-- this makes that a property of the migration rather than of the history.
GRANT EXECUTE ON FUNCTION public.is_admin(uuid)      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_player_id(uuid) TO authenticated, service_role;

DO $verify$
DECLARE
  v_anon_admin BOOLEAN;
  v_anon_pid   BOOLEAN;
  v_auth_admin BOOLEAN;
  v_auth_pid   BOOLEAN;
BEGIN
  -- has_function_privilege is the check, not a read of proacl: it resolves
  -- PUBLIC and role inheritance, which is precisely what a hand-read of the
  -- ACL string got wrong for years here.
  v_anon_admin := has_function_privilege('anon', 'public.is_admin(uuid)', 'EXECUTE');
  v_anon_pid   := has_function_privilege('anon', 'public.get_player_id(uuid)', 'EXECUTE');
  v_auth_admin := has_function_privilege('authenticated', 'public.is_admin(uuid)', 'EXECUTE');
  v_auth_pid   := has_function_privilege('authenticated', 'public.get_player_id(uuid)', 'EXECUTE');

  IF v_anon_admin THEN RAISE EXCEPTION '00208: anon can still execute is_admin(uuid)'; END IF;
  IF v_anon_pid   THEN RAISE EXCEPTION '00208: anon can still execute get_player_id(uuid)'; END IF;

  -- The other half. A revoke that also locked out the signed-in app would pass
  -- the two checks above and break every authenticated request.
  IF NOT v_auth_admin THEN RAISE EXCEPTION '00208: authenticated LOST is_admin(uuid) -- this would break the app'; END IF;
  IF NOT v_auth_pid   THEN RAISE EXCEPTION '00208: authenticated LOST get_player_id(uuid) -- this would break the app'; END IF;

  RAISE NOTICE '00208 verified: anon cannot execute either function; authenticated still can';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
