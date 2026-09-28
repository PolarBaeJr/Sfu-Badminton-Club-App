-- ============================================================
-- 00262 A CONSOLE PASSKEY IS REQUIRED AFTER TWO WEEKS
--
-- The console has two passkey tiers (00051): only a credential enrolled
-- through the admin console arms its gate. Until now a console user with no
-- console passkey was in an open-ended grace period: the console opened on an
-- email code alone, for as long as they never enrolled one. This file puts an
-- end date on it.
--
-- WHAT THIS FILE ADDS:
--   1. console_passkey_grace: one row per auth user, the moment they first
--      opened the console without a console passkey. Only the START is stored.
--      The length (14 days) lives in apps/admin/src/lib/passkey/grace.ts, the
--      one place the middleware, the server-action check, the banner and
--      Settings all read it from.
--   2. console_passkey_grace_start(): called by the middleware on every
--      console request that has no fresh verified cookie. Answers whether the
--      caller holds a console passkey and, if not, when their window started,
--      writing the row on the first call. It takes no argument, so unlike
--      has_passkeys(uuid) it cannot be pointed at another user.
--   3. reset_console_passkey_grace: a trigger on players that deletes the row
--      when the person loses console access (role admin, is_exec and
--      is_trainer all gone), when the row's login changes, or when the row is
--      deleted. A later promotion starts a fresh 14 days. This is the one place
--      that sees every writer: the console actions, merge_players and hand SQL.
--
-- DELIBERATELY NOT HERE:
--   - No foreign key to players, so merge_players and the 00207/00242
--     classification are untouched. No foreign key to auth.users either: a
--     cascade into the auth schema can break the staging snapshot refresh or a
--     partial restore. passkey_challenges (00181) is the precedent. A stale row
--     for a deleted auth user is a harmless timestamp.
--   - No new players column, so the privilege-escalation guard is untouched.
--   - No backfill. Every current console user without a console passkey gets
--     a row on their first console request after this ships, so everyone has
--     14 days from the deploy.
--   - Ban, suspend and inactivity do NOT reset the window, so a ban and unban
--     cannot buy more time.
--   - has_passkeys(uuid) stays, so rolling back the admin image stays safe.
--
-- CONSEQUENCE: someone whose window has ended and who later deletes every
-- console passkey is sent straight to /passkey-required on the next request
-- and must enrol again.
--
-- RESET BY HAND (owner-run SQL), for someone locked out with no device that
-- can hold a passkey:
--   DELETE FROM public.console_passkey_grace WHERE user_id = '<auth uuid>';
-- Demoting and re-promoting them does the same.
--
-- PRECONDITION: admin_access_level(uuid) and passkey_credentials.enrolled_via
-- (00051).
-- ============================================================

BEGIN;

-- 0. PRECONDITION -----------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.admin_access_level(uuid)') IS NULL THEN
    RAISE EXCEPTION '00262: admin_access_level(uuid) is missing';
  END IF;
  IF to_regclass('public.passkey_credentials') IS NULL THEN
    RAISE EXCEPTION '00262: passkey_credentials is missing';
  END IF;
END
$pre$;

-- 1. TABLE ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.console_passkey_grace (
  user_id    uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.console_passkey_grace ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.console_passkey_grace FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.console_passkey_grace TO service_role;

COMMENT ON TABLE public.console_passkey_grace IS
  'When each console user first opened the admin console without a console passkey (00262). The window length is in apps/admin/src/lib/passkey/grace.ts. Written only by console_passkey_grace_start(); deleted by reset_console_passkey_grace when console access is lost.';

-- 2. THE GATE'S ONE CALL ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.console_passkey_grace_start()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_has     boolean;
  v_started timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- The same predicate as has_passkeys (00051): only a console enrolment arms
  -- the gate.
  v_has := EXISTS (
    SELECT 1
      FROM passkey_credentials pc
      JOIN players p ON p.id = pc.player_id
     WHERE p.user_id = v_uid
       AND pc.enrolled_via = 'admin'
  );
  IF v_has THEN
    RETURN jsonb_build_object('has_console_passkey', true, 'grace_started_at', NULL);
  END IF;

  -- No row is written for someone without console access.
  IF public.admin_access_level(v_uid) IS NULL THEN
    RETURN jsonb_build_object('has_console_passkey', false, 'grace_started_at', NULL);
  END IF;

  -- Read before writing, so once the row exists the per-request path writes
  -- nothing.
  SELECT started_at INTO v_started FROM console_passkey_grace WHERE user_id = v_uid;
  IF NOT FOUND THEN
    INSERT INTO console_passkey_grace (user_id) VALUES (v_uid)
      ON CONFLICT (user_id) DO NOTHING;
    SELECT started_at INTO v_started FROM console_passkey_grace WHERE user_id = v_uid;
  END IF;

  RETURN jsonb_build_object('has_console_passkey', false, 'grace_started_at', v_started);
END;
$function$;

REVOKE ALL ON FUNCTION public.console_passkey_grace_start() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.console_passkey_grace_start() TO authenticated;

-- 3. RESET ON LOSING CONSOLE ACCESS -----------------------------------------
CREATE OR REPLACE FUNCTION public.reset_console_passkey_grace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.user_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE'
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR (
       (OLD.role = 'admin' OR COALESCE(OLD.is_exec, false) OR COALESCE(OLD.is_trainer, false))
       AND NOT (NEW.role = 'admin' OR COALESCE(NEW.is_exec, false) OR COALESCE(NEW.is_trainer, false))
     ) THEN
    DELETE FROM public.console_passkey_grace WHERE user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.reset_console_passkey_grace() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS reset_console_passkey_grace_trg ON public.players;
CREATE TRIGGER reset_console_passkey_grace_trg
  AFTER UPDATE OF role, is_exec, is_trainer, user_id OR DELETE ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.reset_console_passkey_grace();

-- 4. VERIFY -----------------------------------------------------------------
DO $verify$
DECLARE
  v_fn  text := 'public.console_passkey_grace_start()';
  v_acl text;
  v_def boolean;
  v_cfg text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.console_passkey_grace'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION '00262: console_passkey_grace is missing or has no row level security';
  END IF;
  IF has_table_privilege('anon', 'public.console_passkey_grace', 'SELECT')
     OR has_table_privilege('authenticated', 'public.console_passkey_grace', 'SELECT') THEN
    RAISE EXCEPTION '00262: anon or authenticated can read console_passkey_grace';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.console_passkey_grace', 'SELECT') THEN
    RAISE EXCEPTION '00262: service_role cannot read console_passkey_grace';
  END IF;

  SELECT prosecdef, proconfig, coalesce(proacl::text, '') INTO v_def, v_cfg, v_acl
    FROM pg_proc WHERE oid = v_fn::regprocedure;
  IF NOT v_def THEN
    RAISE EXCEPTION '00262: % is not SECURITY DEFINER', v_fn;
  END IF;
  IF v_cfg IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_cfg)) THEN
    RAISE EXCEPTION '00262: % has no pinned search_path: %', v_fn, v_cfg;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00262: anon can execute %', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00262: authenticated cannot execute %', v_fn;
  END IF;
  IF v_acl = '' OR v_acl ~ '(^|[{,])=X' THEN
    RAISE EXCEPTION '00262: PUBLIC can execute %: %', v_fn, v_acl;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.players'::regclass
       AND tgname = 'reset_console_passkey_grace_trg'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '00262: reset_console_passkey_grace_trg is missing on players';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
