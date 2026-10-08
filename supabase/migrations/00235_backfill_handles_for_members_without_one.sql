-- ============================================================
-- 00235 BACKFILL HANDLES FOR MEMBERS WITHOUT ONE
--
-- WHAT THIS DOES: gives a handle to every approved member who has none, using
-- the SAME four-tier ladder 00092 used, so nothing about how a handle is
-- derived changes and no second scheme comes into existence.
--
-- WHY THERE ARE ANY LEFT. 00092 backfilled every member who existed when it
-- ran, and deliberately skipped `pending_approval` rows because they have no
-- member_code to build the last-resort handle from and are not members yet.
-- The intent was that a new member picks their own in /settings. Most do not.
-- So every member approved since 00092 who never opened that screen has
-- `handle IS NULL`, and the number only grows.
--
-- WHERE THAT SHOWS. The leaderboard prints `@handle` as the subline under a
-- member's name, so a member without one renders a blank line where everybody
-- else has an identity. 00234's past-season ladder makes it more visible again,
-- which is what surfaced this.
--
-- THIS IS A ONE-TIME CLEANUP, NOT A FIX FOR THE CAUSE. Approval still does not
-- assign a handle, so this file will be true again for members approved after
-- it runs. The durable fix is to derive one at approval, which means touching
-- the approval trigger and is deliberately not bundled in here. Until that
-- exists, re-running this file is the remedy: it is safe to run any number of
-- times.
--
-- SAFE TO RE-RUN, and that is a property of the WHERE clause rather than a
-- promise: only `handle IS NULL` rows are touched, so a second run does
-- nothing. Nobody's existing handle is changed, including one a member chose.
--
-- NOT pending_approval, matching 00092's intent but NOT its predicate. 00092
-- says pending rows are skipped "because they have no member code", and it
-- filters on `member_code IS NOT NULL` alone. That was a description of the data
-- in front of it, not a rule: a pending row CAN carry a member code, and the
-- local database has one right now. So the status is excluded by name here.
-- Two reasons it matters. A pending applicant is not a member and has nothing to
-- show a handle on, and the handle namespace is globally unique, so minting one
-- for them would take the name they are about to be offered the chance to pick
-- at onboarding.
-- ============================================================

BEGIN;

-- ---- 1. THE DERIVATION HELPER ---------------------------------------------
--
-- Recreated because 00092 DROPS it on the way out, on the grounds that it had
-- no second caller and leaving it behind invites somebody to build on a
-- function whose only contract is "what the backfill needed". That reasoning
-- still holds, so this file recreates it, uses it, and drops it again rather
-- than leaving it installed.
--
-- The body is character-for-character 00092's. If it ever diverges, two members
-- with the same name get handles derived by different rules, which is the one
-- outcome this whole file exists to avoid.

CREATE OR REPLACE FUNCTION public.derive_handle_base(p_source TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT regexp_replace(
           left(
             regexp_replace(
               regexp_replace(
                 regexp_replace(lower(COALESCE(p_source, '')), '[^a-z0-9_]+', '_', 'g'),
                 '_+', '_', 'g'),
               '^[^a-z]+', ''),
             20),
           '_+$', '');
$function$;

-- ---- 2. THE LADDER --------------------------------------------------------
--
--   tier 1  the nickname base (display_name), the member's own chosen text.
--   tier 2  the full-name base, where most of the club lands.
--   tier 3  that base with `_2`, `_3`, ... appended, first free wins.
--   tier 4  'member_' + the member code, unique by construction.
--
-- Every tier is checked for shape, reserved words and freedom, not just the
-- base. Rows are walked in a fixed (created_at, id) order so the same starting
-- state always produces the same handles.

DO $$
DECLARE
  -- Kept in step with RESERVED_HANDLES in
  -- packages/shared/src/utils/member-identity.ts by hand, the same way 00092
  -- keeps it. Verified identical to that array when this file was written.
  v_reserved TEXT[] := ARRAY['admin', 'exec', 'root', 'me', 'settings', 'api', 'support', 'sfu', 'club'];
  v_row          RECORD;
  v_nick_base    TEXT;
  v_name_base    TEXT;
  v_tiebreak     TEXT;
  v_suffix       TEXT;
  v_candidates   TEXT[];
  v_try          TEXT;
  v_candidate    TEXT;
  v_n            INTEGER;
  v_filled       INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT id, display_name, full_name, member_code
      FROM public.players
     WHERE handle IS NULL
       AND member_code IS NOT NULL
       AND status <> 'pending_approval'
     ORDER BY created_at, id
  LOOP
    -- Schema-qualified: a DO block runs under whatever search_path the session
    -- applying the migration happens to have, and this helper exists for the
    -- length of this file only.
    v_nick_base := public.derive_handle_base(v_row.display_name);
    v_name_base := public.derive_handle_base(v_row.full_name);
    -- The member's own text is preferred for the suffixed form too: someone who
    -- chose "Matthew" should become matthew_2 rather than matthew_cheng_2.
    v_tiebreak  := COALESCE(NULLIF(v_nick_base, ''), v_name_base);

    v_candidates := ARRAY[v_nick_base, v_name_base];
    IF v_tiebreak <> '' THEN
      FOR v_n IN 2..99 LOOP
        v_suffix := '_' || v_n::text;
        v_candidates := v_candidates
          || (regexp_replace(left(v_tiebreak, 20 - length(v_suffix)), '_+$', '') || v_suffix);
      END LOOP;
    END IF;
    v_candidates := v_candidates || ('member_' || lower(v_row.member_code));

    v_candidate := NULL;
    FOREACH v_try IN ARRAY v_candidates LOOP
      CONTINUE WHEN v_try IS NULL;
      CONTINUE WHEN v_try !~ '^[a-z][a-z0-9_]{2,19}$';
      CONTINUE WHEN v_try = ANY (v_reserved);
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.players WHERE lower(handle) = v_try);
      v_candidate := v_try;
      EXIT;
    END LOOP;

    -- RAISE rather than leave a NULL. A member with no handle is the condition
    -- this file exists to end, so failing loudly beats finishing "successfully"
    -- having skipped somebody.
    IF v_candidate IS NULL THEN
      RAISE EXCEPTION 'Could not derive a free handle for player % (member %)', v_row.id, v_row.member_code;
    END IF;

    UPDATE public.players SET handle = v_candidate WHERE id = v_row.id;
    v_filled := v_filled + 1;
  END LOOP;

  RAISE NOTICE '00235: assigned % handle(s)', v_filled;
END;
$$;

-- ---- 3. THE HELPER GOES BACK AWAY -----------------------------------------

DROP FUNCTION IF EXISTS public.derive_handle_base(TEXT);

COMMIT;
