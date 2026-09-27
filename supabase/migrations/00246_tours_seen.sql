-- 00246_tours_seen.sql
--
-- The member app and the console each get a short guided tour that starts on
-- its own the first time somebody arrives, and never again after they finish
-- or skip it. "Never again" has to survive a new phone, a cleared browser and
-- a second device, so it lives on the player row rather than in localStorage
-- alone (the apps still keep a local copy, so a failed write does not replay
-- the tour on every page load).
--
-- ONE JSONB COLUMN, NOT A BOOLEAN PER TOUR. The keys are tour VERSIONS
-- (member_v1, exec_v1). A tour rewritten enough to be worth showing again
-- ships as member_v2 and every member sees it once, with no migration. The
-- value is when that tour was first finished or skipped, which is the only
-- thing anyone would ask of it.
--
-- NO GRANT, AND NOT IN THE GUARD. Members write 12 columns directly since
-- 00182; this is not one of them. The only writer is mark_tour_seen() below,
-- called by the service role from a server action that resolves the player
-- from the session and takes no id from the client. The column is not
-- privileged either: a member who could set it would only stop a tour
-- auto-starting for themselves. So guard_player_privileged_columns is left
-- UNCHANGED, the same as onboarding_completed, passkey_setup and skill_tier,
-- which it does not list.
--
-- NO BACKFILL. Existing members and execs start at '{}' and see each tour once.

BEGIN;

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS tours_seen jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Named, and added separately so a re-run on a database that already has the
-- column is still a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.players'::regclass
      AND conname = 'players_tours_seen_is_object'
  ) THEN
    ALTER TABLE public.players
      ADD CONSTRAINT players_tours_seen_is_object
      CHECK (jsonb_typeof(tours_seen) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN public.players.tours_seen IS
  'Guided tours this member has finished or skipped. Keys are tour versions '
  '(member_v1, exec_v1), values the first-seen time. Written only by '
  'mark_tour_seen(), service role. Not privileged, so not in the guard trigger.';

-- Stamps one tour as seen. Idempotent: a second call keeps the FIRST time, so
-- a replay from Settings (which does not call this anyway) or a double submit
-- cannot move it.
--
-- Takes the player id as a parameter, so it is an impersonation primitive the
-- moment a member can reach it. It is service role only, and both callers
-- resolve the id from the session themselves.
CREATE OR REPLACE FUNCTION public.mark_tour_seen(p_player_id uuid, p_tour text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_seen jsonb;
BEGIN
  IF p_tour IS NULL OR p_tour !~ '^(member|exec)_v[0-9]{1,3}$' THEN
    RAISE EXCEPTION 'Unknown tour key: %', p_tour;
  END IF;

  UPDATE players
     SET tours_seen = tours_seen
       || jsonb_build_object(p_tour, COALESCE(tours_seen -> p_tour, to_jsonb(now())))
   WHERE id = p_player_id
  RETURNING tours_seen INTO v_seen;

  IF v_seen IS NULL THEN
    RAISE EXCEPTION 'Player % not found', p_player_id;
  END IF;

  RETURN v_seen;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_tour_seen(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_tour_seen(uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFYING IT
--
-- The column exists, is NOT NULL and defaults to an empty object:
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'players' AND column_name = 'tours_seen';
--   -- expect tours_seen | jsonb | NO | '{}'::jsonb
--
-- Nobody has seen a tour yet:
--
--   SELECT count(*) FROM players WHERE tours_seen <> '{}'::jsonb;
--   -- expect 0
--
-- Only the service role can call the function. Read the ACL, not
-- information_schema:
--
--   SELECT proacl FROM pg_proc WHERE proname = 'mark_tour_seen';
--   -- expect postgres and service_role only, no anon, no authenticated
-- ============================================================================
