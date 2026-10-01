-- ============================================================
-- 00274: AN EXTERNAL TEAM IS ENTERED WITH ITS CATEGORY
--
-- A staged event (00272) gives each team a category (team_category) so the
-- stage's head starts know who starts on what. A member pair's category can be
-- worked out from its members; an external team has no members, so the
-- organiser has to say it, and the natural moment is when the team is typed in.
--
-- WHAT CHANGES.
--   * add_external_tournament_pair_v2: add_external_tournament_pair (00269)
--     with one more argument, p_category. It is a THIN WRAPPER: it calls the
--     00269 function, which stays the only writer of an external pair and keeps
--     every check and lock it already takes, and then sets team_category on the
--     row it returned. Both run in the caller's one transaction, so a category
--     refused here takes the new pair with it.
--   * The category is refused unless the event is staged and the key is one of
--     the event's format_config categories (mens, womens and mixed when the
--     config lists none, matching the app's schema default).
--
-- WHY A NEW NAME. Images update before migrations run. A running image calls
-- the 00269 function with five named arguments; changing that function's
-- signature would break it until this file was applied. New code calls v2
-- and falls back to the 00269 function when v2 is missing and no category was
-- asked for.
--
-- NEW FUNCTION (service_role only).
--   * add_external_tournament_pair_v2(uuid, text, text, uuid, text, text)
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.add_external_tournament_pair_v2(
  p_event_id uuid, p_external1_name text, p_external2_name text, p_added_by uuid,
  p_team_name text DEFAULT NULL, p_category text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cat    text;
  v_pair   uuid;
  v_format text;
  v_config jsonb;
  v_keys   text[];
BEGIN
  v_cat := NULLIF(btrim(COALESCE(p_category, '')), '');

  v_pair := public.add_external_tournament_pair(
    p_event_id, p_external1_name, p_external2_name, p_added_by, p_team_name
  );
  IF v_cat IS NULL THEN
    RETURN v_pair;
  END IF;

  -- The event row is already locked FOR UPDATE by the call above.
  SELECT format, format_config INTO v_format, v_config
    FROM tournament_events WHERE id = p_event_id;
  IF v_format IS DISTINCT FROM 'staged' THEN
    RAISE EXCEPTION 'A category applies to staged events only.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF jsonb_typeof(v_config -> 'categories') = 'array' THEN
    SELECT COALESCE(array_agg(c ->> 'key'), ARRAY[]::text[]) INTO v_keys
      FROM jsonb_array_elements(v_config -> 'categories') c;
  ELSE
    v_keys := ARRAY['mens', 'womens', 'mixed'];
  END IF;
  IF NOT (v_cat = ANY (v_keys)) THEN
    RAISE EXCEPTION '"%" is not a category of this event.', v_cat
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE tournament_pairs SET team_category = v_cat WHERE id = v_pair;

  RETURN v_pair;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_external_tournament_pair_v2(uuid, text, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_external_tournament_pair_v2(uuid, text, text, uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.add_external_tournament_pair_v2(uuid, text, text, uuid, text, text) IS
  'add_external_tournament_pair (00269) plus the team category of a staged event. Refuses a category on a non-staged event or one the event does not list. Service role only.';

-- ============================================================
-- VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_bad text[] := ARRAY[]::text[];
  v_new text := 'public.add_external_tournament_pair_v2(uuid, text, text, uuid, text, text)';
  v_old text := 'public.add_external_tournament_pair(uuid, text, text, uuid, text)';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = v_new::regprocedure
       AND prosecdef
       AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%')
  ) THEN
    v_bad := array_append(v_bad, 'add_external_tournament_pair_v2 is not SECURITY DEFINER with a pinned search_path');
  END IF;
  IF has_function_privilege('anon', v_new, 'EXECUTE')
     OR has_function_privilege('authenticated', v_new, 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'add_external_tournament_pair_v2 is callable beyond service_role');
  END IF;
  IF NOT has_function_privilege('service_role', v_new, 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'service_role cannot call add_external_tournament_pair_v2');
  END IF;

  -- The 00269 function stays, unchanged, for the images still calling it.
  IF to_regprocedure(v_old) IS NULL THEN
    v_bad := array_append(v_bad, 'add_external_tournament_pair (00269) is missing');
  ELSIF has_function_privilege('anon', v_old, 'EXECUTE')
     OR has_function_privilege('authenticated', v_old, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_old, 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'add_external_tournament_pair is no longer service_role only');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournament_pairs' AND column_name = 'team_category'
  ) THEN
    v_bad := array_append(v_bad, 'tournament_pairs.team_category is missing (run 00272 first)');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00274 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00274 verified: add_external_tournament_pair_v2 is service_role only and the 00269 function is still in place.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
