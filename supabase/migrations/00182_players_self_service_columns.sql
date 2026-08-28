-- ============================================================
-- 00182 — a member may update the twelve columns their own screens write,
--         and nothing else
--
-- Audit F-011. `authenticated` holds UPDATE (and DELETE, and MAINTAIN) on the
-- WHOLE of public.players. RLS scopes that to the caller's own row, and
-- guard_player_privileged_columns() refuses the privileged columns — so the
-- escalation paths are closed. What is not closed is everything the guard was
-- never written to name, because a grant this wide means the guard has to
-- enumerate every column that must not move, forever, and a column added
-- tomorrow is writable the moment it exists.
--
-- The columns reachable today that nothing in the app ever asks a member to
-- write: email, user_id, id, joined_at, inactive_since,
-- inactivity_notice_sent_at, banned_at, banned_by, ban_reason, passkey_setup,
-- skill_tier, notification_preferences, created_at, profile_visibility,
-- show_activity_status. `UPDATE players SET id = gen_random_uuid()` is the
-- sharpest of them: the WITH CHECK on players_update_own tests user_id and
-- nothing else, so the row's identity is not what stops it.
--
-- HOW A MEMBER REACHES IT AT ALL, since `authenticated` has no SELECT here:
-- an UNQUALIFIED `UPDATE players SET <col> = ...` needs no SELECT, and the
-- policy supplies the WHERE. 00164 established that empirically — one row
-- cleared, as a plain 'player', on staging.
--
-- THE FIX INVERTS THE DEFAULT. Instead of naming what a member may not touch,
-- name what they may: the twelve columns the player app actually writes with
-- the member's own session. Everything else — present and future — needs the
-- service role, which is the console, the cron routes, and SECURITY DEFINER
-- functions. A column added next month is unwritable by members until somebody
-- deliberately adds it here.
--
-- THIS DOES NOT REPLACE THE TRIGGER. 00164 argued a grant change "would work
-- for this one field and leave the next column added to this table in the same
-- position". That was an argument for the trigger over a single-column revoke,
-- and it holds. Both stay: the grant decides what may appear in a member's
-- UPDATE at all, the trigger decides what a privileged column may become no
-- matter who is writing it — including inside a SECURITY DEFINER function,
-- where grants have already been satisfied by the owner.
--
-- THE TWELVE, and where each is written:
--   avatar_url            AvatarUpload.tsx
--   first_name last_name  updateProfile, completeOnboarding
--   display_name          completeOnboarding (legacy; 00092 retired the field)
--   handle                updateProfile
--   phone                 updateProfile, completeOnboarding
--   bio                   updateProfile
--   hide_from_leaderboard updateProfile
--   competition_category  updateProfile (00129 makes it write-once anyway)
--   onboarding_completed  completeOnboarding
--   exec_bio              updateExecBio (00130 — an exec editing their own)
--   last_active_at        checkInToSession
--
-- DELIBERATELY ABSENT, though a member's action causes them to move:
--   notification_preferences  merge_my_notification_preferences (00180)
--   skill_tier                apply_skill_tier_seed (00127)
--   passkey_setup             recordPasskeySetup, service role on purpose
--   deletion_requested_at active_flag  deleteMyAccount, service role
-- all four already go through a definer function or the service role, and
-- 00180 moved the last of them off the member's own client this week.
--
-- updated_at is not in the list and does not need to be: the touch trigger
-- writes NEW.updated_at, and column privileges are checked against the
-- statement's target list, not against what a BEFORE trigger assigns.
-- ============================================================

BEGIN;

-- Fail rather than silently grant a column that has since been renamed away.
-- plpgsql would not catch this; GRANT on a missing column errors, but only for
-- the first one, and the message would not say why the list is authoritative.
DO $precheck$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY[
      'avatar_url','bio','competition_category','display_name','exec_bio',
      'first_name','handle','hide_from_leaderboard','last_active_at',
      'last_name','onboarding_completed','phone'
    ]) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'players' AND column_name = c
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      '00182: public.players is missing %. The self-service column list is out of date — reconcile it with the player app before granting.',
      v_missing;
  END IF;
END
$precheck$;

-- Table-wide UPDATE is the thing being removed. DELETE and MAINTAIN go with it:
-- nothing in any app deletes a players row with the member's own client (the
-- console does it under the service role), and MAINTAIN arrived from a blanket
-- GRANT ALL rather than from a decision.
REVOKE UPDATE, DELETE, MAINTAIN ON public.players FROM authenticated;

GRANT UPDATE (
  avatar_url,
  bio,
  competition_category,
  display_name,
  exec_bio,
  first_name,
  handle,
  hide_from_leaderboard,
  last_active_at,
  last_name,
  onboarding_completed,
  phone
) ON public.players TO authenticated;

-- anon holds nothing here (00131) and this migration does not change that.
-- Stated so the next reader does not have to go and check.

COMMIT;

NOTIFY pgrst, 'reload schema';
