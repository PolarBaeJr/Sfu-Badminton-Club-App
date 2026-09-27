-- ============================================================
-- 00258 THE DATA API READER CAN FIND ITS FUNCTIONS
--
-- WHAT IS ADDED: USAGE on schema public for data_api_reader. Nothing else.
--
-- WHY. 00241 gave data_api_reader EXECUTE on its three functions and made it
-- a member of authenticator, but never USAGE on the schema those functions
-- live in. EXECUTE on a function in a schema you cannot use is EXECUTE on
-- nothing: every call through PostgREST answers 42501 "permission denied for
-- schema public", so the data API service can never verify a key and answers
-- 503 to every request. On this stack public's USAGE is granted role by role
-- (anon, authenticated, service_role), not to PUBLIC, so a new role does not
-- inherit it.
--
-- 00241's own NOTICE said the reader "reaches three functions and nothing
-- else". Its checks read privileges with has_function_privilege, which answers
-- the EXECUTE question alone and never asks about the schema. The proof below
-- makes the call for real, as the role.
--
-- WHAT THIS DOES NOT OPEN. USAGE is the right to look names up, not to read
-- anything. data_api_reader still holds no table, view or column privilege,
-- so an invoker function that touches a table still fails for it. What it can
-- now reach beyond its three functions is what PUBLIC holds EXECUTE on: trigger
-- functions, which cannot be called outside a trigger, and the few SECURITY
-- DEFINER read functions anon already reaches with the public anon key. The
-- service sends that anon key on every request anyway, so nothing becomes
-- reachable that was not already.
-- ============================================================

GRANT USAGE ON SCHEMA public TO data_api_reader;

-- The proof: become the role and call the function, the path PostgREST takes.
-- An unknown hash must come back as zero rows, not as a permission error.
DO $proof$
DECLARE
  n integer;
BEGIN
  SET LOCAL ROLE data_api_reader;
  SELECT count(*) INTO n FROM public.data_api_verify_key(repeat('0', 64));
  RESET ROLE;
  IF n <> 0 THEN
    RAISE EXCEPTION '00258: an unknown key hash verified as % rows', n;
  END IF;

  -- Still no table: reading players as the role must be refused.
  BEGIN
    SET LOCAL ROLE data_api_reader;
    PERFORM 1 FROM public.players LIMIT 1;
    RESET ROLE;
    RAISE EXCEPTION '00258: data_api_reader can read public.players';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  RAISE NOTICE '00258 verified: data_api_reader can call data_api_verify_key and still cannot read players.';
END
$proof$;
