-- ============================================================
-- 00164 — elo_review is an admin's prompt, so a member cannot erase it
--
-- 00163 added players.elo_review and documented it as "cleared by the console
-- once actioned". It never said who may clear it, and the answer turned out to
-- be: anybody.
--
-- HOW. `authenticated` holds UPDATE on public.players but NOT SELECT (the
-- table-grant shape 00128/00131 left behind; members read through the
-- players_self view). That makes a filtered `UPDATE ... WHERE id = $1` fail for
-- want of SELECT on the filter column, which is what made this look safe. An
-- UNQUALIFIED `UPDATE players SET elo_review = NULL` needs no SELECT at all:
-- the players_update_own policy scopes it to the caller's own row and it
-- succeeds. Verified on staging as a plain 'player' — one row cleared.
--
-- So the member whose merge produced the flag is exactly the person able to
-- remove it, and the roster badge that is supposed to outlive the merge lasts
-- until they open the app.
--
-- THE FIX is the one already written for the sibling flag. 00132 added
-- privilege_claim_review to guard_player_privileged_columns for a reason that
-- transfers word for word — "clearing it erases an admin's only durable prompt
-- to review" — and elo_review is the same kind of object: written by a
-- SECURITY DEFINER function, read by an admin, meaningless as a self-edit.
-- Both arms, because a self-created row arriving with a review invents a merge
-- that never happened just as surely as clearing one hides a merge that did.
--
-- NOT a grant change. Revoking UPDATE on the column would work for this one
-- field and leave the next column added to this table in the same position;
-- the trigger is where this table says what a member may not touch, and the
-- guard is what the privilege-escalation audit reads.
--
-- The function body below is 00163-era verbatim apart from the two added
-- lines and this note — CREATE OR REPLACE has no way to say "and also".
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
-- SIGNATURE COPIED FROM THE LIVE FUNCTION, and the omissions are load-bearing.
-- It is NOT security definer: the first branch tests current_user, so making it
-- definer would resolve current_user to the owner on every call and the guard
-- would return early for everybody. search_path stays bare 'public' for the
-- same reason — auth.uid() is schema-qualified at each use.
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
