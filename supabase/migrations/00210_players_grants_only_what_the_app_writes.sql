-- ===========================================================================
-- 00210 — players GRANTS ONLY WHAT THE APP WRITES
-- ===========================================================================
--
-- On production, `authenticated` holds a TABLE-WIDE grant on public.players:
--
--   relacl  postgres=arwdDxtm/postgres
--           authenticated=wdm/postgres      <- w = UPDATE, d = DELETE
--           service_role=arwdDxtm/postgres
--
-- plus column SELECT on fifteen columns and a now-redundant column UPDATE on
-- competition_category. The SELECT half is already least-privilege and is left
-- exactly as it is. The `w`, the `d` and the `m` are the problem.
--
--
-- THE `m`, WHICH STAGING COULD NOT HAVE SHOWN ME
-- ----------------------------------------------
-- `m` is MAINTAIN, new in PostgreSQL 17. It is not a data privilege -- it
-- carries VACUUM, ANALYZE, CLUSTER, REINDEX and REFRESH MATERIALIZED VIEW.
-- It is on production and it is NOT on staging, because the 04:00 snapshot
-- rebuilds staging's ACLs and never reproduced it. A REVOKE naming only UPDATE
-- and DELETE would therefore have left `authenticated=m/postgres` on
-- production while every check in this file passed, since has_table_privilege
-- for UPDATE and DELETE cannot see MAINTAIN. That is the same shape of vacuous
-- verification this audit exists to stop, so the `m` is named explicitly.
--
-- It is revoked rather than documented-and-kept. Nothing the app does needs it,
-- and MAINTAIN reaches VACUUM FULL, which takes an ACCESS EXCLUSIVE lock and
-- rewrites the table -- a whole-site stall on the hottest table in the schema.
-- PostgREST only ever issues SELECT/INSERT/UPDATE/DELETE and function calls, so
-- there is no reachable path to it today and this is defence in depth, not a
-- live hole. The REVOKE is version-guarded because the keyword does not parse
-- before 17 and this file should still replay on an older database.
--
--
-- WHAT THE TABLE-WIDE `w` ACTUALLY REACHES
-- ----------------------------------------
-- players_update_own is `USING (user_id = auth.uid()) CHECK (user_id =
-- auth.uid())`, so a member may update THEIR OWN ROW. What they may write on it
-- is then decided entirely by the column grants and by
-- guard_player_privileged_columns, and with a table-wide grant the guard is the
-- only thing left. It blocks 21 columns. It does not block these seventeen:
--
--   ban_reason  banned_at  banned_by  created_at  email  full_name  id
--   inactive_since  inactivity_notice_sent_at  joined_at
--   notification_preferences  passkey_setup  profile_visibility
--   show_activity_status  skill_tier  updated_at  user_id
--
-- Three of those are the ban record. A banned member cannot clear `is_banned`
-- — the guard holds that — but they can blank `ban_reason`, `banned_at` and
-- `banned_by`, which is the only durable account of why. That is exactly the
-- 00164 shape, recorded there about `elo_review`: THE PERSON THE FIELD IS ABOUT
-- IS THE ONE PERSON WITH A MOTIVE TO CLEAR IT, and an unqualified UPDATE
-- reaches it without needing SELECT on the table. `email`, `joined_at` and
-- `member_code`-adjacent identity fields are the same argument in a quieter
-- register.
--
-- No exploit is claimed and none is needed: this is a grant that is wider than
-- any code path uses, on the table that decides who everyone is.
--
--
-- WHAT THE APP ACTUALLY WRITES AS `authenticated`
-- -----------------------------------------------
-- Every other write to players in either app goes through the service role and
-- is unaffected by this migration. Censused rather than assumed — the four
-- call sites that use a browser or user-scoped server client are:
--
--   player/lib/actions/profile.ts:187   first_name, last_name, handle, phone,
--                                       bio, hide_from_leaderboard,
--                                       competition_category
--   player/lib/actions/profile.ts:513   onboarding_completed, first_name,
--                                       last_name, display_name, phone
--   player/lib/actions/sessions.ts:125  last_active_at
--   player/components/AvatarUpload.tsx  avatar_url
--
-- Eleven distinct columns. That is the list below.
--
-- exec_bio IS DELIBERATELY NOT IN IT, even though staging currently grants it.
-- player/lib/actions/exec.ts routes that one write through the service role on
-- purpose and says why at line 65: `authenticated` has no SELECT grant on
-- exec_bio (00130 §4a), so a PostgREST write asking for the row back would 403
-- on the read half. Granting it would re-open a column the club publishes on
-- the exec page to members who hold no office.
--
--
-- DELETE IS REVOKED, AND THAT IS REACHABLE TODAY RATHER THAN THEORETICAL
-- ---------------------------------------------------------------------
-- players_admin is `FOR ALL TO authenticated USING (is_admin(auth.uid()))`, so
-- the `d` is not dead: an admin holding a browser session can delete any player
-- row over PostgREST. Nothing in either app does — censused, there is no
-- .delete() on players in application code at all; the console's removals run
-- as the service role, and merge_players and the deletion-request flow are
-- SECURITY DEFINER. So this revoke removes a capability nothing uses and
-- leaves every admin path working.
--
--
-- WHY COLUMN GRANTS AND NOT A NARROWER POLICY
-- -------------------------------------------
-- A policy decides which ROWS. Only a column grant decides which COLUMNS, and
-- the columns are the whole question here — the row is already correctly
-- restricted to the member's own. This is also why guard_player_privileged_columns
-- stays exactly as it is: after this migration the guard and the grants are two
-- independent statements of the same rule, and 00164's lesson is that a single
-- one of them is what fails.
--
-- Triggers are unaffected. set_updated_at writes NEW.updated_at from inside a
-- BEFORE trigger, and column privileges are checked against the columns the
-- STATEMENT names, not the ones a trigger sets — verified below rather than
-- asserted.
-- ===========================================================================

BEGIN;

-- The table-wide UPDATE and DELETE. REVOKE names the privileges rather than
-- ALL, so the column SELECT grants and anything else already held are left
-- untouched.
REVOKE UPDATE, DELETE ON TABLE public.players FROM authenticated;

-- And MAINTAIN, which only exists to revoke from PostgreSQL 17 onwards.
DO $maintain$
BEGIN
  IF current_setting('server_version_num')::INT >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE public.players FROM authenticated';
  END IF;
END
$maintain$;

-- The eleven the app writes. competition_category is restated rather than left
-- to the grant it already has, so the whole list is one statement somebody can
-- read against the census above.
GRANT UPDATE (
  first_name,
  last_name,
  display_name,
  handle,
  phone,
  bio,
  avatar_url,
  hide_from_leaderboard,
  competition_category,
  onboarding_completed,
  last_active_at
) ON TABLE public.players TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
-- Behavioural. has_column_privilege for the shape, and then a real UPDATE as
-- `authenticated` for the things a privilege bit does not answer: whether the
-- statement parses at all, and whether the updated_at trigger needs a grant it
-- no longer has.
--
-- `WHERE false` throughout. A column-privilege failure is raised when the
-- statement is permission-checked, before any row is considered, so a probe
-- that matches nothing still distinguishes granted from revoked — and it
-- cannot touch a single member row on the way.
--
-- AND THE ASSIGNED VALUE IS A LITERAL, NOT THE COLUMN ITSELF. `SET bio = bio`
-- READS bio, so it needs SELECT as well as UPDATE and fails with a bare
-- "permission denied for table players" that says nothing about the grant
-- being tested. That is not hypothetical: it is what this block did first, and
-- it failed on staging — where the 04:00 prod-to-staging snapshot strips
-- column-level grants and leaves relacl looking fine while pg_attribute.attacl
-- is empty. A literal makes the probe answer the question it is asking on
-- either host.
DO $verify$
DECLARE
  v_col     TEXT;
  v_missing TEXT := '';
  v_extra   TEXT := '';
  v_denied  BOOLEAN;
BEGIN
  -- 1. Exactly the eleven, and nothing else.
  FOR v_col IN
    SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid = 'public.players'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attname
  LOOP
    IF v_col = ANY (ARRAY['first_name','last_name','display_name','handle','phone','bio',
                          'avatar_url','hide_from_leaderboard','competition_category',
                          'onboarding_completed','last_active_at']) THEN
      IF NOT has_column_privilege('authenticated', 'public.players', v_col, 'UPDATE') THEN
        v_missing := v_missing || v_col || ' ';
      END IF;
    ELSE
      IF has_column_privilege('authenticated', 'public.players', v_col, 'UPDATE') THEN
        v_extra := v_extra || v_col || ' ';
      END IF;
    END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION '00210: authenticated cannot UPDATE columns the app writes: %', v_missing;
  END IF;
  IF v_extra <> '' THEN
    RAISE EXCEPTION '00210: authenticated can still UPDATE columns nothing writes: %', v_extra;
  END IF;

  -- 2. DELETE is gone.
  IF has_table_privilege('authenticated', 'public.players', 'DELETE') THEN
    RAISE EXCEPTION '00210: authenticated can still DELETE from players';
  END IF;

  -- 2b. MAINTAIN is gone too. Guarded the same way as the REVOKE, and read off
  --     relacl rather than has_table_privilege so it reports what is actually
  --     recorded on the table.
  IF current_setting('server_version_num')::INT >= 170000 THEN
    IF EXISTS (
      SELECT 1 FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = 'public.players'::REGCLASS
        AND a.grantee = 'authenticated'::REGROLE
        AND a.privilege_type = 'MAINTAIN'
    ) THEN
      RAISE EXCEPTION '00210: authenticated still holds MAINTAIN on players';
    END IF;
  END IF;

  -- 3. The service role is untouched. Every admin write and every SECURITY
  --    DEFINER path depends on it, so a REVOKE that caught it would take the
  --    console down rather than fail here.
  IF NOT has_table_privilege('service_role', 'public.players', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.players', 'DELETE') THEN
    RAISE EXCEPTION '00210: the service role lost a privilege it needs';
  END IF;

  -- 4. A real statement, as the real role. This is what a privilege bit does
  --    not tell you: that a granted UPDATE still parses and still fires
  --    set_updated_at without needing a grant on updated_at.
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE public.players SET bio = NULL WHERE FALSE;
    RESET ROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION '00210: a granted column UPDATE was refused -- %', SQLERRM;
  END;

  -- 5. And a revoked one is genuinely refused. Without this, a migration that
  --    granted the whole table would pass every check above except the column
  --    census, and check 1 reads privileges rather than exercising them.
  v_denied := FALSE;
  BEGIN
    SET LOCAL ROLE authenticated;
    UPDATE public.players SET ban_reason = NULL WHERE FALSE;
    RESET ROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    v_denied := TRUE;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION '00210: authenticated can still write ban_reason, so the revoke did not take';
  END IF;

  RAISE NOTICE '00210 verified: authenticated may UPDATE 11 profile columns and no others, may not DELETE, and the service role is untouched';
END
$verify$;

COMMIT;
