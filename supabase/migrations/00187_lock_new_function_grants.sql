-- 00187 — the twelve functions added by 00178-00185 were reachable by `anon`.
--
-- WHAT WENT WRONG. Every one of those migrations wrote
--     REVOKE ALL ON FUNCTION public.f(...) FROM PUBLIC;
--     GRANT  EXECUTE ON FUNCTION public.f(...) TO service_role;
-- which reads as "service role only" and is not. 00126 already wrote this
-- lesson down, at 00126:10-18, and it is worth repeating in full rather than
-- referenced, because the wrong form is the one that looks right:
--
--     Supabase runs, on every project:
--       ALTER DEFAULT PRIVILEGES IN SCHEMA public
--         GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--
-- so a freshly created function does NOT get proacl = NULL (the PUBLIC
-- default). It gets EXPLICIT entries `anon=X/postgres` and
-- `authenticated=X/postgres`. Revoking PUBLIC removes the `=X/postgres` entry
-- and NOTHING ELSE. Both explicit entries survive.
--
-- Measured on staging immediately after 00177-00186 were applied — all twelve:
--     apply_placement_bonus :: postgres=X | anon=X | authenticated=X | service_role=X
--
-- WHY IT IS SEV-1 AND NOT UNTIDY. Eight of the twelve are service-role-only by
-- design and take the identity they act as AS A PARAMETER, which is 00126's
-- impersonation shape. Reachable by `anon` over PostgREST that means, with no
-- session at all:
--   * apply_placement_bonus(p_player_id, ...)   — arbitrary rating movement
--   * resolve_dispute_rated(..., p_admin_id)    — resolve a dispute as any admin
--   * reject_walkover_atomic(..., p_admin_id)   — same, attributed to any admin
--   * merge_notification_preferences_by_email() — unsubscribe any member by email
--   * issue_passkey_challenge(...)              — mint/reset a passkey challenge,
--                                                 which defeats 00181's whole point
--   * enter_tournament_event(p_player_id, ...)  — register anybody
--
-- And enter_tournament_event's own actor guard does not save it. It reads
--     IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id
-- so for `anon`, where auth.uid() IS NULL, THE GUARD IS SKIPPED ENTIRELY.
-- 00126:543-553 describes that exact trap for apply_match_result. The guard is
-- correct only once the grant is; the grant is the control, not the guard.
--
-- HOW THIS ONE IS WRITTEN DIFFERENTLY. Signatures are resolved from the
-- catalogue rather than retyped, because retyping a twelve-argument signature
-- is how a REVOKE silently targets nothing. Then it ASSERTS the end state and
-- raises if any row is wrong — a grant migration that cannot fail is a grant
-- migration that proves nothing.

BEGIN;

DO $lock$
DECLARE
  -- service_role ONLY. Every one of these takes an actor or a target as a
  -- parameter and trusts its caller to be the server.
  v_service_only TEXT[] := ARRAY[
    'resolve_dispute_rated',
    'claim_dispute_for_resolution',
    'apply_placement_bonus',
    'merge_notification_preferences_by_email',
    'issue_passkey_challenge',
    'consume_passkey_challenge',
    'reject_walkover_atomic',
    'enter_tournament_event'
  ];
  -- Reachable by a signed-in member on purpose. All four resolve the actor from
  -- get_player_id(auth.uid()) and take no player id.
  v_member_callable TEXT[] := ARRAY[
    'merge_my_notification_preferences',
    'create_challenge_atomic',
    'respond_to_challenge',
    'report_walkover_atomic'
  ];
  v_all      TEXT[] := v_service_only || v_member_callable;
  r          RECORD;
  v_seen     TEXT[] := ARRAY[]::TEXT[];
  v_missing  TEXT[];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY(v_all)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    IF r.proname = ANY(v_member_callable) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
    v_seen := v_seen || r.proname;
  END LOOP;

  -- A REVOKE that matched nothing is the failure mode this migration exists to
  -- prevent, so absence is an error rather than a no-op.
  SELECT array_agg(f) INTO v_missing
    FROM unnest(v_all) AS f
   WHERE f <> ALL(v_seen);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '00187: expected functions not found in public: %', v_missing;
  END IF;
END
$lock$;

-- THE ASSERTION. Read back what the catalogue actually holds. has_function_privilege
-- is the right question here (it is the same question PostgREST's role asks), and
-- it is asked per role rather than by parsing proacl.
DO $verify$
DECLARE
  r     RECORD;
  v_bad TEXT := '';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname,
           has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_x,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
           has_function_privilege('service_role',  p.oid, 'EXECUTE') AS svc_x
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY(ARRAY[
             'resolve_dispute_rated','claim_dispute_for_resolution',
             'apply_placement_bonus','merge_notification_preferences_by_email',
             'issue_passkey_challenge','consume_passkey_challenge',
             'reject_walkover_atomic','enter_tournament_event',
             'merge_my_notification_preferences','create_challenge_atomic',
             'respond_to_challenge','report_walkover_atomic'])
  LOOP
    -- anon must hold nothing, anywhere in this set.
    IF r.anon_x THEN
      v_bad := v_bad || format('%s still executable by anon; ', r.sig);
    END IF;
    IF NOT r.svc_x THEN
      v_bad := v_bad || format('%s not executable by service_role; ', r.sig);
    END IF;
    IF r.proname IN ('merge_my_notification_preferences','create_challenge_atomic',
                     'respond_to_challenge','report_walkover_atomic') THEN
      IF NOT r.auth_x THEN
        v_bad := v_bad || format('%s should be member-callable but is not; ', r.sig);
      END IF;
    ELSIF r.auth_x THEN
      v_bad := v_bad || format('%s still executable by authenticated; ', r.sig);
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION '00187 verification failed: %', v_bad;
  END IF;
  RAISE NOTICE '00187: all twelve functions verified — anon holds nothing.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
