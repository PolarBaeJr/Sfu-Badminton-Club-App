-- ============================================================
-- 00225 — AN OFFICER CAN BE KEPT OFF THE PUBLIC PAGE
--
-- APPLY AFTER 00224. Nothing in here depends on it; the ordering is only so
-- that schema_migrations stays a straight line.
--
-- ------------------------------------------------------------
-- WHAT THE OWNER ASKED FOR
-- ------------------------------------------------------------
-- "in permission make it so theres a way to hide a user from the exec page,
--  also exec page doesnt currently work"
--
-- The second half turned out to be about the first. /exec renders correctly and
-- is reachable signed-out — it lists all ten rows that get_executives() returns.
-- What it lists is the problem: two of the ten are the owner's own alternate
-- accounts, carrying no title and no bio, sitting on the club's public page
-- between real officers. The page is not broken, it is publishing something
-- nobody chose to publish.
--
-- ------------------------------------------------------------
-- WHY A COLUMN AND NOT THE TWO LEVERS ALREADY HERE
-- ------------------------------------------------------------
-- `is_exec = FALSE` is wrong: it is the console-access flag. Clearing it to
-- tidy a public page takes the person's permissions away with it, and on a
-- roster where most officers ARE their access, that is a silent demotion
-- performed for a layout reason.
--
-- `active_flag = FALSE` is wrong for the same shape of reason one level down:
-- it takes the member off the ladder, out of the roster's default view and out
-- of the overnight jobs. It means "this person has left the club", and an
-- officer who simply does not want a photo on a webpage has not left.
--
-- So the club needs a third thing, and it is genuinely a third thing: WHETHER
-- THIS OFFICER IS PUBLISHED. It is orthogonal to whether they hold the console
-- and orthogonal to whether they are an active member, which is exactly why
-- neither existing flag could carry it.
--
-- DEFAULT FALSE, so applying this migration publishes and unpublishes nobody.
-- Every officer on the page today is still on it a second after COMMIT; the
-- column only gives somebody a way to say otherwise.
--
-- ------------------------------------------------------------
-- WHY IT IS A PRIVILEGED COLUMN
-- ------------------------------------------------------------
-- Section 3 adds it to guard_player_privileged_columns, next to exec_title and
-- exec_photo_url, and the reason is the one that file already gives for those:
-- this column decides what get_executives() shows to ANONYMOUS VISITORS. It is
-- not a cosmetic preference on the member's own profile.
--
-- The escalation risk by itself is small — unhiding yourself only republishes a
-- name the club already made an officer, since is_exec is refused above. What
-- makes it privileged is the other direction. Who appears on the club's public
-- officer list is the club's decision to make and the club's decision to
-- reverse, and a member removing themselves from it unilaterally, without an
-- exec knowing, is precisely the edit somebody under scrutiny would want. The
-- standing rule from the 2026-08-20 privilege audit is that every new `players`
-- column gets an answer here rather than an omission, and this is the answer.
--
-- NOT ADDED TO THE INSERT ARM, matching exec_photo_url. A self-created row
-- cannot be an exec at all — is_exec is refused a few lines above — so
-- `exec_hidden` on a signup is a flag about a page the row will never appear
-- on. There is nothing to escalate.

BEGIN;

-- ---- 1. THE COLUMN --------------------------------------------------------

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS exec_hidden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.players.exec_hidden IS
  'Keeps an officer off the public /exec page without touching is_exec (their console access) or active_flag (their membership). Read only by get_executives(). Privileged: see guard_player_privileged_columns.';

-- ---- 2. get_executives() --------------------------------------------------
--
-- Restated in full rather than patched, because CREATE OR REPLACE FUNCTION
-- drops any attribute it does not name and this one is SECURITY DEFINER with a
-- pinned search_path. The signature is unchanged, so the player app needs no
-- coordination with this deploy: applied before the code ships it publishes the
-- same ten officers it does today, because nothing is hidden yet.
--
-- The filter is `NOT exec_hidden` rather than `exec_hidden = FALSE` only
-- because the column is NOT NULL — with a nullable column the two differ and
-- the difference would be a silently missing officer.

CREATE OR REPLACE FUNCTION public.get_executives()
RETURNS TABLE(id uuid, name text, exec_title text, exec_photo_url text, bio text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id, full_name AS name, exec_title, exec_photo_url, exec_bio AS bio
  FROM players
  WHERE is_exec = TRUE AND active_flag = TRUE AND NOT exec_hidden
  ORDER BY (exec_title IS NULL), exec_title, full_name;
$function$;

-- The grants this function already had. Restated because CREATE OR REPLACE on
-- an existing function KEEPS them, but a database that somehow lost the
-- function entirely would get it back ungranted and /exec would go quiet for
-- signed-out visitors — and a failed PostgREST read arrives as an empty list,
-- never an error, so the symptom would be "no executives listed yet".
GRANT EXECUTE ON FUNCTION public.get_executives() TO anon, authenticated, service_role;

-- ---- 3. THE PRIVILEGED-COLUMN GUARD ---------------------------------------
--
-- Restated in full for the same CREATE OR REPLACE reason as above. This body is
-- the one live on production as of 00224 with exactly ONE line added — the
-- exec_hidden clause in the UPDATE arm. Every comment below belongs to the
-- migration that added the line it sits on; they are carried forward verbatim
-- rather than summarised, because each one is the only record of why its column
-- is in this list.

CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- THE OPENING IS 00131'S, NOT THIS FILE'S ORIGINAL.
  --
  -- This migration was written in parallel with 00131, from a body that
  -- predated it, and shipped `IF auth.uid() IS NULL OR is_admin(auth.uid())`.
  -- Applied in order that silently reverted 00131's hardening: auth.uid() is
  -- NULL for `anon` as well as for the service-role console, so the guard
  -- returned early for an unauthenticated caller. The table-grant revokes in
  -- 00128/00131 mask it today; any future anon grant would unmask it.
  --
  -- BOTH halves are required: current_user alone would admit a member inside a
  -- postgres-owned SECURITY DEFINER function, and auth.uid() alone is what let
  -- anon through.
  IF (current_user = 'service_role' OR current_user NOT IN ('anon', 'authenticated'))
     AND auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- An admin editing a row from the player app, on the browser key.
  -- auth.uid() IS NOT NULL first, so this branch can never be the one that
  -- decides an anonymous request.
  IF auth.uid() IS NOT NULL AND is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A self-created row may only ever be an ordinary, unapproved member.
    IF COALESCE(NEW.is_exec, FALSE)
       OR COALESCE(NEW.is_trainer, FALSE)
       OR COALESCE(NEW.fee_exempt, FALSE)
       OR COALESCE(NEW.is_banned, FALSE)
       OR NEW.role IS DISTINCT FROM 'player'
       OR NEW.status IS DISTINCT FROM 'pending_approval'
       -- Added: a self-created row claiming an office is the same escalation as
       -- editing one in, and get_executives() would publish it.
       OR NEW.exec_title IS NOT NULL
       -- REPLACES 00086's portfolio line, for the same reason it existed: a
       -- self-created row cannot be an exec at all (is_exec is refused above),
       -- so permissions on one are meaningless — but they must not be a way to
       -- pre-stage values that come into force the moment an admin grants
       -- is_exec. cardinality(), not IS NOT NULL: see the note above.
       OR NEW.permission_role IS NOT NULL
       OR cardinality(COALESCE(NEW.permission_grants, '{}')) > 0
       OR cardinality(COALESCE(NEW.permission_revokes, '{}')) > 0
       -- Added by 00092: signing up is not the club letting you in, so a signup
       -- that arrives already numbered is claiming a membership nobody granted.
       OR NEW.member_code IS NOT NULL
       -- Added by 00132. Written only by ensure_player_for_user and cleared
       -- only by an admin resolving it; a row that arrives carrying one is
       -- inventing a claim decision nobody made.
       OR NEW.privilege_claim_review IS NOT NULL
       -- Added by 00164, for the line above's reason. Written only by
       -- merge_players; a signup carrying one is claiming to be the survivor of
       -- a merge that never happened, which would put a review badge on the
       -- roster pointing at nothing.
       OR NEW.elo_review IS NOT NULL
       -- 00093, restored alongside the UPDATE arm: pre-staging in its purest
       -- form, a label that grants nothing today and is filled in by the next
       -- edit to that baseline.
       OR NEW.permission_baseline_id IS NOT NULL THEN
      RAISE EXCEPTION 'Not authorized to create a privileged player row';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     -- Published to anonymous visitors by get_executives(), so an unguarded
     -- write is a public claim to an office the member does not hold, not a
     -- cosmetic field on their own profile.
     OR NEW.exec_title   IS DISTINCT FROM OLD.exec_title
     -- ADDED BY 00225, and it is the line above's reason read the other way
     -- round. exec_title is guarded because a member must not put THEMSELVES
     -- on the public page; this is guarded because a member must not take
     -- themselves OFF it. Who the club presents as its officers is the club's
     -- call in both directions, and an unguarded UPDATE here would let the one
     -- person with a motive to disappear do it without an exec ever seeing.
     OR NEW.exec_hidden  IS DISTINCT FROM OLD.exec_hidden
     -- THE 00087 REPLACEMENT for 00086's portfolio line. All three, because
     -- omitting any one of them leaves a complete escalation path: the role
     -- alone chooses the base, a grant alone adds to it, and clearing a revoke
     -- alone hands back whatever the club took away.
     OR NEW.permission_role IS DISTINCT FROM OLD.permission_role
     OR NEW.permission_grants IS DISTINCT FROM OLD.permission_grants
     OR NEW.permission_revokes IS DISTINCT FROM OLD.permission_revokes
     -- Added by 00092. Assigned once by assign_member_code() and permanent;
     -- there is no legitimate self-edit, including clearing it.
     OR NEW.member_code IS DISTINCT FROM OLD.member_code
     -- Added by 00132. Setting it is meaningless and clearing it erases an
     -- admin's only durable prompt to review a privilege the member did not
     -- get — see the section header.
     OR NEW.privilege_claim_review IS DISTINCT FROM OLD.privilege_claim_review
     -- Added by 00164. THE POINT OF THIS MIGRATION: the member this flag is
     -- about is the one person with a motive to clear it, and an unqualified
     -- UPDATE reached it without needing SELECT on the table.
     OR NEW.elo_review IS DISTINCT FROM OLD.elo_review
     -- 00093's fourth, RESTORED: this file dropped it. It is a promise of
     -- access rather than access itself, and clearing it makes baseline
     -- propagation skip the member — so a capability the club revoked stays
     -- revoked for everyone except them.
     OR NEW.permission_baseline_id IS DISTINCT FROM OLD.permission_baseline_id
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFYING IT
--
-- The column exists and defaults to published:
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'players' AND column_name = 'exec_hidden';
--   -- expect exec_hidden | boolean | NO | false
--
-- Nobody was hidden by applying this — the count must not have moved:
--
--   SELECT count(*) FROM get_executives();
--   -- expect the same number the page listed before, 10 on production
--
-- The filter actually filters. Pick any officer, hide them, count, put them
-- back:
--
--   SELECT count(*) FROM get_executives();                        -- before
--   UPDATE players SET exec_hidden = TRUE WHERE full_name = '<an officer>';
--   SELECT count(*) FROM get_executives();                        -- one fewer
--   UPDATE players SET exec_hidden = FALSE WHERE full_name = '<an officer>';
--
-- The guard refuses a member editing their own row. Run as `authenticated`,
-- NOT as postgres — superuser bypasses RLS and grants, so a psql check as
-- postgres proves nothing here:
--
--   SET ROLE authenticated;
--   -- expect: ERROR  Not authorized to modify privileged player fields
--   RESET ROLE;
--
-- WHO IS ON THE PAGE RIGHT NOW, which is the question that started this:
--
--   SELECT full_name, exec_title, exec_hidden
--     FROM players WHERE is_exec AND active_flag
--    ORDER BY exec_hidden, exec_title NULLS LAST, full_name;
-- ============================================================================
