-- ============================================================
-- 00072 — exec_title is privileged, and members do not get TRUNCATE
--
-- Numbered 00072 to stay clear of 00070/00071, being written concurrently for
-- the tournament and match-integrity fixes.
--
-- TWO PROBLEMS, both found by reviewing the LIVE database rather than the repo.
-- That distinction matters here: migrations are forward-only and applied by
-- hand, so the database is the source of truth and the repo records intent.
--
-- 1. exec_title was left out of the privileged-column guard.
--    players_update_own (00005) lets a member update their own row, and the
--    guard trigger is what narrows that to non-privileged columns. It checks
--    role, status, is_banned, is_exec, is_trainer, fee_exempt, active_flag,
--    eligibility_flag, membership_type, waiver_reset_at, deletion_requested_at
--    and exec_photo_url — but NOT exec_title. Any authenticated member could
--    PATCH their own exec_title to 'President', and get_executives() (00042)
--    publishes it to anonymous visitors. The admin server actions already treat
--    exec_title as admin-only (player-field-access.ts), so the database and the
--    application disagreed about the same field.
--
--    exec_photo_url was guarded and exec_title was not: the pair was added
--    together and only one reached the guard.
--
-- 2. anon and authenticated hold TRUNCATE on players and other member tables.
--    DELETE is gated by RLS (players_admin), so that one is defence in depth.
--    TRUNCATE is not: it is a table-level operation that bypasses row security
--    entirely. It is not reachable through PostgREST, which has no TRUNCATE
--    verb, so this is not an open door today — but nothing except the absence
--    of a code path stands between that grant and an emptied roster.
--
-- THE BODY BELOW IS THE LIVE FUNCTION, COPIED VERBATIM, WITH ONE LINE ADDED.
-- CREATE OR REPLACE takes the whole body, so any column omitted here loses its
-- protection silently. A reconstruction of this function from its column list
-- was written first and would have dropped status, is_banned and active_flag —
-- letting a member self-approve, unban themselves, or reactivate. Always dump
-- the live definition and add to it; never rebuild it from memory.
-- ============================================================

CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- auth.uid() IS NULL covers the service-role console, which has already
  -- checked the caller's level in a server action.
  IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN
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
       OR NEW.exec_title IS NOT NULL THEN
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
     -- THE ADDITION. Published to anonymous visitors by get_executives(), so an
     -- unguarded write is a public claim to an office the member does not hold,
     -- not a cosmetic field on their own profile.
     OR NEW.exec_title   IS DISTINCT FROM OLD.exec_title
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_player_privileged_columns() IS
  'Blocks a member from granting themselves privilege via a direct PostgREST write to their own players row. Replaced wholesale on every change: CREATE OR REPLACE takes the whole body, so a column omitted here loses its protection silently. Dump the live definition before editing.';

-- TRUNCATE bypasses row security by design, so no member-facing role should
-- hold it on a table carrying member data or money. REFERENCES and TRIGGER are
-- equally unnecessary for these roles. DELETE and UPDATE stay: both are used
-- through PostgREST and both are constrained by RLS policies.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.players             FROM authenticated, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.ratings             FROM authenticated, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.club_fees           FROM authenticated, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.reinstatement_fees  FROM authenticated, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.tournament_fees     FROM authenticated, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.matches             FROM authenticated, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.match_participants  FROM authenticated, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.audit_logs          FROM authenticated, anon;
