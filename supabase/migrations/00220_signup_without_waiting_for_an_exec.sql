-- ============================================================
-- 00220 — a signup can approve itself, while the club says it may
--
-- THE PROBLEM IS ARITHMETIC. Every account today lands in
-- `pending_approval` and stays there until an exec opens the console and
-- presses Approve, one member at a time. That is the right shape for a club
-- that gains a member a week. It is the wrong shape for the first week of a
-- semester, where a few hundred people sign up in three days and every one of
-- them is locked out of the ladder, the session list and the fee ledger until
-- somebody works through the queue by hand.
--
-- So this adds a switch: while `signup_settings.auto_approve_enabled` is on, a
-- member who FINISHES ONBOARDING is approved in the same statement that records
-- them as finished. Turning it off restores today's behaviour exactly — the
-- next signup after the toggle flips waits for an exec like every signup before
-- it. Nothing here is retroactive in either direction.
--
-- ---- WHY IT FIRES ON ONBOARDING AND NOT ON THE ROW ----------------
--
-- 00132's header calls `status = 'pending_approval'` at row creation "the
-- single most load-bearing choice in the file", and it is right. The row that
-- `ensure_player_for_user` writes at FIRST SIGN-IN is a stub: first_name = '',
-- no phone, no waiver, no skill tier. `pending_approval` is what keeps that
-- stub out of get_leaderboard, out of the ladder spread, out of the fee ledger
-- and out of every opponent and attendee picker. Approving at insert — or
-- changing the column default — would put a blank-named ghost on the roster for
-- every person who ever clicks a magic link and closes the tab.
--
-- `onboarding_completed` going FALSE -> TRUE is the moment there is a person
-- behind the row: a name, a waiver acceptance, an age attestation and a claimed
-- skill tier. That transition is the trigger condition, and the INSERT arm
-- exists only because create_player_with_rating (00023) inserts with
-- onboarding_completed already TRUE on the fallback path in
-- completeOnboarding().
--
-- ---- WHY A TRIGGER AND NOT APP CODE -------------------------------
--
-- Because it has to be reversible without a deploy. The club needs this on for
-- a launch week and off afterwards, and "off" must be a toggle an exec can
-- reach at 9pm, not a release. The setting row below renders on the admin
-- Accounts page on its own (platform-setting-sections.ts DEFAULT_SECTION), so
-- the switch has a UI the moment this migration lands, with the console's usual
-- typed reason and audit row.
--
-- ---- HOW IT GETS PAST guard_player_privileged_columns -------------
--
-- READ THIS BEFORE RENAMING EITHER TRIGGER.
--
-- 00018/00164's guard is a BEFORE trigger on players that raises
-- 'Not authorized to modify privileged player fields' whenever NEW.status
-- differs from OLD.status for anyone who is not an admin and not the service
-- role. The member finishing onboarding is neither: completeOnboarding() writes
-- `onboarding_completed` through the MEMBER'S OWN client (profile.ts:511), so
-- current_user is 'authenticated' and auth.uid() is their id.
--
-- PostgreSQL fires BEFORE row triggers in alphabetical order by trigger name.
-- 'guard_player_privileged_columns_trg' and 'guard_player_privileged_insert_trg'
-- both sort before 'self_serve_auto_approve_*', so the guard runs FIRST and sees
-- exactly what the member asked for — status unchanged, member_code unchanged —
-- and passes. This trigger then applies club policy to a row the guard has
-- already cleared.
--
-- That ordering is the whole mechanism, so the DO block at the bottom asserts
-- it rather than trusting it. It is also, deliberately, not a hole in the
-- guard: the guard's job is to refuse what a MEMBER ASKS FOR, and nothing here
-- is reachable from anything a member can send. The status is read from
-- platform_settings, never from the request.
--
-- For the same reason the member's own column grants are irrelevant. 00182
-- revoked UPDATE on all but twelve columns of players from `authenticated`, and
-- `status` is not among them — but column privileges are checked against the
-- columns named in the statement, not against what a trigger later assigns.
--
-- ---- WHAT IT DOES, AND WHY IT IS THE SAME FIVE THINGS -------------
--
-- approvePlayerImpl (apps/admin/src/lib/actions/players.ts:37) is the canonical
-- approval and does five things. This does four of them:
--
--   status -> the configured division   the visible half
--   rosterRestoreColumns()              active_flag, last_active_at,
--                                       inactivity_notice_sent_at,
--                                       inactive_since — the four columns
--                                       packages/shared/src/utils/roster-restore.ts
--                                       exists to stop anyone writing only some of
--   member_code                         assigned once and permanent. my-stats
--                                       already special-cases "awaiting approval
--                                       has none"; an approved member with no code
--                                       would be a third state nothing handles
--   audit_logs 'player_approved'        actor_id NULL, which the console renders
--                                       as System — the same shape 00219's
--                                       rollover job writes. The club must be able
--                                       to see who came in without review
--
-- The fifth, the welcome email, is deliberately dropped. It exists because
-- console approval is silent and asynchronous — the member is told hours later
-- that something happened while they were away. Under auto-approval the member
-- is standing in the app when it happens and the next screen they see is the
-- one approval unlocks.
--
-- applySkillTier() runs after completeOnboarding()'s update returns and still
-- seeds the tier over the fresh rating — apply_skill_tier_seed declines only for
-- a rating that has already MOVED, and this one has not.
--
-- ---- AND init_player_records HAD TO BE WIDENED --------------------
--
-- 00001 seeds the ratings and reliability_metrics rows on approval from an
-- `AFTER UPDATE OF status` trigger. `UPDATE OF status` fires on the columns
-- NAMED IN THE STATEMENT, not on the columns that actually changed — and the
-- statement that finishes onboarding names `onboarding_completed` and
-- `first_name`. So the first rehearsal of this migration approved the member
-- correctly and left them with no reliability_metrics row, which is silent:
-- apply_match_result does a bare `UPDATE reliability_metrics ... WHERE
-- player_id = ...`, so a missing row is 0 rows updated and no error, and the
-- member's matches_completed never moves for as long as they are a member.
--
-- The column list is dropped below. The function already tests OLD.status
-- against NEW.status, so the list only ever narrowed WHEN it was consulted, and
-- narrowing it on the wrong axis is what broke. An INSERT arm goes in at the
-- same time and closes an older gap on the same rows: a player inserted already
-- approved — create_player_with_rating() with a division status, which is both
-- the console's createPlayer and this migration's INSERT arm — got a ratings row
-- from the function's own INSERT and never got a reliability_metrics row at all.
--
-- ---- WHAT IS DELIBERATELY NOT AUTO-APPROVED -----------------------
--
--   is_banned                   a ban placed before approval must survive it
--   privilege_claim_review      00132 writes this when a signup claimed a roster
--                               row that carried privileges. It is an exec's
--                               prompt to look, and looking is the one thing
--                               auto-approval skips
--   user_id IS NULL             an exec-created roster row has no account behind
--                               it; nobody signed up
--   status <> 'pending_approval' suspended stays suspended
--
-- ---- FAIL-SAFE, NOT FAIL-LOUD ------------------------------------
--
-- A bad auto_approve_status leaves the member pending and raises a WARNING to
-- the postgres log. It does NOT raise. This runs inside the statement that
-- finishes onboarding for every new member of the club, and a typo in a JSON
-- textarea must not be able to break signup for everybody — the worst outcome
-- it can produce is the behaviour that was in place before this file existed.
-- 00219's rollover does raise, because a cron job that stops is visible and an
-- onboarding that stops is a launch-day outage.
-- ============================================================

BEGIN;

-- ---- 1. The switch ------------------------------------------------
--
-- ON as shipped, because the club is asking for it for a launch week and a
-- migration that lands the mechanism switched off is a migration that has to be
-- followed by somebody remembering to switch it on. Accounts -> Signup Settings
-- turns it off, and the row is a plain platform_settings row so that is a
-- console edit with a typed reason, not SQL.
--
-- ON CONFLICT so re-running this file cannot silently flip a switch the club has
-- since turned off.
INSERT INTO public.platform_settings (key, value)
VALUES (
  'signup_settings',
  jsonb_build_object(
    'auto_approve_enabled', TRUE,
    'auto_approve_status',  'recreational'
  )
)
ON CONFLICT (key) DO NOTHING;

-- ---- 2. The approval ----------------------------------------------
CREATE OR REPLACE FUNCTION public.self_serve_auto_approve()
RETURNS trigger
LANGUAGE plpgsql
-- SECURITY DEFINER, unlike the guard beside it. The guard must NOT be definer
-- because its first branch tests current_user and an owner-resolved
-- current_user would return early for everybody. This one has the opposite
-- requirement: it reads platform_settings, calls derive_member_code (revoked
-- from anon and authenticated by 00092) and writes audit_logs, all while the
-- session on the other side of the statement is an ordinary member.
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status TEXT;
BEGIN
  -- Default FALSE, not TRUE: if the settings row is ever deleted, the club
  -- falls back to manual approval rather than to open enrolment.
  IF NOT public.platform_setting_bool('signup_settings', 'auto_approve_enabled', FALSE) THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.is_banned, FALSE)
     OR NEW.privilege_claim_review IS NOT NULL
     OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Read directly rather than through a helper: there is no
  -- platform_setting_text(), and adding one for a single call site would be a
  -- fourth helper to keep in step with the other three.
  SELECT COALESCE(value->>'auto_approve_status', 'recreational')
    INTO v_status
    FROM public.platform_settings
   WHERE key = 'signup_settings';
  v_status := COALESCE(v_status, 'recreational');

  IF v_status NOT IN ('competitive', 'recreational') THEN
    RAISE WARNING
      'self_serve_auto_approve: signup_settings.auto_approve_status is %, expected competitive or recreational — leaving % pending approval',
      v_status, NEW.id;
    RETURN NEW;
  END IF;

  NEW.status := v_status::player_status;

  -- rosterRestoreColumns(), in SQL. The four columns move together or the
  -- overnight jobs undo the fifth — see packages/shared/src/utils/roster-restore.ts.
  NEW.active_flag                := TRUE;
  NEW.last_active_at             := NOW();
  NEW.inactivity_notice_sent_at  := NULL;
  NEW.inactive_since             := NULL;
  NEW.updated_at                 := NOW();

  -- Assigned in place rather than by calling assign_member_code(), which
  -- UPDATEs the row it is given. From a BEFORE trigger that would be a nested
  -- write to the tuple currently being written, and on the INSERT arm the row
  -- does not exist yet for it to find. derive_member_code() already carries the
  -- collision loop; the residual race is two signups deriving the same code in
  -- the same instant, which the unique index refuses — one signup sees an error
  -- and retries, and the space is 30^7.
  IF NEW.member_code IS NULL THEN
    NEW.member_code := public.derive_member_code(NEW.id);
  END IF;

  INSERT INTO public.audit_logs (
    actor_id, action_type, target_type, target_id, old_value, new_value, reason
  ) VALUES (
    NULL,
    'player_approved',
    'player',
    NEW.id,
    jsonb_build_object('status', 'pending_approval'),
    jsonb_build_object('status', v_status, 'member_code', NEW.member_code),
    format(
      'Automatic approval: self-serve signup completed onboarding while signup_settings.auto_approve_enabled was on. Approved into %s with no exec review.',
      v_status
    )
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.self_serve_auto_approve() IS
  'Approves a signup into signup_settings.auto_approve_status at the moment onboarding_completed goes FALSE -> TRUE, while signup_settings.auto_approve_enabled is on. Does what approvePlayer() does minus the welcome email. Fires AFTER guard_player_privileged_columns_trg by trigger-name order; see 00220.';

DROP TRIGGER IF EXISTS self_serve_auto_approve_trg ON public.players;
CREATE TRIGGER self_serve_auto_approve_trg
  BEFORE UPDATE ON public.players
  FOR EACH ROW
  WHEN (
    COALESCE(NEW.onboarding_completed, FALSE) = TRUE
    AND COALESCE(OLD.onboarding_completed, FALSE) = FALSE
    AND OLD.status = 'pending_approval'
    AND NEW.status = 'pending_approval'
  )
  EXECUTE FUNCTION public.self_serve_auto_approve();

-- The fallback path in completeOnboarding(): when nothing was claimed at
-- sign-in it calls create_player_with_rating(), which inserts with
-- onboarding_completed = (p_user_id IS NOT NULL) — TRUE for a signup, and
-- FALSE for every row an exec pre-adds from the console.
DROP TRIGGER IF EXISTS self_serve_auto_approve_insert_trg ON public.players;
CREATE TRIGGER self_serve_auto_approve_insert_trg
  BEFORE INSERT ON public.players
  FOR EACH ROW
  WHEN (
    COALESCE(NEW.onboarding_completed, FALSE) = TRUE
    AND NEW.status = 'pending_approval'
  )
  EXECUTE FUNCTION public.self_serve_auto_approve();

-- ---- 3. The rows an approval is supposed to bring with it --------
--
-- See the header. Both statements are ON CONFLICT DO NOTHING, so this is
-- idempotent for every row that already has them.
CREATE OR REPLACE FUNCTION public.trigger_init_player_records()
RETURNS trigger
LANGUAGE plpgsql
-- BOTH LINES COPIED FROM THE LIVE FUNCTION, and both are load-bearing on a
-- CREATE OR REPLACE: attributes that are not restated revert to the defaults,
-- so omitting them would quietly downgrade a SECURITY DEFINER trigger to
-- INVOKER — and the member's own session holds no INSERT on ratings or
-- reliability_metrics, so onboarding would start failing on a permission error
-- from a file that never mentions either table.
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Inserted already approved: create_player_with_rating() with a division
  -- status. Its own INSERT covers ratings; nothing covered reliability_metrics.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_approval' THEN
      INSERT INTO ratings (player_id) VALUES (NEW.id) ON CONFLICT (player_id) DO NOTHING;
      INSERT INTO reliability_metrics (player_id) VALUES (NEW.id) ON CONFLICT (player_id) DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  -- When player moves from pending_approval to any active status
  IF OLD.status = 'pending_approval' AND NEW.status <> 'pending_approval' THEN
    INSERT INTO ratings (player_id) VALUES (NEW.id) ON CONFLICT (player_id) DO NOTHING;
    INSERT INTO reliability_metrics (player_id) VALUES (NEW.id) ON CONFLICT (player_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

-- WITHOUT `OF status`. That column list is the bug described in the header: it
-- matches the columns a statement NAMES, and the statement that approves a
-- self-serve signup names onboarding_completed.
DROP TRIGGER IF EXISTS init_player_records ON public.players;
CREATE TRIGGER init_player_records
  AFTER INSERT OR UPDATE ON public.players
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_init_player_records();

-- ---- 4. The ordering is the mechanism, so assert it ---------------
--
-- If either guard trigger is ever renamed to sort after these two, the guard
-- sees the status this trigger assigned, reads it as a member promoting
-- themselves, and raises — onboarding stops working for every new member, with
-- an error message about privileged fields that names nothing in this file.
-- Better to fail here, in a migration somebody is watching.
DO $ordering$
DECLARE
  v_bad TEXT;
BEGIN
  SELECT string_agg(g.tgname || ' >= ' || s.tgname, ', ')
    INTO v_bad
    FROM pg_trigger g
    JOIN pg_trigger s ON s.tgrelid = g.tgrelid
   WHERE g.tgrelid = 'public.players'::regclass
     AND NOT g.tgisinternal AND NOT s.tgisinternal
     AND g.tgname LIKE 'guard_player_privileged%'
     AND s.tgname LIKE 'self_serve_auto_approve%'
     AND g.tgname >= s.tgname;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION
      '00220: the privilege guard must fire BEFORE auto-approval, but trigger-name order says otherwise (%). Rename so every guard_player_privileged* sorts before every self_serve_auto_approve*.',
      v_bad;
  END IF;
END
$ordering$;

COMMIT;

NOTIFY pgrst, 'reload schema';
