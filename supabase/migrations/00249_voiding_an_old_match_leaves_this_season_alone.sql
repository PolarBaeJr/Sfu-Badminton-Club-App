-- 00249: voiding a match from a past season no longer moves this season's Elo.
--
-- reverse_match_result subtracted each participant's rating_delta from their
-- LIVE row in `ratings`, whatever season the match was played in. `ratings`
-- is one row per player and carries on across seasons (activate_season
-- archives it into season_final_ratings, then carries, compresses or resets
-- it). So voiding a Summer match in Fall took Summer's points out of the Fall
-- ladder, and after a full reset it could push a fresh rating below the
-- baseline for a game that never happened in this season.
--
-- Now:
--   * a match whose season is the ACTIVE season, a match with no season, or
--     any match while no season is active: unchanged, the live rating moves.
--     No active season means nothing has been archived since, so the live row
--     still IS the latest season's rating.
--   * a match from any OTHER season: the live rating is left alone and the
--     delta comes off that season's archived final rating instead, so the old
--     season's final standings still reflect the void. A player with no
--     archived row for that season (the season was never closed through
--     activate_season) simply has nothing to correct.
--
-- Counters are untouched here, as before: 00119 derives them from
-- result_status, which this still sets to 'voided'.
--
-- Callers are unchanged: void_club_match (00203) and the dispute resolution
-- paths reach this function, and they all inherit the rule.
--
-- CREATE OR REPLACE keeps the function's ACL, but the REVOKE and GRANT from
-- 00018 and 00131 are restated so this file stands on its own. Both name
-- PUBLIC and anon: revoking from one does not revoke from the other.

BEGIN;

CREATE OR REPLACE FUNCTION public.reverse_match_result(p_match_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match RECORD;
  v_participant RECORD;
  v_elo_field TEXT;
  v_active_season uuid;
  v_past_season boolean;
BEGIN
  SELECT * INTO v_match FROM matches WHERE id = p_match_id;
  IF v_match IS NULL THEN RAISE EXCEPTION 'Match not found'; END IF;
  IF v_match.result_status != 'confirmed' THEN RAISE EXCEPTION 'Can only reverse confirmed matches'; END IF;

  v_elo_field := CASE WHEN v_match.match_type = 'singles' THEN 'singles_elo' ELSE 'doubles_elo' END;

  SELECT id INTO v_active_season FROM seasons WHERE active_flag = TRUE LIMIT 1;
  v_past_season := v_match.season_id IS NOT NULL
                   AND v_active_season IS NOT NULL
                   AND v_match.season_id <> v_active_season;

  FOR v_participant IN SELECT * FROM match_participants WHERE match_id = p_match_id AND rating_delta IS NOT NULL LOOP
    IF v_past_season THEN
      EXECUTE format(
        'UPDATE season_final_ratings SET %I = %I - $1 WHERE season_id = $2 AND player_id = $3',
        v_elo_field, v_elo_field)
      USING v_participant.rating_delta, v_match.season_id, v_participant.player_id;
    ELSE
      EXECUTE format('UPDATE ratings SET %I = %I - $1, updated_at = NOW() WHERE player_id = $2', v_elo_field, v_elo_field)
      USING v_participant.rating_delta, v_participant.player_id;
    END IF;
  END LOOP;

  UPDATE matches SET result_status = 'voided', updated_at = NOW() WHERE id = p_match_id;

  INSERT INTO audit_logs (actor_id, action_type, target_type, target_id, reason)
  VALUES (NULL, 'match_reversed', 'match', p_match_id,
          CASE WHEN v_past_season
               THEN 'Match result reversed by admin; past season, only that season''s final ratings were corrected'
               ELSE 'Match result reversed by admin' END);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reverse_match_result(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reverse_match_result(uuid) TO service_role;

DO $verify$
DECLARE
  v_acl text;
  v_src text;
BEGIN
  SELECT proacl::text, prosrc INTO v_acl, v_src
    FROM pg_proc WHERE oid = 'public.reverse_match_result(uuid)'::regprocedure;
  IF v_acl ~ '(^|[{,])=X' THEN
    RAISE EXCEPTION '00249: PUBLIC can still execute reverse_match_result: %', v_acl;
  END IF;
  IF v_acl ~ 'anon=' OR v_acl ~ 'authenticated=' THEN
    RAISE EXCEPTION '00249: anon or authenticated can still execute reverse_match_result: %', v_acl;
  END IF;
  IF v_src NOT LIKE '%season_final_ratings%' THEN
    RAISE EXCEPTION '00249: reverse_match_result was not replaced';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
