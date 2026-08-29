-- ===========================================================================
-- 00210 — exec_bio IS NOT A SELF-SERVICE COLUMN
-- ===========================================================================
--
-- 00182 revoked table-wide UPDATE on players from `authenticated` and re-granted
-- twelve named columns. Eleven of them are genuinely self-service. `exec_bio`
-- is not, and it was carried into that list by the shape of the change rather
-- than by a decision about the column.
--
-- WHAT THE COLUMN IS. Since 00130 the officer blurb published on /exec is
-- players.exec_bio, and get_executives() is EXECUTE-able by `anon`
-- (00130:181) — so its contents are public for anybody flagged is_exec.
--
-- WHO IS SUPPOSED TO WRITE IT. updateExecBio (player/src/lib/actions/exec.ts)
-- and nothing else. That action gates on the caller being an exec, and then
-- writes with the SERVICE ROLE, deliberately: its own comment says the gate is
-- the whole authorization and routing through RLS as well would put half the
-- rule in the database and half in the file. It is the only writer of this
-- column in either app.
--
-- WHY THE GRANT IS THEREFORE A HOLE, not redundancy. Because the legitimate
-- writer never uses the caller's JWT, the grant serves no application path at
-- all — it only enables the path nobody wants:
--
--   * players_update_own (00005:54) lets a member UPDATE their own row;
--   * an unqualified UPDATE needs no SELECT grant, so the absence of one on
--     exec_bio (00130 §4a) protects nothing — that lesson cost a false
--     "no gap here" once already, on elo_review;
--   * exec_bio is not among the columns the privileged-field trigger guards
--     (00164:134), so nothing else stands in the way.
--
-- So an ordinary member can PRE-STAGE arbitrary text in a column they are not
-- supposed to be able to touch. It is invisible while they are a member. The
-- day somebody makes them an exec, get_executives() publishes it to anon —
-- and it is published without ever passing the gate that exists precisely to
-- decide what goes on that page. 00130:263 names this exposure itself.
--
-- MEASURED, not reasoned. On staging at 00209, acting as `authenticated` with
-- a non-exec member's own claim (probe self-validated: current_user, auth.uid()
-- matched the subject, and a control write to the granted column `bio`
-- returned 1):
--
--     CONTROL   (bio, granted column): rows=1
--     UNDER TEST (exec_bio)          : rows=1     <-- the member CAN pre-stage
--
-- A NOTE ON THIS MIGRATION'S NUMBER. 00210 was previously a re-derivation of
-- 00182's whole column list, written from production's live ACL. That was
-- duplication and was deleted: prod is 33 migrations behind this release, so
-- its current grants are not the grants this migration lands on. The single
-- column below is the part that was never duplicated — the actual delta.
-- ===========================================================================

REVOKE UPDATE (exec_bio) ON public.players FROM authenticated;

DO $verify$
DECLARE
  v_acl    text;
  v_uid    uuid;
  v_pid    uuid;
  v_n      integer;
  v_who    text;
  v_auth   uuid;
  v_wrote  boolean := FALSE;
BEGIN
  -- (1) THE ACL, read off pg_attribute rather than information_schema, which
  -- reports grants that do not exist.
  SELECT array_to_string(a.attacl, ',') INTO v_acl
    FROM pg_attribute a
   WHERE a.attrelid = 'public.players'::regclass AND a.attname = 'exec_bio';
  IF COALESCE(v_acl, '') LIKE '%authenticated=%' THEN
    RAISE EXCEPTION '00210: authenticated still holds a column grant on exec_bio (%)', v_acl;
  END IF;

  -- (2) THE BEHAVIOUR. An ACL that reads right and a write that still lands is
  -- exactly the failure this migration exists to catch, so the revoke is proved
  -- by attempting the write. Inside a subtransaction: raising restores the role
  -- and discards the control write.
  SELECT p.user_id, p.id INTO v_uid, v_pid
    FROM public.players p
   WHERE p.user_id IS NOT NULL AND COALESCE(p.is_exec, FALSE) = FALSE
   LIMIT 1;

  IF v_pid IS NULL THEN
    RAISE NOTICE '00210: no non-exec member on this database, behavioural half skipped';
  ELSE
    BEGIN
      PERFORM set_config('request.jwt.claims',
        json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, TRUE);
      SET LOCAL ROLE authenticated;

      -- SELF-VALIDATION. Without this the refusal below could just as well mean
      -- the probe never became the member, and would prove nothing.
      SELECT current_user, auth.uid() INTO v_who, v_auth;
      IF v_who <> 'authenticated' OR v_auth IS NULL OR v_auth <> v_uid THEN
        RAISE EXCEPTION 'probe invalid';
      END IF;
      EXECUTE 'UPDATE public.players SET bio = COALESCE(bio, '''') WHERE id = $1' USING v_pid;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'probe invalid';
      END IF;

      BEGIN
        EXECUTE 'UPDATE public.players SET exec_bio = ''probe'' WHERE id = $1' USING v_pid;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN v_wrote := TRUE; END IF;
      EXCEPTION WHEN insufficient_privilege THEN
        v_wrote := FALSE;
      END;

      RAISE EXCEPTION 'rollback probe';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM = 'probe invalid' THEN
        RAISE EXCEPTION '00210: the privilege probe could not act as the member, so it proves nothing';
      END IF;
      IF SQLERRM <> 'rollback probe' THEN RAISE; END IF;
    END;

    IF v_wrote THEN
      RAISE EXCEPTION '00210: an ordinary member can still write exec_bio after the revoke';
    END IF;
  END IF;

  RAISE NOTICE '00210 verified: exec_bio carries no authenticated grant, and a member acting as themselves cannot write it';
END
$verify$;

NOTIFY pgrst, 'reload schema';
