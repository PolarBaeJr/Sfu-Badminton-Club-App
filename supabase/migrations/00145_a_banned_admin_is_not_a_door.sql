-- ============================================================
-- 00145 — a banned admin is not a door either
-- ============================================================
-- THE NUMBER. The 2026-08-17 fix list's migration table says "No 00143 or
-- 00145 — the notifications and realtime findings are app-layer", so 00145 is
-- an unclaimed gap rather than a collision, and it sorts below 00146 (the
-- merge_players guard) which it has no dependency on. Either order is fine.
--
-- APPLY ORDER AGAINST THE APP: FREE, but the app is incomplete without this.
-- banPlayer now refuses to ban the last passkey-holding admin and counts
-- through admins_with_passkeys() — the same function the triggers here call.
-- Until this file lands that count includes admins who are ALREADY BANNED, so
-- the app check is right in the one-admin case and wrong in the two-admins-one-
-- already-banned case. Nothing breaks either way; the guard is simply weaker
-- than it reads until this is applied.
--
-- ============================================================
-- WHAT IS BROKEN
-- ============================================================
-- 00050 exists to make one sentence true: THERE IS NEVER ZERO ADMINS WHO CAN
-- ACTUALLY GET IN. Its header names the three ways to break it — demoting the
-- last admin, deleting their last passkey, deleting their row — and says why
-- they are triggers rather than checks in a server action:
--
--     "Recovery from any of them is a manual UPDATE against the production
--      database, which is exactly the situation this repo keeps trying not to
--      be in. ... A check in application code is a suggestion; this is the
--      guarantee."
--
-- THERE IS A FOURTH WAY NOW, AND 00140 IS WHAT CREATED IT. When 00050 was
-- written a banned admin still passed is_admin() and still opened the console,
-- so is_banned was not a way of taking a door away and there was nothing to
-- guard. 00140 changed that on purpose, in both places at once:
--
--   * is_admin(uuid) and is_admin_or_coach(uuid) return FALSE for a banned
--     admin — 45 + 3 RLS policies;
--   * requireAdminPlayer (apps/admin/src/lib/supabase-server.ts) refuses them
--     with 'Account suspended pending reinstatement' before a capability is
--     ever resolved.
--
-- So banning the last passkey-holding admin is now a COMPLETE lockout, with
-- exactly the manual-UPDATE recovery 00050's header is about — and
-- `players.ban.write` is EXEC-level, so it is reachable by somebody who was
-- never trusted with the console's own keys. §2 is the arm that closes it.
--
-- §1 IS THE HALF NO APPLICATION CODE CAN REACH, and it is the reason this file
-- exists at all rather than the app fix shipping alone.
--
-- ============================================================
-- §1. admins_with_passkeys() COUNTS A BANNED ADMIN AS A DOOR
-- ============================================================
-- The function (00050, narrowed by 00051 to enrolled_via = 'admin') is:
--
--     SELECT COUNT(DISTINCT p.id) FROM players p
--       JOIN passkey_credentials pc ON pc.player_id = p.id
--      WHERE p.role = 'admin' AND pc.enrolled_via = 'admin' AND ...
--
-- It asks "how many admins hold a passkey", which was the same question as
-- "how many people can open the console" until 00140. It is not any more. With
-- admin A banned and admin B the only other one, the count is 2 excluding
-- nobody and 1 excluding B — so guard_last_admin_role HAPPILY PERMITS demoting
-- or deleting B, and every door is shut with the guard reporting success. That
-- is the existing 00050 guarantee going quietly false as a consequence of
-- 00140, on the two paths 00050 was written for, and no check in banPlayer or
-- anywhere else in the app can see it.
--
-- ONE CLAUSE, NOT 00140's WHOLE PREDICATE. 00140's is_admin gate also tests
-- onboarding_completed, active_flag and status, and folding those in here is
-- deliberately NOT done:
--
--   * this function decides what the DEMOTION and DELETE guards refuse, and
--     tightening it further would start refusing demotions on rows nobody has
--     measured — an admin who is merely inactive is one password reset from
--     being a door again, and locking their colleague's demotion behind that is
--     a new behaviour, not a fix;
--   * a ban is different in kind: it is a moderation decision that is meant to
--     take access away, and 00140 already made it do so everywhere else. This
--     file only stops the door-counter from disagreeing with is_admin() about
--     the one predicate they both now care about.
--   * calling is_admin() from here is not an option either — it takes a
--     user_id, not a player id, and an admin row with no login would stop
--     counting for a reason that has nothing to do with this.
--
-- A MEASURED NO-OP TODAY, by 00140 §3's own count taken on both databases on
-- 2026-08-17: production has 5 privileged rows (2 admin, 3 exec/trainer) and
-- EVERY ONE has is_banned = FALSE, active_flag = TRUE, onboarding_completed =
-- TRUE; staging the same. No live row's count changes. It becomes load-bearing
-- the first time somebody bans an admin, which is what §2 is about.
--
-- ============================================================
-- §2. THE is_banned ARM ON guard_last_admin_role
-- ============================================================
-- Same shape as the demotion arm three lines above it, same message ending, and
-- it guards the TRANSITION rather than the value: FALSE -> TRUE only. Gating on
-- the value would make every ordinary UPDATE against an already-banned admin
-- row raise forever — including reinstatePlayer's own unban, which writes
-- is_banned = FALSE and would otherwise have to get past a guard about banning.
-- updatePlayer's active_flag rule is gated the same way and for the same
-- reason.
--
-- players.is_banned is NOT NULL DEFAULT FALSE (00001), so the two-value test
-- needs no COALESCE.
--
-- WHY BOTH HERE AND IN banPlayer, since the app check is the one an exec
-- actually reads. The trigger is the guarantee — it fires for the service-role
-- console write, for a hand-applied UPDATE during an incident, and for any
-- future bulk or CLI path — but a trigger RAISE arrives at the console as a
-- PostgREST error string with no idea what to do about it. banPlayer's refusal
-- names the remedy ("Give another admin a passkey before banning this one") and
-- is returned as an ActionResult so production does not replace it with "an
-- error occurred". Neither layer is redundant: one is the invariant, the other
-- is the sentence.
--
-- ============================================================
-- §3. MECHANICS — PATCHED IN THE LIVE BODIES, ON 00138 §0's PATTERN
-- ============================================================
-- 00072's house rule for this function class is "always dump the live
-- definition and add to it; never rebuild it from memory", and 00138 §0 is the
-- file that showed why a literal CREATE OR REPLACE is not good enough even when
-- you have the source in this directory: production and staging bodies for
-- merge_players differed by twelve lines, and either literal would have
-- silently reverted one database.
--
-- Neither function here is known to have drifted — 00050 defines both, 00051
-- replaces admins_with_passkeys once, and 00105/00126 both record
-- guard_last_admin_role as unchanged — but "not known to have drifted" is
-- exactly the assumption that made 00138 necessary, and the patch costs nothing
-- to write this way. Both substitutions therefore:
--
--   * refuse unless the anchor occurs EXACTLY ONCE in the live body;
--   * return early and untouched if the new text is already there (idempotent);
--   * re-read pg_get_functiondef afterwards to prove the change landed in the
--     LIVE body rather than in a local string.
--
-- CREATE OR REPLACE of an existing function does not re-mint its ACL, so
-- 00126's `REVOKE ... FROM PUBLIC, anon, authenticated` / `GRANT ... TO
-- service_role` on admins_with_passkeys survives. §4 re-asserts it anyway, so a
-- future edit that reaches for DROP + CREATE is caught here rather than by an
-- anonymous caller counting the club's admins.
--
-- ONE TRANSACTION. A half-applied state would be a counter that excludes banned
-- admins with no arm using it, or an arm that trusts a counter that still
-- includes them — the second of which reads as protection and is not.
-- ============================================================

BEGIN;

-- ---- §1. admins_with_passkeys stops counting banned admins ----
DO $count_fix$
DECLARE
  v_def    text;
  v_old    text := E'WHERE p.role = \'admin\'';
  v_new    text := E'WHERE p.role = \'admin\'\n    AND p.is_banned = FALSE';
  v_hits   integer;
  v_newdef text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'admins_with_passkeys'
     AND p.pronargs = 2;

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      '00145 §1: public.admins_with_passkeys(uuid,uuid) is not present. 00050/00051 must be applied first.';
  END IF;

  IF position('p.is_banned' in v_def) > 0 THEN
    RAISE NOTICE '00145 §1: admins_with_passkeys already excludes banned admins; leaving it alone.';
  ELSE
    -- 00051's narrowing must be in the body being patched. Without it this file
    -- would be hardening the wrong function: 00051 exists because counting
    -- player-enrolled passkeys "would defend a credential that no longer gates
    -- anything", and a body missing that clause is a pre-00051 database.
    IF position('enrolled_via' in v_def) = 0 THEN
      RAISE EXCEPTION
        '00145 §1: the live admins_with_passkeys body has no enrolled_via clause, so 00051 is not applied. Apply it first.';
    END IF;

    v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION
        '00145 §1: expected exactly 1 occurrence of "%" in the live admins_with_passkeys body, found %. Refusing to patch — dump pg_get_functiondef and do it by hand.',
        v_old, v_hits;
    END IF;

    v_newdef := replace(v_def, v_old, v_new);
    EXECUTE v_newdef;

    SELECT pg_get_functiondef(p.oid)
      INTO v_def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'admins_with_passkeys'
       AND p.pronargs = 2;

    IF position('p.is_banned = FALSE' in v_def) = 0 THEN
      RAISE EXCEPTION '00145 §1: the replacement did not land in the live admins_with_passkeys body.';
    END IF;
  END IF;
END
$count_fix$;

COMMENT ON FUNCTION public.admins_with_passkeys(UUID, UUID) IS
  'Number of role=admin players who are NOT banned and hold an admin-enrolled passkey, optionally excluding a credential or player about to be removed. The is_banned clause is 00145: since 00140 a banned admin fails is_admin() and cannot open the console, so counting one as a door let guard_last_admin_role permit the demotion or deletion of the last admin who could.';

-- ---- §2. guard_last_admin_role also refuses a ban ----
DO $ban_arm$
DECLARE
  v_def    text;
  v_old    text := 'RETURN NEW;';
  -- Built with explicit || and E'\n' rather than as one multi-line literal:
  -- adjacent string constants are concatenated by the parser, but the E prefix
  -- does NOT carry across them, so a continuation line's \n would land in the
  -- function body as a literal backslash-n.
  v_new    text :=
       '-- Banning. THE FOURTH WAY, and the only one an exec can reach.'                              || E'\n'
    || '    -- players.ban.write is exec-level, and since 00140 a banned admin fails'                 || E'\n'
    || '    -- is_admin() (45 RLS policies) and is refused by requireAdminPlayer, so'                  || E'\n'
    || '    -- a ban now takes a door away exactly as a demotion does. The TRANSITION'                 || E'\n'
    || '    -- is guarded, not the value: gating on NEW.is_banned alone would raise on'                || E'\n'
    || '    -- every later UPDATE against an already-banned admin, the unban included.'                || E'\n'
    || '    IF OLD.role = ''admin'' AND NEW.is_banned AND NOT OLD.is_banned'                           || E'\n'
    || '       AND admins_with_passkeys(p_excluding_player => OLD.id) = 0'                             || E'\n'
    || '    THEN'                                                                                      || E'\n'
    || '      RAISE EXCEPTION ''This is the only admin with a passkey. Give another admin a passkey before banning this one.'''
                                                                                                       || E'\n'
    || '        USING ERRCODE = ''check_violation'';'                                                  || E'\n'
    || '    END IF;'                                                                                   || E'\n'
    || E'\n'
    || '    RETURN NEW;';
  v_hits   integer;
  v_newdef text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'guard_last_admin_role'
     AND p.pronargs = 0;

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      '00145 §2: public.guard_last_admin_role() is not present. 00050 must be applied first.';
  END IF;

  IF position('before banning this one' in v_def) > 0 THEN
    RAISE NOTICE '00145 §2: guard_last_admin_role already carries the ban arm; leaving it alone.';
    RETURN;
  END IF;

  -- The body must still be the one this arm is being fitted to. Both existing
  -- RAISEs are checked, because the arm below sits between them: a body missing
  -- either has been rewritten by something this file has not seen.
  IF position('before demoting this one' in v_def) = 0
     OR position('before deleting this account' in v_def) = 0 THEN
    RAISE EXCEPTION
      '00145 §2: the live guard_last_admin_role body is not 00050''s — one of the demote/delete refusals is missing. Dump pg_get_functiondef and fit the ban arm by hand.';
  END IF;

  -- `RETURN NEW;` is the UPDATE branch's exit and occurs once; the DELETE branch
  -- ends `RETURN OLD;`. Anchoring on it inserts the arm after every existing
  -- UPDATE check and before the trigger returns, with one anchor and no brace
  -- matching. A second occurrence means a branch was added and a person should
  -- decide where this goes.
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      '00145 §2: expected exactly 1 occurrence of "%" in the live guard_last_admin_role body, found %. Refusing to patch — dump pg_get_functiondef and do it by hand.',
      v_old, v_hits;
  END IF;

  v_newdef := replace(v_def, v_old, v_new);
  EXECUTE v_newdef;

  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'guard_last_admin_role'
     AND p.pronargs = 0;

  IF position('before banning this one' in v_def) = 0 THEN
    RAISE EXCEPTION '00145 §2: the ban arm did not land in the live guard_last_admin_role body.';
  END IF;
END
$ban_arm$;

-- The trigger itself is untouched: trg_guard_last_admin_role is already
-- BEFORE UPDATE OR DELETE ON players FOR EACH ROW (00050), so the new arm is
-- live the moment the function is replaced. Re-creating it would only risk
-- losing an ordering or a WHEN clause somebody added since.

-- ---- §3. Re-assert 00126's grants ----
-- CREATE OR REPLACE preserves them, so these are no-ops today. They are here so
-- that a future edit which reaches for DROP + CREATE fails this file's own
-- assertion instead of quietly handing an anonymous caller a way to count the
-- club's admins — which is the state 00126 found and closed.
REVOKE EXECUTE ON FUNCTION public.admins_with_passkeys(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admins_with_passkeys(uuid, uuid) TO service_role;

-- ---- §4. Prove the file did what it says ----
DO $assert$
DECLARE
  v_count text;
  v_guard text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admins_with_passkeys' AND p.pronargs = 2;
  SELECT pg_get_functiondef(p.oid) INTO v_guard
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_last_admin_role' AND p.pronargs = 0;

  IF position('p.is_banned = FALSE' in v_count) = 0 THEN
    RAISE EXCEPTION '00145: admins_with_passkeys still counts banned admins.';
  END IF;
  -- 00051's clause must have survived the patch. This is the assertion that
  -- would have caught a rebuilt-from-memory body.
  IF position('enrolled_via' in v_count) = 0 THEN
    RAISE EXCEPTION '00145: the patched admins_with_passkeys lost 00051''s enrolled_via clause.';
  END IF;
  IF position('before banning this one' in v_guard) = 0
     OR position('before demoting this one' in v_guard) = 0
     OR position('before deleting this account' in v_guard) = 0 THEN
    RAISE EXCEPTION '00145: guard_last_admin_role does not carry all three refusals.';
  END IF;

  -- The trigger must actually be attached, or none of the above matters.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.players'::regclass
       AND t.tgname = 'trg_guard_last_admin_role'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '00145: trg_guard_last_admin_role is not attached to players.';
  END IF;

  RAISE NOTICE '00145: banned admins no longer count as doors, and a ban is refused on the last one.';
END
$assert$;

COMMIT;
