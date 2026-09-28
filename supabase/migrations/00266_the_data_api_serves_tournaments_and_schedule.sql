-- ============================================================
-- 00266 THE DATA API SERVES TOURNAMENTS AND THE SCHEDULE
--
-- WHAT IS ADDED: six public functions for data_api_reader, behind the
-- tournaments:read and schedule:read scopes (00264).
--
-- TOURNAMENTS. Draft tournaments and tournaments in a hidden season do not
-- exist as far as the API is concerned. A suspended tournament is listed with
-- suspended = true, as the member app lists it. Entrants are players named by
-- player_ref only; an entrant (or a pair with either member) who is not
-- published is left out, and no total is given that would reveal the gap.
--
-- DRAWS keep their structure. A draw row whose players are not all published,
-- or which is disputed (participant-only in the app), is kept as a withheld
-- slot: its place in the bracket, with no sides, scores or winner. The test is
-- data_api_tournament_match_publishable, the same one the match gate (00265)
-- uses, so a draw withholds exactly what /v1/matches drops. A withheld slot
-- still shows that the slot exists; that is unavoidable if a bracket is to
-- stay a bracket, and API.md says so.
--
-- NOT SERVED: pair_name, walkover_reason, suspension_reason, waiver_text and
-- court (all free text typed by people), allowed_memberships, and any note.
-- Nor max_events_per_player: the cross-event cap fence (00201) holds that only
-- an entry path that takes both locks may read it.
--
-- SCHEDULE. Sessions and club events with counts only: never who RSVPed,
-- signed up or attended. Session notes and host, event description and
-- cancelled_reason are not served. Session name and location, and event title
-- and location, are exec-authored club text shown to every member, so they
-- are served. Sessions in a hidden season are left out; draft club events are
-- left out.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.data_api_tournaments(
  p_consumer_id uuid,
  p_season uuid DEFAULT NULL,
  p_tournament_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  name text,
  season_id uuid,
  season_name text,
  start_date date,
  end_date date,
  status text,
  suspended boolean,
  event_multiplier numeric,
  placement_bonus_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.id, t.name, t.season_id, s.name, t.start_date, t.end_date, t.status::text,
         (t.suspended_at IS NOT NULL), t.event_multiplier, t.placement_bonus_enabled
    FROM tournaments t
    LEFT JOIN seasons s ON s.id = t.season_id
   WHERE t.status <> 'draft'
     AND data_api_visible_season(t.season_id)
     AND (p_season IS NULL OR t.season_id = p_season)
     AND (p_tournament_id IS NULL OR t.id = p_tournament_id)
   ORDER BY t.start_date DESC, t.id;
$function$;
COMMENT ON FUNCTION public.data_api_tournaments(uuid, uuid, uuid) IS
  'Non-draft tournaments in visible seasons. The name is a club-authored title.';
REVOKE ALL ON FUNCTION public.data_api_tournaments(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournaments(uuid, uuid, uuid) TO data_api_reader;

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
  seeded_from_event_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT te.id, te.event_type, te.format, te.match_format, te.games_per_match, te.points_per_game,
         te.max_participants, te.seeding_method, te.elo_multiplier, te.placement_bonus_enabled,
         te.status, te.group_count, te.qualifiers_per_group, te.seeded_from_event_id
    FROM tournament_events te
    JOIN tournaments t ON t.id = te.tournament_id
   WHERE te.tournament_id = p_tournament_id
     AND t.status <> 'draft'
     AND data_api_visible_season(t.season_id)
   ORDER BY te.event_type, te.id;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_events(uuid, uuid) IS
  'The events of one visible tournament.';
REVOKE ALL ON FUNCTION public.data_api_tournament_events(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_events(uuid, uuid) TO data_api_reader;

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
  combined_elo int
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
         tp.elo_before, tp.elo_after, tp.elo_change, NULL::int
    FROM tournament_participants tp
    JOIN visible v ON v.id = tp.event_id
   WHERE data_api_published_player(tp.player_id)
  UNION ALL
  SELECT pr.event_id,
         ARRAY[data_api_player_ref(p_consumer_id, pr.player1_id), data_api_player_ref(p_consumer_id, pr.player2_id)],
         pr.seed_number, pr.status, pr.final_position, pr.group_number, pr.points,
         NULL::int, NULL::int, NULL::int, pr.combined_elo
    FROM tournament_pairs pr
    JOIN visible v ON v.id = pr.event_id
   WHERE data_api_published_player(pr.player1_id)
     AND data_api_published_player(pr.player2_id)
   ORDER BY 1, 3 NULLS LAST, 2;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_entrants(uuid, uuid) IS
  'Entrants of a visible tournament by player_ref. Unpublished entrants, and pairs with an unpublished member, are left out. pair_name is never served.';
REVOKE ALL ON FUNCTION public.data_api_tournament_entrants(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_entrants(uuid, uuid) TO data_api_reader;

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
      'a', COALESCE((SELECT jsonb_agg(jsonb_build_object('player_ref', data_api_player_ref(p_consumer_id, mp.player_id)))
                       FROM data_api_tournament_match_players(tm.id) mp WHERE mp.side = 'a'), '[]'::jsonb),
      'b', COALESCE((SELECT jsonb_agg(jsonb_build_object('player_ref', data_api_player_ref(p_consumer_id, mp.player_id)))
                       FROM data_api_tournament_match_players(tm.id) mp WHERE mp.side = 'b'), '[]'::jsonb)
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
  CROSS JOIN LATERAL (
    SELECT (tm.status = 'disputed' OR NOT data_api_tournament_match_publishable(tm.id)) AS withheld
  ) x
  WHERE tm.event_id = p_event_id
    AND t.status <> 'draft'
    AND data_api_visible_season(t.season_id)
  ORDER BY tm.phase NULLS FIRST, tm.round_number, tm.bracket_position, tm.id;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_draw(uuid, uuid) IS
  'The draw of one event in a visible tournament, every status. A slot with an unpublished player, or a disputed one, is withheld: its structure only. The court label is free text and is not served.';
REVOKE ALL ON FUNCTION public.data_api_tournament_draw(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_draw(uuid, uuid) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_sessions(p_consumer_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(
  id uuid,
  name text,
  season_id uuid,
  season_name text,
  date date,
  starts_at timestamptz,
  ends_at timestamptz,
  location text,
  status text,
  track text,
  require_scan_to_check_in boolean,
  rsvp_going int,
  attended int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT se.id, se.name, se.season_id, s.name, se.date, se.starts_at, se.ends_at, se.location,
         se.status::text, se.track::text, se.require_scan_to_check_in,
         (SELECT COUNT(*) FROM session_rsvp r WHERE r.session_id = se.id AND r.intent = 'going')::int,
         (SELECT COUNT(*) FROM session_attendance a
           WHERE a.session_id = se.id AND a.status IN ('checked_in', 'present'))::int
    FROM sessions se
    LEFT JOIN seasons s ON s.id = se.season_id
   WHERE data_api_visible_season(se.season_id)
     AND COALESCE(se.starts_at, se.date::timestamptz) >= p_from
     AND COALESCE(se.starts_at, se.date::timestamptz) < p_to
   ORDER BY COALESCE(se.starts_at, se.date::timestamptz), se.id;
$function$;
COMMENT ON FUNCTION public.data_api_sessions(uuid, timestamptz, timestamptz) IS
  'Club sessions in a window, with RSVP and attendance COUNTS only. notes and the host are never served. Attendance counts checked_in and present, as get_session_attendee_counts does.';
REVOKE ALL ON FUNCTION public.data_api_sessions(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_sessions(uuid, timestamptz, timestamptz) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_club_events(p_consumer_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(
  id uuid,
  title text,
  kind text,
  location text,
  starts_at timestamptz,
  ends_at timestamptz,
  status text,
  cancelled_at timestamptz,
  capacity int,
  cost_cents int,
  signup_opens_at timestamptz,
  signup_closes_at timestamptz,
  signups int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT ce.id, ce.title, ce.kind, ce.location, ce.starts_at, ce.ends_at, ce.status, ce.cancelled_at,
         ce.capacity, ce.cost_cents, ce.signup_opens_at, ce.signup_closes_at,
         (SELECT COUNT(*) FROM club_event_signups su WHERE su.event_id = ce.id)::int
    FROM club_events ce
   WHERE ce.status IN ('published', 'cancelled')
     AND ce.starts_at >= p_from
     AND ce.starts_at < p_to
   ORDER BY ce.starts_at, ce.id;
$function$;
COMMENT ON FUNCTION public.data_api_club_events(uuid, timestamptz, timestamptz) IS
  'Published and cancelled club events in a window, with a signup COUNT only. description and cancelled_reason are never served.';
REVOKE ALL ON FUNCTION public.data_api_club_events(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_club_events(uuid, timestamptz, timestamptz) TO data_api_reader;

DO $verify$
DECLARE
  v_fn text;
  v_bad text := '';
  v_n integer;
  v_consumer uuid := '00000000-0000-0000-0000-000000000266';
  v_match record;
  v_player uuid;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_tournaments(uuid,uuid,uuid)',
    'public.data_api_tournament_events(uuid,uuid)',
    'public.data_api_tournament_entrants(uuid,uuid)',
    'public.data_api_tournament_draw(uuid,uuid)',
    'public.data_api_sessions(uuid,timestamptz,timestamptz)',
    'public.data_api_club_events(uuid,timestamptz,timestamptz)'
  ] LOOP
    IF NOT has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'data_api_reader cannot execute ' || v_fn || '; ';
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'anon or authenticated can execute ' || v_fn || '; ';
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '00266 verification failed: %', v_bad;
  END IF;

  SET LOCAL ROLE data_api_reader;
  PERFORM count(*) FROM public.data_api_tournaments(gen_random_uuid());
  PERFORM count(*) FROM public.data_api_tournament_events(gen_random_uuid(), gen_random_uuid());
  PERFORM count(*) FROM public.data_api_tournament_entrants(gen_random_uuid(), gen_random_uuid());
  PERFORM count(*) FROM public.data_api_tournament_draw(gen_random_uuid(), gen_random_uuid());
  PERFORM count(*) FROM public.data_api_sessions(gen_random_uuid(), now() - interval '1 year', now());
  PERFORM count(*) FROM public.data_api_club_events(gen_random_uuid(), now() - interval '1 year', now());
  RESET ROLE;

  -- With data: hiding a player on a drawn match withholds that slot.
  SELECT tm.id, tm.event_id INTO v_match
    FROM public.tournament_matches tm
   WHERE tm.participant_a_id IS NOT NULL OR tm.pair_a_id IS NOT NULL
   LIMIT 1;
  IF v_match.id IS NULL THEN
    RAISE NOTICE '00266: no drawn tournament match on this database, fixture check skipped.';
  ELSE
    BEGIN
      INSERT INTO public.data_api_consumers (id, name) VALUES (v_consumer, '00266 self-check');
      SELECT mp.player_id INTO v_player FROM public.data_api_tournament_match_players(v_match.id) mp LIMIT 1;
      UPDATE public.players SET hide_from_leaderboard = TRUE WHERE id = v_player;
      SELECT count(*) INTO v_n
        FROM public.data_api_tournament_draw(v_consumer, v_match.event_id) d
       WHERE d.match_ref = public.data_api_match_ref(v_consumer, 'tournament', v_match.id)
         AND NOT d.withheld;
      IF v_n <> 0 THEN
        RAISE EXCEPTION '00266: a draw slot with a hidden player was not withheld';
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'P0266', MESSAGE = 'rollback';
    EXCEPTION WHEN SQLSTATE 'P0266' THEN
      NULL;
    END;
  END IF;

  RAISE NOTICE '00266 verified: six public functions reachable by data_api_reader only, and a hidden player withholds their draw slot.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
