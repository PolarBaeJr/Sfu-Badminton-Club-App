-- ============================================================
-- 00087 — per-user permissions
--
-- 00086 gave an exec ONE of four VP portfolios. Four jobs can only ever cut the
-- console four ways, and the club's real question turned out to be per-action:
-- "this treasurer may see club fees but not hand out permissions". This
-- migration replaces the single portfolio column with the storage a capability
-- model needs — a role, a set of grants and a set of revokes — and the app
-- resolves them:
--
--     effective = ROLE_DEFAULTS[role] ∪ grants \ revokes
--
-- THIS MIGRATION ADDS THREE COLUMNS AND DROPS ONE. On staging, 00086 is already
-- recorded as applied, so the portfolio column really exists and really is
-- dropped. ON PRODUCTION, WHICH IS STILL ON 00085, 00086 AND 00087 RUN BACK TO
-- BACK IN ONE SITTING: portfolio is created by 00086 and dropped again here,
-- seconds later, having never held a value. That add-then-drop is deliberate
-- and is NOT a mistake to be tidied by editing 00086 — an in-place edit would
-- never re-run on staging, where the column and its guard are live, and the two
-- databases would diverge.
--
-- NOTHING CHANGES FOR ANYONE WHEN THIS IS APPLIED. Every existing row gets
-- permission_role NULL and two empty arrays, and the app reads a NULL role as
-- "not narrowed": every exec resolves to the exec baseline and every trainer to
-- the trainer baseline, both of which are transcriptions of what those levels
-- could already do. The app is LIVE, so that is the only acceptable deploy-day
-- behaviour, and it is pinned by tests on both sides of the boundary.
--
-- *** APPLY THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT. ***
-- The console middleware now resolves permissions through admin_console_access()
-- and FAILS CLOSED for an exec when that call errors. Deploying the code first
-- means the function does not exist yet, every exec's request errors, and every
-- exec is redirected out of the console until this lands. Admins and trainers
-- would still get in — which is the point of failing closed asymmetrically, but
-- it is not a state to ship on purpose.
--
-- FIVE PARTS:
--   1. The three columns, with the CHECKs that keep them honest.
--   2. guard_player_privileged_columns() replaced, portfolio out, all three
--      new columns in — in BOTH the INSERT and the UPDATE branch.
--   3. admin_portfolio() dropped.
--   4. players.portfolio dropped.
--   5. admin_console_access(), the middleware's one round trip.
--
-- Ordered that way on purpose: the guard must stop naming portfolio BEFORE the
-- column disappears, or the function is invalid between the two statements.
--
-- THE DATABASE NEVER RESOLVES. admin_console_access() returns the raw triple
-- and the app applies the rule. There is deliberately no SQL implementation of
-- "effective = base ∪ grants \ revokes" — a second one would drift from the
-- first, and the direction it would drift in is "somebody keeps access an admin
-- took away".
-- ============================================================

-- 1. THE COLUMNS ----------------------------------------------------------
--
-- Capability strings as the element type, not a bitmask and not six mode
-- columns: a grant names a (resource, mode) pair, and 'fees.expenses.add.write'
-- is the same string the code, the audit log and the editor all use. Nothing
-- has to be decoded to be read by a human.
--
-- A JOIN TABLE WAS REJECTED. It cannot distinguish "no rows because nobody has
-- configured this person", which must mean unrestricted, from "no rows because
-- everything was unticked", which must mean nothing at all — not without a
-- second boolean that can disagree with the rows, and a disagreement there is
-- somebody believing an exec is restricted when they are not. The nullable role
-- column carries that distinction by itself.
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS permission_role TEXT;
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS permission_grants TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS permission_revokes TEXT[] NOT NULL DEFAULT '{}';

-- The closed set of roles. A typo'd role is not a weaker role: the resolver
-- gives an unrecognised one NO defaults, so its holder would be left with
-- whatever the deltas say and no explanation. Refuse it here instead.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_role_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_role_check
  CHECK (permission_role IS NULL
         OR permission_role IN ('finance', 'tournaments', 'internal', 'external'));

-- NULL ELEMENTS. array_position() compares with IS NOT DISTINCT FROM, so it is
-- the one cheap way to ask whether an array CONTAINS a NULL; a NULL inside one
-- of these would compare strangely in the containment test below and reach the
-- resolver as a value isCapability() rejects silently.
--
-- NULL::TEXT rather than a bare NULL: the argument is `anycompatible`, and an
-- untyped NULL leaves the resolver to infer the type from the array. It does
-- infer it — but a constraint that fails to CREATE takes this whole migration
-- down, and the cast costs nothing.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_deltas_not_null_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_deltas_not_null_check
  CHECK (array_position(permission_grants, NULL::TEXT) IS NULL
         AND array_position(permission_revokes, NULL::TEXT) IS NULL);

-- A capability cannot be granted and revoked at once. The resolver still lets
-- the revoke win, because it has to be total for a row that somehow holds both
-- — but "somehow" should be unreachable, and a row in that state is a bug in
-- whatever wrote it rather than a state to be interpreted.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_deltas_disjoint_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_deltas_disjoint_check
  CHECK (NOT (permission_grants && permission_revokes));

-- NO DELTAS WITHOUT A ROLE. The resolver does not consult grants or revokes
-- when the role is NULL, so a stored delta there is invisible today and would
-- WAKE UP the day an admin picks a role — a revoke somebody stored months ago
-- silently taking something away, or a grant appearing from nowhere. The save
-- action clears both arrays when the role goes NULL; this is the constraint
-- that makes the dormant state unreachable rather than merely unusual.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_deltas_need_role_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_deltas_need_role_check
  CHECK (permission_role IS NOT NULL
         OR (cardinality(permission_grants) = 0 AND cardinality(permission_revokes) = 0));

-- THE VOCABULARY, PINNED IN SQL. All 113 capabilities, and both arrays must be
-- subsets of it.
--
-- This is here for the REVOKES, and the reasoning is worth stating because it
-- reverses the obvious one. An unknown element in `grants` is harmless: the
-- resolver drops it and nobody gains anything. An unknown element in `revokes`
-- is the opposite — it fails to REMOVE something, and the something it fails to
-- remove might be permissions.write. So a capability deleted from the code
-- while a stored revoke still names it turns that revoke into a silent no-op,
-- and that is the one way this model can widen a person by accident.
--
-- A CHECK is not re-validated when code changes, so this constraint cannot
-- catch that on its own. What it does is make the failure impossible to reach
-- by accident from the app, and make REMOVING A CAPABILITY A MIGRATION — you
-- cannot delete the string from the code without also editing this list, and
-- editing this list forces you to write the UPDATE that strips it from every
-- stored array. The cost, accepted: adding a capability now needs a migration
-- as well as a code change.
--
-- ONE list, tested against the CONCATENATION of both arrays. `(a || b) <@ v` is
-- exactly `a <@ v AND b <@ v`, and writing the 113 strings once means there is
-- no second copy to fall out of step with the first.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_vocabulary_check
  CHECK (
    (permission_grants || permission_revokes) <@ ARRAY[
    'players.read', 'players.approve.write', 'players.create.write',
    'players.update.write', 'players.waiver.resign.write', 'players.ban.write',
    'players.reinstate.write', 'players.editor.varsitynotes.write', 'players.deletion.cancel.write',
    'players.remove.write', 'players.merge.write', 'players.reliability.write',
    'players.privilegedfields.write', 'seasons.read', 'seasons.create.write',
    'seasons.activate.write', 'seasons.end.write', 'seasons.fees.write',
    'sessions.read', 'sessions.reminders.write', 'sessions.create.write',
    'sessions.update.write', 'sessions.archive.write', 'sessions.checkin.token.write',
    'sessions.attendance.write', 'sessions.delete.write', 'matches.read',
    'matches.void.write', 'matches.convert.write', 'matches.create.write',
    'challenges.read', 'challenges.create.write', 'challenges.expire.write',
    'announcements.read', 'announcements.create.write', 'announcements.update.write',
    'announcements.delete.write', 'tournaments.manage.read', 'tournaments.manage.create.write',
    'tournaments.manage.update.write', 'tournaments.manage.status.write', 'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write', 'tournaments.manage.archive.write', 'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write', 'tournaments.draw.lock.write', 'tournaments.draw.unlock.write',
    'tournaments.results.enter.write', 'tournaments.results.walkover.write', 'tournaments.results.void.write',
    'tournaments.results.unvoid.write', 'tournaments.results.undo.write', 'tournaments.results.edit.write',
    'tournaments.results.entry.write', 'tournaments.results.doublenoshow.write', 'tournaments.results.bonuses.write',
    'tournaments.results.standings.write', 'tournaments.results.finalize.write', 'tournaments.fees.read',
    'tournaments.fees.tier.create.write', 'tournaments.fees.tier.update.write', 'tournaments.fees.tier.delete.write',
    'tournaments.fees.markpaid.write', 'tournaments.fees.markunpaid.write', 'fees.expenses.read',
    'fees.expenses.add.write', 'fees.expenses.update.write', 'fees.expenses.reimburse.write',
    'fees.expenses.remove.write', 'fees.otherincome.read', 'fees.otherincome.add.write',
    'fees.otherincome.remove.write', 'fees.clubfees.read', 'fees.clubfees.markpaid.write',
    'fees.clubfees.markunpaid.write', 'fees.clubfees.waive.write', 'fees.clubfees.addmanual.write',
    'fees.clubfees.removemanual.write', 'fees.reinstatements.read', 'fees.reinstatements.write',
    'fees.netposition.read', 'fees.playerflags.write', 'legal.read',
    'legal.reacceptance.write', 'legal.documents.write', 'legal.waivertemplate.write',
    'walkovers.read', 'walkovers.confirm.write', 'walkovers.reject.write',
    'disputes.read', 'disputes.resolve.write', 'permissions.read',
    'permissions.write', 'audit.read', 'ratings.read',
    'accounts.read', 'platform.settings.write'
    ]::TEXT[]
  );

-- `write ⊆ read` is deliberately NOT expressible here. It is a property of the
-- RESOLVED set — a revoke of fees.expenses.read has to take
-- fees.expenses.add.write with it even when the write came from the ROLE and is
-- named nowhere in either array — so it lives in resolvePermissions(), applied
-- after subtraction, and no CHECK can see it.

COMMENT ON COLUMN public.players.permission_role IS
  'Which set of capabilities this person STARTS from: finance | tournaments | internal | external, or NULL for "not composed". NULL is the deploy-day state of every row and means the level baseline applies — exactly the access this person had before per-user permissions existed. A role REPLACES the baseline rather than adding to it, so assigning one is how an exec is narrowed to their own job. Ignored for admins (superusers by level) and never set on a trainer. Privileged: guarded by guard_player_privileged_columns and writable only by setPlayerPermissions() in the admin console, which enforces grant closure and is audited.';

COMMENT ON COLUMN public.players.permission_grants IS
  'Capabilities added on top of the role''s defaults. Empty unless permission_role IS NOT NULL (CHECK). Nobody can grant a capability they do not themselves hold — grant closure, enforced in setPlayerPermissions().';

COMMENT ON COLUMN public.players.permission_revokes IS
  'Capabilities removed from the role''s defaults. Beats a grant of the same string. Empty unless permission_role IS NOT NULL (CHECK). Bound by the same closure rule as grants: an unbounded revoke would be a denial-of-access weapon, so only somebody who could have granted a capability can take it back.';

-- 2. THE GUARD ------------------------------------------------------------
--
-- THE FUNCTION BODY BELOW IS 00086'S, WHICH WAS ITSELF DUMPED FROM THE
-- PRODUCTION DATABASE ON 2026-08-09 (identical to staging, hashes compared),
-- WITH THE portfolio LINES REPLACED BY THE THREE permission_* COLUMNS AND
-- NOTHING ELSE CHANGED. CREATE OR REPLACE takes the whole body, so a line
-- dropped from memory is a guard silently removed — see the header of 00072,
-- where a reconstruction from memory would have dropped status, is_banned and
-- active_flag. **Before applying this, dump the live definition and diff it
-- against 00086's**: if anything has been changed in the database since, that
-- change is not in this file and this statement will delete it.
--
-- WHY THESE THREE COLUMNS BELONG HERE. players_update_own (00005) lets a member
-- PATCH their own row through PostgREST with their own JWT. Without this guard,
-- the exec whose access these columns limit — precisely the person with a
-- motive — could clear their own permission_role and take back everything the
-- club had narrowed away, or append to their own permission_grants and hand
-- themselves anything in the vocabulary. That is not a narrowing being undone;
-- it is arbitrary self-promotion inside the console.
--
-- THE INSERT BRANCH USES cardinality(), NOT `IS NOT NULL`. The delta columns
-- are NOT NULL with a '{}' default, so `NEW.permission_grants IS NOT NULL` is
-- true on EVERY insert and a guard written that way would either reject every
-- signup or (with the sense flipped) never fire at all. Only permission_role,
-- which is nullable, takes the IS NOT NULL form.
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
       OR NEW.exec_title IS NOT NULL
       -- REPLACES 00086's portfolio line, for the same reason it existed: a
       -- self-created row cannot be an exec at all (is_exec is refused above),
       -- so permissions on one are meaningless — but they must not be a way to
       -- pre-stage values that come into force the moment an admin grants
       -- is_exec. cardinality(), not IS NOT NULL: see the note above.
       OR NEW.permission_role IS NOT NULL
       OR cardinality(COALESCE(NEW.permission_grants, '{}')) > 0
       OR cardinality(COALESCE(NEW.permission_revokes, '{}')) > 0 THEN
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
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_player_privileged_columns() IS
  'Blocks a member from granting themselves privilege via a direct PostgREST write to their own players row. Replaced wholesale on every change: CREATE OR REPLACE takes the whole body, so a column omitted here loses its protection silently. Dump the live definition before editing.';

-- 3. admin_portfolio() DROPPED --------------------------------------------
--
-- Its only callers were the console middleware and the sidebar, and both now
-- call admin_console_access(). Left in place it would be a live SECURITY
-- DEFINER function reading a column that no longer exists — which is a runtime
-- error the first time anything touches it, and nothing would be watching.
DROP FUNCTION IF EXISTS public.admin_portfolio(UUID);

-- 4. players.portfolio DROPPED --------------------------------------------
--
-- After the guard, so the trigger function never names a column that is gone.
-- The constraint goes with it automatically, but it is dropped by name first so
-- that re-running this file on a database where the column was already removed
-- is still a no-op rather than an error.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_portfolio_check;
ALTER TABLE public.players DROP COLUMN IF EXISTS portfolio;

-- 5. admin_console_access() -----------------------------------------------
--
-- ONE ROUND TRIP for the two things the middleware needs on every request: the
-- level, and the raw permission triple. Two functions would be two round trips
-- on the hot path for a question that is always asked together now — unlike
-- 00086's admin_portfolio(), which was only ever called for an exec.
--
-- THE LEVEL COMES FROM admin_access_level(), NOT FROM RE-DERIVING role/is_exec/
-- is_trainer HERE. That function is where the standing gate lives (00057): a
-- banned, suspended, pending or deactivated account holds no level at all. A
-- second derivation would be a second idea of good standing, and the direction
-- it would drift in is "a banned exec still reaches the console".
--
-- RETURNS jsonb, so supabase-js hands the caller ONE OBJECT. A RETURNS TABLE
-- would arrive as an array, and with the middleware now failing closed for
-- execs, a caller that forgot to unwrap it would read `level` as undefined and
-- redirect every exec out of the console.
--
-- The KEYS ARE THE COLUMN NAMES rather than the shorter role/grants/revokes,
-- deliberately: the result is fed straight into permissionsOf(), the same
-- function that reads a player row, so there is one shape and one reader. A
-- second shape would need its own unpacking code, and the natural way to write
-- that code — `row.revokes ?? []` — is precisely the silent-discard bug the
-- resolver throws to prevent.
--
-- Deliberately DOES NOT re-check standing itself, for the same reason
-- admin_portfolio() did not: admin_access_level() has already answered it, and
-- the app never consults the triple for somebody with no level.
--
-- A NOTE ON WHAT THIS EXPOSES, because it is a real change from
-- admin_portfolio(): that returned one opaque word; this returns another user's
-- full capability list to any authenticated caller who knows their user_id. The
-- callers only ever pass their own. That is acceptable for the same reason the
-- vocabulary is not a secret — knowing which capabilities somebody holds grants
-- none of them — but it is a widening of what the RPC surface says, and if the
-- club ever wants it narrowed the fix is `WHERE user_id = auth.uid()` rather
-- than a parameter.
CREATE OR REPLACE FUNCTION public.admin_console_access(p_user_id UUID)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'level',               admin_access_level(p_user_id),
    'permission_role',     p.permission_role,
    'permission_grants',   to_jsonb(p.permission_grants),
    'permission_revokes',  to_jsonb(p.permission_revokes)
  )
  FROM players p
  WHERE p.user_id = p_user_id;
$function$;

COMMENT ON FUNCTION public.admin_console_access(UUID) IS
  'Everything the admin console needs to decide what a user may open: their access level (via admin_access_level, standing included) and the RAW permission triple. Returns NULL when there is no player row. The database never resolves the triple — effective = ROLE_DEFAULTS[role] union grants minus revokes is implemented once, in the app, so there is no second implementation to drift.';

GRANT EXECUTE ON FUNCTION public.admin_console_access(UUID) TO authenticated;

-- PostgREST caches the schema, and everything new here is reached through it:
-- the three columns (the console selects and writes them) and
-- admin_console_access() (the middleware and the sidebar call it by RPC).
-- Without this they exist in Postgres while every request still gets
-- PGRST202/PGRST204 — and the middleware now FAILS CLOSED for an exec on
-- exactly that error, so the symptom would be every exec bounced out of the
-- console with the migration apparently applied. Same reasoning as 00064 and
-- 00086. Cheap and idempotent.
NOTIFY pgrst, 'reload schema';
