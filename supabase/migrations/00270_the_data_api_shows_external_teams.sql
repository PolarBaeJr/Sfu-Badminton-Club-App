-- ============================================================
-- 00270 THE DATA API SHOWS EXTERNAL TEAMS
--
-- 00269 let an organiser enter a doubles team of non-members by name. Their
-- tournament_pairs row has both player ids NULL, so the 00266 readers dropped
-- them: data_api_published_player(NULL) is false, so an external team was left
-- out of the entrant list and every slot in an external draw came back
-- withheld. The event looked empty and its draw looked like a set of privacy
-- refusals, neither of which was true.
--
-- WHAT CHANGES.
--   * data_api_tournament_events gains external_event, so a consumer can tell
--     an unrated event from a rated one.
--   * data_api_tournament_entrants lists an external team with no player_refs,
--     external = true, and an external_ref: a per-consumer salted hash of the
--     pair id, built like a player_ref with an ':x:' tag so it can never equal a
--     player_ref (bare) or a match_ref (':m:').
--   * data_api_tournament_draw gives an external side one element,
--     {player_ref: null, external: true, external_ref}, and a member side's
--     elements gain external = false and external_ref = null, so every element
--     has the same keys. A slot in an external event is withheld only when it is
--     disputed: there is no member in it whose history test could fail.
--
-- NOT SERVED: external1_name, external2_name and pair_name. They are names a
-- person typed about somebody who never agreed to the club's API, which is the
-- same reason pair_name was never served (00266).
--
-- UNCHANGED: the match gate. data_api_tournament_match_publishable still drops
-- an external match from /v1/matches and every history read, since those are
-- rating history and an external match moves no rating.
--
-- ORDER. Two public functions, the events and the entrants, change their
-- result columns, which CREATE OR REPLACE cannot do, so each is dropped and
-- recreated; the draw keeps its columns and is replaced in place. A recreated
-- function is born with Supabase's default anon and authenticated grants, so
-- every REVOKE here names them. Nothing here touches an object of 00268 or 00269, so it applies
-- the same after prod's order (00268, 00269, then 00242 to 00267) as after the
-- fresh order.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.data_api_external_ref(p_consumer_id uuid, p_pair_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT encode(
    sha256(convert_to(
      c.player_ref_salt || ':x:' || p_pair_id::text || ':' || c.player_ref_salt,
      'utf8'
    )),
    'hex'
  )
  FROM data_api_consumers c
  WHERE c.id = p_consumer_id;
$function$;
COMMENT ON FUNCTION public.data_api_external_ref(uuid, uuid) IS
  'The per-consumer name for an external team, from its pair id. The '':x:'' tag keeps it from ever equalling a player_ref or a match_ref. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_external_ref(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- One side of a draw slot as JSON. An external pair is one element; a member
-- side is one element per player, as 00266 served it.
CREATE OR REPLACE FUNCTION public.data_api_draw_side(p_consumer_id uuid, p_match_id uuid, p_side text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN pr.id IS NOT NULL AND pr.player1_id IS NULL AND pr.player2_id IS NULL THEN
      jsonb_build_array(jsonb_build_object(
        'player_ref', NULL, 'external', TRUE,
        'external_ref', data_api_external_ref(p_consumer_id, pr.id)))
    ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'player_ref', data_api_player_ref(p_consumer_id, mp.player_id),
               'external', FALSE, 'external_ref', NULL))
        FROM data_api_tournament_match_players(p_match_id) mp
       WHERE mp.side = p_side), '[]'::jsonb)
  END
  FROM tournament_matches tm
  LEFT JOIN tournament_pairs pr
    ON pr.id = CASE p_side WHEN 'a' THEN tm.pair_a_id ELSE tm.pair_b_id END
  WHERE tm.id = p_match_id;
$function$;
COMMENT ON FUNCTION public.data_api_draw_side(uuid, uuid, text) IS
  'One side of a tournament draw slot. An external pair is a single element with an external_ref and no player_ref. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_draw_side(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.data_api_tournament_events(uuid, uuid);
CREATE OR REPLACE FUNCTION public.data_api_tournament_events(p_consumer_id uuid, p_tournament_id uuid)
RETURNS TABLE(
  id uuid,
  event_type text,
  format text,
  match_format text,
  games_per_match int,
  points_per_game int,
  max_participants int,
  seeding_method text,
  elo_multiplier numeric,
  placement_bonus_enabled boolean,
  status text,
  group_count int,
  qualifiers_per_group int,
  seeded_from_event_id uuid,
  external_event boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT te.id, te.event_type, te.format, te.match_format, te.games_per_match, te.points_per_game,
         te.max_participants, te.seeding_method, te.elo_multiplier, te.placement_bonus_enabled,
         te.status, te.group_count, te.qualifiers_per_group, te.seeded_from_event_id,
         te.external_event
    FROM tournament_events te
    JOIN tournaments t ON t.id = te.tournament_id
   WHERE te.tournament_id = p_tournament_id
     AND t.status <> 'draft'
     AND data_api_visible_season(t.season_id)
   ORDER BY te.event_type, te.id;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_events(uuid, uuid) IS
  'The events of one visible tournament. external_event marks an unrated event of external teams.';
REVOKE ALL ON FUNCTION public.data_api_tournament_events(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_events(uuid, uuid) TO data_api_reader;

DROP FUNCTION IF EXISTS public.data_api_tournament_entrants(uuid, uuid);
CREATE OR REPLACE FUNCTION public.data_api_tournament_entrants(p_consumer_id uuid, p_tournament_id uuid)
RETURNS TABLE(
  event_id uuid,
  player_refs text[],
  seed int,
  status text,
  final_position int,
  group_number int,
  points int,
  elo_before int,
  elo_after int,
  elo_change int,
  combined_elo int,
  external boolean,
  external_ref text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH visible AS (
    SELECT te.id
      FROM tournament_events te
      JOIN tournaments t ON t.id = te.tournament_id
     WHERE te.tournament_id = p_tournament_id
       AND t.status <> 'draft'
       AND data_api_visible_season(t.season_id)
  )
  SELECT tp.event_id,
         ARRAY[data_api_player_ref(p_consumer_id, tp.player_id)],
         tp.seed_number, tp.status, tp.final_position, tp.group_number, tp.points,
         tp.elo_before, tp.elo_after, tp.elo_change, NULL::int,
         FALSE, NULL::text
    FROM tournament_participants tp
    JOIN visible v ON v.id = tp.event_id
   WHERE data_api_published_player(tp.player_id)
  UNION ALL
  SELECT pr.event_id,
         ARRAY[data_api_player_ref(p_consumer_id, pr.player1_id), data_api_player_ref(p_consumer_id, pr.player2_id)],
         pr.seed_number, pr.status, pr.final_position, pr.group_number, pr.points,
         NULL::int, NULL::int, NULL::int, pr.combined_elo,
         FALSE, NULL::text
    FROM tournament_pairs pr
    JOIN visible v ON v.id = pr.event_id
   WHERE pr.player1_id IS NOT NULL
     AND pr.player2_id IS NOT NULL
     AND data_api_published_player(pr.player1_id)
     AND data_api_published_player(pr.player2_id)
  UNION ALL
  SELECT pr.event_id,
         ARRAY[]::text[],
         pr.seed_number, pr.status, pr.final_position, pr.group_number, pr.points,
         NULL::int, NULL::int, NULL::int, NULL::int,
         TRUE, data_api_external_ref(p_consumer_id, pr.id)
    FROM tournament_pairs pr
    JOIN visible v ON v.id = pr.event_id
   WHERE pr.player1_id IS NULL
     AND pr.player2_id IS NULL
   ORDER BY 1, 3 NULLS LAST, 2, 13;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_entrants(uuid, uuid) IS
  'Entrants of a visible tournament by player_ref. Unpublished entrants, and pairs with an unpublished member, are left out. An external team has no player_refs, external = true and an external_ref. pair_name and the external names are never served.';
REVOKE ALL ON FUNCTION public.data_api_tournament_entrants(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_entrants(uuid, uuid) TO data_api_reader;

-- Result columns are unchanged, so no DROP: only the sides and the withheld
-- test move.
CREATE OR REPLACE FUNCTION public.data_api_tournament_draw(p_consumer_id uuid, p_event_id uuid)
RETURNS TABLE(
  match_ref text,
  round_number int,
  round_name text,
  phase text,
  bracket_position int,
  match_number int,
  is_bye boolean,
  is_third_place boolean,
  scheduled_time timestamptz,
  status text,
  winner_to jsonb,
  loser_to jsonb,
  withheld boolean,
  sides jsonb,
  winner_side text,
  games jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    data_api_match_ref(p_consumer_id, 'tournament', tm.id),
    tm.round_number, tm.round_name, tm.phase, tm.bracket_position, tm.match_number,
    COALESCE(tm.is_bye, FALSE), tm.is_third_place, tm.scheduled_time, tm.status,
    CASE WHEN tm.winner_to_match_id IS NOT NULL THEN jsonb_build_object(
      'match_ref', data_api_match_ref(p_consumer_id, 'tournament', tm.winner_to_match_id),
      'position', tm.winner_to_position) END,
    CASE WHEN tm.loser_to_match_id IS NOT NULL THEN jsonb_build_object(
      'match_ref', data_api_match_ref(p_consumer_id, 'tournament', tm.loser_to_match_id),
      'position', tm.loser_to_position) END,
    x.withheld,
    CASE WHEN x.withheld THEN NULL ELSE jsonb_build_object(
      'a', data_api_draw_side(p_consumer_id, tm.id, 'a'),
      'b', data_api_draw_side(p_consumer_id, tm.id, 'b')
    ) END,
    CASE WHEN x.withheld THEN NULL ELSE
      CASE
        WHEN tm.walkover_winner IS NOT NULL THEN tm.walkover_winner
        WHEN tm.winner_participant_id IS NOT NULL AND tm.winner_participant_id = tm.participant_a_id THEN 'a'
        WHEN tm.winner_participant_id IS NOT NULL AND tm.winner_participant_id = tm.participant_b_id THEN 'b'
        WHEN tm.winner_pair_id IS NOT NULL AND tm.winner_pair_id = tm.pair_a_id THEN 'a'
        WHEN tm.winner_pair_id IS NOT NULL AND tm.winner_pair_id = tm.pair_b_id THEN 'b'
      END END,
    CASE WHEN x.withheld OR jsonb_typeof(tm.scores) IS DISTINCT FROM 'array' THEN NULL ELSE (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('game', g.n, 'a', (g.v ->> 'a')::int, 'b', (g.v ->> 'b')::int)
                                ORDER BY g.n), '[]'::jsonb)
        FROM jsonb_array_elements(tm.scores) WITH ORDINALITY AS g(v, n)) END
  FROM tournament_matches tm
  JOIN tournament_events te ON te.id = tm.event_id
  JOIN tournaments t ON t.id = te.tournament_id
  -- An external event holds external pairs only (00269's fences), so it has no
  -- member whose history test could withhold a slot.
  CROSS JOIN LATERAL (
    SELECT (tm.status = 'disputed'
            OR (NOT te.external_event AND NOT data_api_tournament_match_publishable(tm.id))) AS withheld
  ) x
  WHERE tm.event_id = p_event_id
    AND t.status <> 'draft'
    AND data_api_visible_season(t.season_id)
  ORDER BY tm.phase NULLS FIRST, tm.round_number, tm.bracket_position, tm.id;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_draw(uuid, uuid) IS
  'The draw of one event in a visible tournament, every status. A slot with an unpublished player, or a disputed one, is withheld: its structure only. An external side is one element with an external_ref. The court label is free text and is not served.';
REVOKE ALL ON FUNCTION public.data_api_tournament_draw(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_draw(uuid, uuid) TO data_api_reader;

DO $verify$
DECLARE
  v_fn text;
  v_bad text := '';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_tournament_events(uuid,uuid)',
    'public.data_api_tournament_entrants(uuid,uuid)',
    'public.data_api_tournament_draw(uuid,uuid)'
  ] LOOP
    IF NOT has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'data_api_reader cannot execute ' || v_fn || '; ';
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'anon or authenticated can execute ' || v_fn || '; ';
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_external_ref(uuid,uuid)',
    'public.data_api_draw_side(uuid,uuid,text)'
  ] LOOP
    IF has_function_privilege('data_api_reader', v_fn, 'EXECUTE')
       OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'a caller role can execute the internal ' || v_fn || '; ';
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '00270 verification failed: %', v_bad;
  END IF;

  SET LOCAL ROLE data_api_reader;
  PERFORM count(*) FROM public.data_api_tournament_events(gen_random_uuid(), gen_random_uuid());
  PERFORM count(*) FROM public.data_api_tournament_entrants(gen_random_uuid(), gen_random_uuid());
  PERFORM count(*) FROM public.data_api_tournament_draw(gen_random_uuid(), gen_random_uuid());
  RESET ROLE;

  RAISE NOTICE '00270 verified: the three tournament readers are reachable by data_api_reader only, the two helpers by nobody.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
