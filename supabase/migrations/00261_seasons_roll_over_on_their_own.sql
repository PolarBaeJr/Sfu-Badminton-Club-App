-- ============================================================
-- 00261: a season that has ended hands over on its own
--
-- Formerly 00219 on PR #35, written 2026-09-09 and renumbered to 00261 when it
-- was brought into the 1.1.0 release: by then 00220 onward had shipped, so a
-- file at 00219 would sort into history behind migrations that are already
-- applied. 00220 still refers to "00219's rollover"; that is this file.
--
-- Summer 2026 ended 2026-08-31 and was still `active_flag = TRUE` on 09-09,
-- nine days later, with Fall 2026 sitting in the table unused. Every session,
-- match, tournament and fee filed in those nine days was stamped with the
-- wrong season, and nothing anywhere said so.
--
-- That was not a bug in the sense of code doing the wrong thing. Activation
-- has ALWAYS been manual: `setActiveSeason` is an admin action behind
-- `seasons.activate.write`, and no scheduled job has ever driven it. The
-- rollover was a thing a person had to remember on a specific day, four times
-- a year, and the first time it mattered the person did not remember.
--
-- ---- WHY THIS IS SQL AND NOT ANOTHER /api/cron ENDPOINT ----
--
-- The other jobs POST to the app because the work is out there: emails,
-- Discord posts, push notifications. This work is entirely inside the
-- database: `activate_season` is already an atomic RPC that does all of it.
-- Going out through pg_net to come straight back would add both of the
-- failure modes this repo has already been bitten by: pg_net follows
-- redirects so a 200 proves nothing, and the internal admin alias is not
-- durable across autoupdated containers. A plpgsql function called directly
-- by cron has neither, and it runs in ONE transaction with the flip.
--
-- ---- WHEN IT ROLLS: ALL FOUR, OR NOTHING ----
--
--   1. there is an active season, and
--   2. its end_date is not null and is strictly BEFORE the club's today, and
--   3. some other season starts on or before the club's today, and
--   4. that season starts AFTER the outgoing one did.
--
-- (2) is what makes a null end_date safe. An open-ended season is a season
-- nobody has decided the end of, and guessing is worse than waiting.
--
-- (3) is why the last season of the year does not strand the club: Fall 2026
-- ends 2026-12-31 and there is no Spring 2027 row yet, so this does nothing
-- at all until somebody creates one. It NEVER deactivates a season without a
-- successor to hand to. "No active season" is a state half the app has to
-- special-case, and reaching it automatically would be a worse outcome than
-- the stale season this migration exists to prevent.
--
-- (4) picks the successor deterministically when several qualify: the
-- EARLIEST start_date after the outgoing one, so a club that creates Spring
-- and Summer together rolls into Spring, not past it into Summer.
--
-- `hidden_flag` (00234) is deliberately NOT a condition. It is a publication
-- decision about the player-facing history, and its column comment says not to
-- drive anything else from it.
--
-- A skip is silent. This runs daily and will skip on ~360 of 365 days; an
-- audit row for each would bury the five that matter.
--
-- ---- THE POLICY IS `carry`, AND THAT IS A DELIBERATE DEFAULT ----
--
-- `activate_season` takes carry | soft | full. An unattended job must not pick
-- one that rewrites ratings:
--   * `full` puts EVERY player on the flat baseline
--     (rating_defaults.default_elo), marks them provisional and, since 00236,
--     zeroes every per-season counter. That silently demotes anyone seeded
--     above the baseline by their signup tier.
--   * `soft` compresses the whole ladder toward the club mean.
-- Either is a decision about the club's competitive record, and a cron job in
-- the small hours is the wrong thing to be making it. `carry` moves the season
-- pointer and leaves every rating alone, which is what "the season changed"
-- means to everyone who is not an exec. The snapshot into
-- season_final_ratings still happens under carry, so the closing ladder is
-- preserved either way.
--
-- Override it in platform_settings if the club decides otherwise:
--   UPDATE platform_settings
--      SET value = jsonb_set(value, '{auto_rollover_policy}', '"soft"')
--    WHERE key = 'season_settings';
-- An unrecognised value does NOT fall back silently; see the RAISE below.
--
-- ---- INTERACTION WITH A MANUAL ACTIVATION ----
--
-- The console's Activate button stays exactly as it is, and the two paths land
-- in the same place. If an exec has already activated the successor, (1)+(2)
-- no longer hold and the job is a no-op. If nobody has, the job performs that
-- activation with `carry` at the next scheduled run.
--
-- ---- SAFE TO APPLY AT ANY TIME, AND TO RE-RUN ----
--
-- Creates one function and one daily job, and adds two keys to an existing
-- settings row. Applying it does not itself change any season: the first
-- opportunity is the next 09:10 UTC. Re-running it keeps whatever the two keys
-- were already set to. To disable without unscheduling:
--   UPDATE platform_settings
--      SET value = jsonb_set(value, '{auto_rollover_enabled}', 'false')
--    WHERE key = 'season_settings';
-- ============================================================

BEGIN;

-- Two new keys on the existing row. The defaults go on the LEFT of `||` so a
-- key already present on the row wins: re-running this file must not re-enable
-- a job somebody switched off, or reset a policy somebody chose. COALESCE on
-- read below means the function is correct even if the row is missing entirely.
UPDATE platform_settings
   SET value = jsonb_build_object(
                 'auto_rollover_enabled', TRUE,
                 'auto_rollover_policy',  'carry'
               ) || value,
       updated_at = NOW()
 WHERE key = 'season_settings';

CREATE OR REPLACE FUNCTION public.auto_rollover_season()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today       date;
  v_policy      text;
  v_prev        seasons%ROWTYPE;
  v_next        seasons%ROWTYPE;
BEGIN
  IF NOT platform_setting_bool('season_settings', 'auto_rollover_enabled', TRUE) THEN
    RETURN jsonb_build_object('rolled', FALSE, 'reason', 'disabled');
  END IF;

  -- The club's calendar date, not the server's UTC one: the same rule
  -- endSeason() follows with clubToday(). At the scheduled 09:10 UTC the UTC
  -- date and the Vancouver date are the same day, but reading the server's
  -- date in general would roll a season a day early whenever this runs in the
  -- UTC evening.
  --
  -- The club timezone by name, not a fixed offset. 00110 records that the
  -- database's tzdata predates BC dropping the winter fallback on 2026-11-01,
  -- so after that date this may read Vancouver as UTC-8 where the truth is
  -- UTC-7. At the scheduled minute that is 01:10 against 02:10 local, the
  -- same date either way. Only a manual call between 07:00 and 08:00 UTC could
  -- see yesterday's date, and that errs toward rolling a day LATE, never early.
  v_today := (NOW() AT TIME ZONE 'America/Vancouver')::date;

  -- One writer at a time. `seasons_single_active_idx` is a partial unique index
  -- on active_flag, so two concurrent activations are not merely racy, one of
  -- them fails outright. Transaction-scoped: released at COMMIT or ROLLBACK,
  -- with nothing to clean up if this function raises.
  PERFORM pg_advisory_xact_lock(hashtext('auto_rollover_season'));

  SELECT * INTO v_prev FROM seasons WHERE active_flag = TRUE LIMIT 1;
  IF v_prev.id IS NULL THEN
    RETURN jsonb_build_object('rolled', FALSE, 'reason', 'no active season');
  END IF;
  IF v_prev.end_date IS NULL OR v_prev.end_date >= v_today THEN
    RETURN jsonb_build_object('rolled', FALSE, 'reason', 'active season has not ended');
  END IF;

  SELECT * INTO v_next
    FROM seasons
   WHERE id <> v_prev.id
     AND start_date <= v_today
     AND start_date >  v_prev.start_date
   ORDER BY start_date ASC, created_at ASC
   LIMIT 1;
  IF v_next.id IS NULL THEN
    RETURN jsonb_build_object('rolled', FALSE, 'reason', 'no successor season has started');
  END IF;

  -- No platform_setting_text() helper exists; read the jsonb directly. Validate
  -- here rather than letting activate_season raise: a typo in the panel would
  -- otherwise turn into a job that fails at the same minute every night with
  -- nothing but a pg_cron run record to say why.
  SELECT COALESCE(value->>'auto_rollover_policy', 'carry') INTO v_policy
    FROM platform_settings WHERE key = 'season_settings';
  v_policy := COALESCE(v_policy, 'carry');
  IF v_policy NOT IN ('carry', 'soft', 'full') THEN
    RAISE EXCEPTION 'auto_rollover_season: season_settings.auto_rollover_policy is %, expected carry|soft|full', v_policy;
  END IF;

  -- Snapshots the outgoing ladder, flips both flags, applies the policy. Same
  -- call the console makes (activate_season(uuid, text, numeric) as of 00236,
  -- the compression factor left to its panel default); nothing here
  -- reimplements any of it.
  PERFORM activate_season(v_next.id, v_policy);

  -- actor_id NULL is the established "a scheduled job did this" shape; the
  -- admin log renders it as System. Same action_type the console writes, so
  -- these rows sit in the existing filter alongside the manual ones instead of
  -- forming a second vocabulary for the same event.
  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, old_value, new_value, reason)
  VALUES (
    NULL,
    'season_activated',
    'season',
    v_next.id,
    jsonb_build_object('season', v_prev.name, 'end_date', v_prev.end_date),
    jsonb_build_object('season', v_next.name, 'elo_policy', v_policy, 'automatic', TRUE),
    format('Automatic rollover: %s ended %s, %s started %s.',
           v_prev.name, v_prev.end_date, v_next.name, v_next.start_date)
  );

  RETURN jsonb_build_object(
    'rolled', TRUE,
    'from',   v_prev.name,
    'to',     v_next.name,
    'policy', v_policy
  );
END;
$function$;

COMMENT ON FUNCTION public.auto_rollover_season() IS
  'Daily: activates the next season once the active one''s end_date has passed and a successor has started. Policy from season_settings.auto_rollover_policy (default carry). No-op unless all four conditions hold; see 00261.';

-- Nobody but the scheduler and service_role calls this. It is SECURITY DEFINER
-- and it moves the season pointer for the whole club, which is precisely the
-- reach `seasons.activate.write` gates in the console. anon and authenticated
-- are named explicitly because Supabase's default privileges grant both
-- directly, and a PUBLIC revoke alone removes neither (00126).
REVOKE ALL ON FUNCTION public.auto_rollover_season() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_rollover_season() TO service_role;

-- Unschedule first so re-running this file edits the job rather than failing on
-- a duplicate name.
SELECT cron.unschedule('season-rollover')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'season-rollover');

-- 09:10 UTC is 02:10 America/Vancouver. Fixed UTC is safe here for 00166's
-- reason: BC drops the winter fallback from 2026-11-01, so the local hour does
-- not drift. Clear of every other job: inactivity-notices 04:20, discord-role-
-- sync 10:50, the five-minute relays, and the Monday digest window.
-- The minute matters less than the DATE: this is comfortably after midnight in
-- the club's own timezone, so a season that ended "yesterday" has genuinely
-- ended by the time this reads the calendar.
SELECT cron.schedule(
  'season-rollover',
  '10 9 * * *',
  $$SELECT public.auto_rollover_season();$$
);

COMMIT;

NOTIFY pgrst, 'reload schema';
