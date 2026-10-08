-- ============================================================
-- 00086 — exec portfolios
--
-- Access has been one ordered ladder — admin > exec > trainer — so every exec
-- has identical access: the VP of Tournaments can open the club's books and the
-- VP of Finance can regenerate a draw. The club's real structure is four VP
-- portfolios (Finance, Tournaments, Internal, External), and one is_exec boolean
-- cannot express any of it.
--
-- A PORTFOLIO NARROWS AN EXEC. IT NEVER WIDENS ANYONE.
--
--   portfolio IS NULL  -> exactly the access that exec has today. Every existing
--                         row is NULL, so applying this migration changes
--                         nothing for anybody. That is deliberate: the app is
--                         live, and narrowing must be an explicit, reversible
--                         act by an admin rather than a side effect of a deploy.
--   portfolio = 'x'    -> that exec's own job, plus the console baseline (the
--                         front door, the dashboard, their own passkeys).
--
-- Admins are superusers and are not narrowed. Trainers hold no portfolio.
--
-- NO FEATURE FLAG, AND NO STAGED ENFORCEMENT (design open questions 1 and 5 —
-- "does narrow-only leave the club in the old model because nobody assigns
-- anything?" and "is there a safer sequencing, e.g. enforcement behind a
-- flag?"). The NULL default already IS the flag, and a better one: it is
-- per-person rather than global, it is set from the console instead of from a
-- deploy, and turning it back off is the same one-click act as turning it on.
-- A separate flag would add a second thing that can disagree with the column
-- about who is narrowed — and the failure mode of that disagreement is somebody
-- believing an exec is restricted when they are not.
--
-- The "nobody ever assigns one" risk is real and is answered by making the
-- assignment visible and cheap: /permissions is a top-level admin page listing
-- every exec, not a field buried in a dialog. If the club never uses it, the
-- app behaves exactly as it does today, which is the outcome this design
-- deliberately prefers to a migration that guesses at four people's jobs.
--
-- ONE COLUMN, NOT AN ARRAY (design open question 2 — "should a person be able to
-- hold more than one portfolio?"). A single text column is the plain reading of
-- the design, and the two-jobs case already has an honest answer: leave that
-- person NULL. Someone who does Finance AND External is not narrowed, which is
-- what "they do both jobs" means, and it is the fail-safe direction. text ->
-- text[] is a purely additive migration if a real three-way split ever appears;
-- an array shipped speculatively would have to be got right in the guard
-- trigger, the editor and every comparison for a case the club does not have.
--
-- THREE PARTS:
--   1. players.portfolio, with a CHECK that pins the closed set.
--   2. admin_portfolio(), the middleware/nav counterpart to admin_access_level().
--   3. portfolio added to guard_player_privileged_columns.
--
-- (3) is the important one: portfolio is a privilege column and belongs beside
-- role / is_exec / is_trainer / exec_title. Without it, players_update_own
-- (00005) lets any member PATCH their own row — and a narrowed exec could clear
-- their own portfolio and take back everything it was meant to hold back.
--
-- THE FUNCTION BODY BELOW IS THE LIVE DEFINITION, DUMPED FROM THE PRODUCTION
-- DATABASE ON 2026-08-09 (identical to staging, hashes compared), WITH THE
-- portfolio LINES ADDED AND NOTHING ELSE CHANGED. CREATE OR REPLACE takes the
-- whole body, so a line dropped from memory is a guard silently removed — see
-- the header of 00072, where a reconstruction from memory would have dropped
-- status, is_banned and active_flag.
-- ============================================================

-- 1. THE COLUMN -----------------------------------------------------------
--
-- Nullable with no default, and NULL is load-bearing: it means "not narrowed".
-- The CHECK is what makes the set closed — a typo'd portfolio is not a weaker
-- portfolio, it is a string nothing matches, and the app would leave its holder
-- with the baseline and nothing else. Refuse it here instead.
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS portfolio TEXT;

ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_portfolio_check;
ALTER TABLE public.players ADD CONSTRAINT players_portfolio_check
  CHECK (portfolio IS NULL OR portfolio IN ('finance', 'tournaments', 'internal', 'external'));

COMMENT ON COLUMN public.players.portfolio IS
  'Exec portfolio: finance | tournaments | internal | external, or NULL for an exec who is not narrowed at all. NARROWS an exec and never widens anyone — NULL is exactly the access every exec had before this column existed. Ignored for admins (superusers) and trainers (hold none). Privileged: guarded by guard_player_privileged_columns and writable only by setPlayerPortfolio() in the admin console, which is admin-only and audited.';

-- 2. admin_portfolio() ----------------------------------------------------
--
-- The middleware and the sidebar already ask admin_access_level() for the level;
-- this is the same question for the second axis. Separate function rather than a
-- wider return from admin_access_level(): that function's return value is fed
-- straight into canAccess() and its exact strings are pinned by a test, and the
-- callers only need this one when the level is 'exec' — so admins and trainers
-- pay for no extra round trip at all.
--
-- Deliberately DOES NOT re-check standing. A row that fails the standing gate
-- has no level, admin_access_level() returns NULL for it, and canAccess() is
-- false for every path before this value is ever consulted. Answering the
-- narrower question only keeps the two functions from drifting into two
-- different ideas of good standing.
CREATE OR REPLACE FUNCTION public.admin_portfolio(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT portfolio FROM players WHERE user_id = p_user_id;
$function$;

COMMENT ON FUNCTION public.admin_portfolio(UUID) IS
  'The exec portfolio a user holds, or NULL for none. Companion to admin_access_level(): the level says which sections are in reach, this says which of them the portfolio covers. NULL means not narrowed.';

GRANT EXECUTE ON FUNCTION public.admin_portfolio(UUID) TO authenticated;

-- 3. THE GUARD ------------------------------------------------------------

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
       -- ADDED IN 00086. A self-created row cannot be an exec at all (is_exec is
       -- refused above), so a portfolio on one is meaningless — but it must not
       -- be a way to pre-stage a value that becomes live the moment an admin
       -- grants is_exec.
       OR NEW.portfolio IS NOT NULL THEN
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
     -- THE 00086 ADDITION. This column is what narrows an exec, so an unguarded
     -- write is the narrowing undoing itself: the exec whose access it limits is
     -- precisely the person with a motive to clear it, and clearing it hands
     -- them back every section the club just took away.
     OR NEW.portfolio    IS DISTINCT FROM OLD.portfolio
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.guard_player_privileged_columns() IS
  'Blocks a member from granting themselves privilege via a direct PostgREST write to their own players row. Replaced wholesale on every change: CREATE OR REPLACE takes the whole body, so a column omitted here loses its protection silently. Dump the live definition before editing.';

-- PostgREST caches the schema, and BOTH new things here are reached through it:
-- players.portfolio (the console selects and writes the column) and
-- admin_portfolio() (the middleware and the sidebar call it by RPC). Without
-- this the column and the function exist in Postgres while every request still
-- gets PGRST202/PGRST204 — and the app is written to fail OPEN on exactly that
-- error, so the symptom would be "portfolios silently do nothing", which is
-- indistinguishable from "nobody has been assigned one yet". Same reasoning as
-- 00064. Cheap and idempotent.
NOTIFY pgrst, 'reload schema';
