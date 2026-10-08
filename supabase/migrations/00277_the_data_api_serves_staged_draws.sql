-- ============================================================
-- 00277 THE DATA API SERVES STAGED DRAWS
--
-- 00272 added a fourth event format, 'staged': a list of stages kept as data
-- on the event (format_config), matches that belong to a stage rather than a
-- phase, a per-team category, and head starts. The 00270 readers serve none of
-- it, so a staged event reads as an event with no structure and its draw as a
-- list of slots with no phase and no way to tell one stage from the next.
--
-- WHAT CHANGES.
--   * data_api_tournament_events_v2: the 00270 columns plus rated,
--     current_stage, stages, categories, head_starts and points_table. Every
--     one of the four jsonb columns is REBUILT key by key from an allowlist;
--     the stored config is never passed through whole, because a stage carries
--     the tournament's court names and a named match its court. A value of the
--     wrong JSON type comes back null rather than raising, so one bad value in
--     one event cannot take the whole route down.
--   * data_api_tournament_entrants_v2: the 00270 columns plus team_category.
--   * data_api_tournament_draw_v2: the 00270 columns plus stage, pool_number,
--     group_number, slot, match_label, handicap_a and handicap_b. The structure
--     is served on a withheld slot as well; the head starts are not, since
--     they say which categories met.
--   * data_api_match_rows: the same signature, so replaced in place. Only the
--     bracket object changes, gaining stage, match_label, handicap_a and
--     handicap_b, which reach /v1/matches through the tournament block.
--
-- points_table is format_config.points on a staged event and points_config
-- (00275) on a legacy one, null when the event pays its format's default.
-- Recorded scores already include a head start; handicap_a and handicap_b are
-- what each side started every game on, so a consumer can subtract them.
--
-- NOT SERVED: the court of a match, a stage's courts, external team names and
-- pair_name, as before (00266, 00270).
--
-- WHY NEW NAMES. Images update before migrations run. A running image calls the
-- 00270 readers; changing their result columns would mean dropping them. The
-- service calls the v2 functions and falls back to the 00270 ones when
-- PostgREST does not know a v2 yet. The 00270 functions are left as they are.
-- A new function is born with Supabase's default anon and authenticated
-- grants, so every REVOKE here names them.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.data_api_tournament_events_v2(p_consumer_id uuid, p_tournament_id uuid)
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
  external_event boolean,
  rated boolean,
  current_stage int,
  stages jsonb,
  categories jsonb,
  head_starts jsonb,
  points_table jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT te.id, te.event_type, te.format, te.match_format, te.games_per_match, te.points_per_game,
         te.max_participants, te.seeding_method, te.elo_multiplier, te.placement_bonus_enabled,
         te.status, te.group_count, te.qualifiers_per_group, te.seeded_from_event_id,
         te.external_event,
         te.rated,
         te.current_stage::int,
         -- One object per stage, in order, from these keys only.
         CASE WHEN te.format = 'staged' AND jsonb_typeof(te.format_config -> 'stages') = 'array' THEN (
           SELECT jsonb_agg(jsonb_build_object(
                    'index', s.n::int,
                    'key', CASE WHEN jsonb_typeof(s.v -> 'key') = 'string' THEN s.v -> 'key' END,
                    'name', CASE WHEN jsonb_typeof(s.v -> 'name') = 'string' THEN s.v -> 'name' END,
                    'kind', CASE WHEN s.v ->> 'kind' IN ('groups', 'knockout', 'matches') THEN s.v -> 'kind' END,
                    'rated', COALESCE(CASE WHEN jsonb_typeof(s.v -> 'rated') = 'boolean' THEN s.v -> 'rated' END, 'true'::jsonb),
                    'scoring', CASE WHEN jsonb_typeof(s.v -> 'scoring') = 'object' THEN jsonb_build_object(
                      'best_of', CASE WHEN jsonb_typeof(s.v #> '{scoring,bestOf}') = 'number' THEN s.v #> '{scoring,bestOf}' END,
                      'target', CASE WHEN jsonb_typeof(s.v #> '{scoring,target}') = 'number' THEN s.v #> '{scoring,target}' END,
                      'win_by_two', CASE WHEN jsonb_typeof(s.v #> '{scoring,winByTwo}') = 'boolean' THEN s.v #> '{scoring,winByTwo}' END,
                      'cap', CASE WHEN jsonb_typeof(s.v #> '{scoring,cap}') = 'number' THEN s.v #> '{scoring,cap}' END,
                      'handicap', CASE WHEN jsonb_typeof(s.v #> '{scoring,handicap}') = 'boolean' THEN s.v #> '{scoring,handicap}' END,
                      'forfeit', CASE WHEN jsonb_typeof(s.v #> '{scoring,forfeit}') = 'object' THEN jsonb_build_object(
                        'winner', CASE WHEN jsonb_typeof(s.v #> '{scoring,forfeit,winner}') = 'number' THEN s.v #> '{scoring,forfeit,winner}' END,
                        'loser', CASE WHEN jsonb_typeof(s.v #> '{scoring,forfeit,loser}') = 'number' THEN s.v #> '{scoring,forfeit,loser}' END
                      ) END
                    ) END,
                    'pools', CASE WHEN jsonb_typeof(s.v -> 'pools') = 'number' THEN s.v -> 'pools' END,
                    'groups_per_pool', CASE WHEN jsonb_typeof(s.v -> 'groupsPerPool') = 'number' THEN s.v -> 'groupsPerPool' END,
                    'group_size', CASE WHEN jsonb_typeof(s.v -> 'groupSize') = 'number' OR s.v -> 'groupSize' = '"auto"'::jsonb
                                       THEN s.v -> 'groupSize' END,
                    'tiebreaks', CASE WHEN jsonb_typeof(s.v -> 'tiebreaks') = 'array' THEN (
                      SELECT COALESCE(jsonb_agg(tb.v ORDER BY tb.n), '[]'::jsonb)
                        FROM jsonb_array_elements(s.v -> 'tiebreaks') WITH ORDINALITY AS tb(v, n)
                       WHERE jsonb_typeof(tb.v) = 'string'
                         AND tb.v #>> '{}' IN ('wins', 'point_diff', 'points_for', 'points_against_low',
                                               'game_diff', 'h2h', 'seed')) END,
                    'size', CASE WHEN jsonb_typeof(s.v -> 'size') = 'number' OR s.v -> 'size' = '"auto"'::jsonb
                                 THEN s.v -> 'size' END,
                    'third_place', CASE WHEN jsonb_typeof(s.v -> 'thirdPlace') = 'boolean' THEN s.v -> 'thirdPlace' END,
                    'matches', CASE WHEN s.v ->> 'kind' = 'matches' AND jsonb_typeof(s.v -> 'matches') = 'array' THEN (
                      SELECT COALESCE(jsonb_agg(jsonb_build_object(
                               'label', CASE WHEN jsonb_typeof(md.v -> 'label') = 'string' THEN md.v -> 'label' END,
                               'name', CASE WHEN jsonb_typeof(md.v -> 'name') = 'string' THEN md.v -> 'name' END,
                               'winner_place', CASE WHEN jsonb_typeof(md.v -> 'winnerPlace') = 'number' THEN md.v -> 'winnerPlace' END,
                               'loser_place', CASE WHEN jsonb_typeof(md.v -> 'loserPlace') = 'number' THEN md.v -> 'loserPlace' END
                             ) ORDER BY md.n), '[]'::jsonb)
                        FROM jsonb_array_elements(s.v -> 'matches') WITH ORDINALITY AS md(v, n)) END
                  ) ORDER BY s.n)
             FROM jsonb_array_elements(te.format_config -> 'stages') WITH ORDINALITY AS s(v, n)) END,
         CASE WHEN te.format = 'staged' AND jsonb_typeof(te.format_config -> 'categories') = 'array' THEN (
           SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'key', CASE WHEN jsonb_typeof(cat.v -> 'key') = 'string' THEN cat.v -> 'key' END,
                    'label', CASE WHEN jsonb_typeof(cat.v -> 'label') = 'string' THEN cat.v -> 'label' END
                  ) ORDER BY cat.n), '[]'::jsonb)
             FROM jsonb_array_elements(te.format_config -> 'categories') WITH ORDINALITY AS cat(v, n)) END,
         -- Row category -> column category -> points the row side starts on.
         CASE WHEN te.format = 'staged' AND jsonb_typeof(te.format_config -> 'headStarts') = 'object' THEN (
           SELECT COALESCE(jsonb_object_agg(hr.key, (
                    SELECT COALESCE(jsonb_object_agg(hc.key, hc.value), '{}'::jsonb)
                      FROM jsonb_each(hr.value) hc
                     WHERE jsonb_typeof(hc.value) = 'number')), '{}'::jsonb)
             FROM jsonb_each(te.format_config -> 'headStarts') hr
            WHERE jsonb_typeof(hr.value) = 'object') END,
         CASE WHEN jsonb_typeof(pt.p) = 'object' THEN jsonb_build_object(
           'by_place', CASE WHEN jsonb_typeof(pt.p -> 'byPlace') = 'array' THEN (
             SELECT COALESCE(jsonb_agg(bp.v ORDER BY bp.n), '[]'::jsonb)
               FROM jsonb_array_elements(pt.p -> 'byPlace') WITH ORDINALITY AS bp(v, n)
              WHERE jsonb_typeof(bp.v) = 'number') ELSE '[]'::jsonb END,
           'rest', COALESCE(CASE WHEN jsonb_typeof(pt.p -> 'rest') = 'number' THEN pt.p -> 'rest' END, '0'::jsonb),
           'participation', CASE WHEN jsonb_typeof(pt.p -> 'participation') = 'number' THEN pt.p -> 'participation' END,
           'per_win', CASE WHEN jsonb_typeof(pt.p -> 'perWin') = 'number' THEN pt.p -> 'perWin' END
         ) END
    FROM tournament_events te
    JOIN tournaments t ON t.id = te.tournament_id
    -- A staged event's table lives in its config, a legacy event's in
    -- points_config (00275). NULL is the format's default.
    CROSS JOIN LATERAL (
      SELECT CASE WHEN te.format = 'staged' THEN te.format_config -> 'points' ELSE te.points_config END AS p
    ) pt
   WHERE te.tournament_id = p_tournament_id
     AND t.status <> 'draft'
     AND data_api_visible_season(t.season_id)
   ORDER BY te.event_type, te.id;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_events_v2(uuid, uuid) IS
  'The events of one visible tournament, with the structure of a staged event (00272) rebuilt from an allowlist: stages, categories, head starts and the points table. Court names in the stored config are never served.';
REVOKE ALL ON FUNCTION public.data_api_tournament_events_v2(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_events_v2(uuid, uuid) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_tournament_entrants_v2(p_consumer_id uuid, p_tournament_id uuid)
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
  external_ref text,
  team_category text
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
         FALSE, NULL::text,
         NULL::text
    FROM tournament_participants tp
    JOIN visible v ON v.id = tp.event_id
   WHERE data_api_published_player(tp.player_id)
  UNION ALL
  SELECT pr.event_id,
         ARRAY[data_api_player_ref(p_consumer_id, pr.player1_id), data_api_player_ref(p_consumer_id, pr.player2_id)],
         pr.seed_number, pr.status, pr.final_position, pr.group_number, pr.points,
         NULL::int, NULL::int, NULL::int, pr.combined_elo,
         FALSE, NULL::text,
         pr.team_category
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
         TRUE, data_api_external_ref(p_consumer_id, pr.id),
         pr.team_category
    FROM tournament_pairs pr
    JOIN visible v ON v.id = pr.event_id
   WHERE pr.player1_id IS NULL
     AND pr.player2_id IS NULL
   ORDER BY 1, 3 NULLS LAST, 2, 13;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_entrants_v2(uuid, uuid) IS
  'The entrants of a visible tournament as 00270 serves them, plus team_category: the category a team plays as in a staged event. pair_name and the external names are never served.';
REVOKE ALL ON FUNCTION public.data_api_tournament_entrants_v2(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_entrants_v2(uuid, uuid) TO data_api_reader;

-- 00270's draw plus the stage columns. A staged match has a stage and no
-- phase, a legacy match the reverse, so legacy rows keep their 00270 order.
CREATE OR REPLACE FUNCTION public.data_api_tournament_draw_v2(p_consumer_id uuid, p_event_id uuid)
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
  games jsonb,
  stage int,
  pool_number int,
  group_number int,
  slot int,
  match_label text,
  handicap_a int,
  handicap_b int
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
        FROM jsonb_array_elements(tm.scores) WITH ORDINALITY AS g(v, n)) END,
    tm.stage::int, tm.pool_number::int, tm.group_number::int, tm.slot::int, tm.match_label,
    -- The head starts say which categories met, so a withheld slot loses them.
    CASE WHEN x.withheld THEN NULL ELSE tm.handicap_a::int END,
    CASE WHEN x.withheld THEN NULL ELSE tm.handicap_b::int END
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
  ORDER BY tm.stage NULLS FIRST, tm.phase NULLS FIRST, tm.round_number, tm.bracket_position, tm.id;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_draw_v2(uuid, uuid) IS
  'The draw of one event in a visible tournament as 00270 serves it, plus the stage columns of a staged event (00272) and each side''s head start. A withheld slot keeps its stage columns and loses its head starts. The court label is free text and is not served.';
REVOKE ALL ON FUNCTION public.data_api_tournament_draw_v2(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_tournament_draw_v2(uuid, uuid) TO data_api_reader;

-- THE GATE, 00265's body with four keys added to the bracket object and nothing
-- else touched. Same result columns, so replaced in place; CREATE OR REPLACE
-- keeps the ACL, and the REVOKE below repeats 00265's anyway.
CREATE OR REPLACE FUNCTION public.data_api_match_rows()
RETURNS TABLE(
  source text,
  id uuid,
  season_id uuid,
  discipline text,
  kind text,
  rated boolean,
  format text,
  games_per_match int,
  points_per_game int,
  status text,
  walkover jsonb,
  winner_side text,
  score_summary text,
  played_at timestamptz,
  updated_at timestamptz,
  tournament_id uuid,
  event_id uuid,
  bracket jsonb,
  participants jsonb,
  games jsonb,
  counts_toward_stats boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    'club'::text,
    m.id,
    m.season_id,
    m.match_type::text,
    m.event_type::text,
    m.rated_flag,
    m.format::text,
    m.games_per_match::int,
    m.points_per_game::int,
    m.result_status::text,
    CASE WHEN m.walkover_type IS NOT NULL THEN jsonb_build_object(
      'type', m.walkover_type::text,
      'forfeit_side', (SELECT fp.team_side::text FROM match_participants fp
                        WHERE fp.match_id = m.id AND fp.player_id = m.forfeit_player_id LIMIT 1)
    ) END,
    m.winner_side::text,
    m.score_summary,
    m.played_at,
    m.updated_at,
    NULL::uuid,
    NULL::uuid,
    NULL::jsonb,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'player_id', mp.player_id,
               'side', mp.team_side::text,
               'won', mp.win_flag,
               'before', CASE WHEN mp.post_rating IS NOT NULL AND mp.rating_delta IS NOT NULL
                              THEN mp.post_rating - mp.rating_delta END,
               'after', mp.post_rating,
               'delta', mp.rating_delta,
               'points_scored', mp.points_scored,
               'points_allowed', mp.points_allowed,
               'games_won', mp.games_won,
               'games_lost', mp.games_lost
             ) ORDER BY mp.team_side, mp.player_id)
        FROM match_participants mp
       WHERE mp.match_id = m.id
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('game', g.game_number, 'a', g.side_a_score, 'b', g.side_b_score)
                       ORDER BY g.game_number)
        FROM match_games g
       WHERE g.match_id = m.id
    ), '[]'::jsonb),
    (m.result_status = 'confirmed' AND m.walkover_type IS NULL)
  FROM matches m
  WHERE m.result_status IN ('confirmed', 'walkover', 'voided')
    AND data_api_visible_season(m.season_id)
    AND NOT EXISTS (
      SELECT 1 FROM match_participants mp
       WHERE mp.match_id = m.id
         AND NOT data_api_published_player(mp.player_id)
    )

  UNION ALL

  SELECT
    'tournament'::text,
    tm.id,
    t.season_id,
    CASE WHEN te.event_type LIKE '%singles' THEN 'singles' ELSE 'doubles' END,
    'tournament'::text,
    (tm.elo_snapshot IS NOT NULL),
    COALESCE(tm.match_format, te.match_format),
    COALESCE(tm.games_per_match, te.games_per_match),
    COALESCE(tm.points_per_game, te.points_per_game),
    tm.status,
    CASE WHEN tm.status = 'walkover' OR tm.walkover_winner IS NOT NULL
         THEN jsonb_build_object('winner_side', tm.walkover_winner) END,
    w.side,
    NULL::text,
    COALESCE(tm.result_entered_at, tm.scheduled_time),
    GREATEST(COALESCE(tm.updated_at, tm.created_at), tm.result_entered_at),
    t.id,
    te.id,
    jsonb_build_object(
      'event_type', te.event_type,
      'round_number', tm.round_number,
      'round_name', tm.round_name,
      'phase', tm.phase,
      'is_third_place', tm.is_third_place,
      'stage', tm.stage,
      'match_label', tm.match_label,
      'handicap_a', tm.handicap_a,
      'handicap_b', tm.handicap_b
    ),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'player_id', mp.player_id,
               'side', mp.side,
               'won', CASE WHEN w.side IS NULL THEN NULL ELSE mp.side = w.side END,
               'before', (snap.e ->> 'before')::int,
               'after', (snap.e ->> 'after')::int,
               'delta', (snap.e ->> 'delta')::int,
               'points_scored', pts.mine,
               'points_allowed', pts.theirs,
               'games_won', pts.won,
               'games_lost', pts.lost
             ) ORDER BY mp.side, mp.player_id)
        FROM data_api_tournament_match_players(tm.id) mp
        LEFT JOIN LATERAL (
          SELECT e FROM jsonb_array_elements(COALESCE(tm.elo_snapshot -> 'entries', '[]'::jsonb)) e
           WHERE e ->> 'player_id' = mp.player_id::text
           LIMIT 1
        ) snap ON TRUE
        CROSS JOIN LATERAL (
          SELECT
            SUM(CASE WHEN mp.side = 'a' THEN (g ->> 'a')::int ELSE (g ->> 'b')::int END)::int AS mine,
            SUM(CASE WHEN mp.side = 'a' THEN (g ->> 'b')::int ELSE (g ->> 'a')::int END)::int AS theirs,
            COUNT(*) FILTER (WHERE (CASE WHEN mp.side = 'a' THEN (g ->> 'a')::int - (g ->> 'b')::int
                                         ELSE (g ->> 'b')::int - (g ->> 'a')::int END) > 0)::int AS won,
            COUNT(*) FILTER (WHERE (CASE WHEN mp.side = 'a' THEN (g ->> 'a')::int - (g ->> 'b')::int
                                         ELSE (g ->> 'b')::int - (g ->> 'a')::int END) < 0)::int AS lost
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(tm.scores) = 'array' THEN tm.scores ELSE '[]'::jsonb END) g
        ) pts
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('game', g.n, 'a', (g.v ->> 'a')::int, 'b', (g.v ->> 'b')::int)
                       ORDER BY g.n)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(tm.scores) = 'array' THEN tm.scores ELSE '[]'::jsonb END)
             WITH ORDINALITY AS g(v, n)
    ), '[]'::jsonb),
    (tm.status = 'completed')
  FROM tournament_matches tm
  JOIN tournament_events te ON te.id = tm.event_id
  JOIN tournaments t ON t.id = te.tournament_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN tm.walkover_winner IS NOT NULL THEN tm.walkover_winner
      WHEN tm.winner_participant_id IS NOT NULL AND tm.winner_participant_id = tm.participant_a_id THEN 'a'
      WHEN tm.winner_participant_id IS NOT NULL AND tm.winner_participant_id = tm.participant_b_id THEN 'b'
      WHEN tm.winner_pair_id IS NOT NULL AND tm.winner_pair_id = tm.pair_a_id THEN 'a'
      WHEN tm.winner_pair_id IS NOT NULL AND tm.winner_pair_id = tm.pair_b_id THEN 'b'
    END AS side
  ) w
  WHERE tm.status IN ('completed', 'walkover', 'voided')
    AND COALESCE(tm.is_bye, FALSE) = FALSE
    AND t.status <> 'draft'
    AND data_api_visible_season(t.season_id)
    AND data_api_tournament_match_publishable(tm.id);
$function$;
COMMENT ON FUNCTION public.data_api_match_rows() IS
  'THE PRIVACY BOUNDARY OF DATA API HISTORY. Club and tournament matches that are final, in a visible season, with every player published. participants holds raw player ids and is hashed by the public callers after paging. The bracket of a tournament match carries its stage, match_label and head starts (00277). Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_match_rows() FROM PUBLIC, anon, authenticated;

DO $verify$
DECLARE
  v_fn text;
  v_bad text := '';
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_tournament_events_v2(uuid,uuid)',
    'public.data_api_tournament_entrants_v2(uuid,uuid)',
    'public.data_api_tournament_draw_v2(uuid,uuid)'
  ] LOOP
    IF NOT has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'data_api_reader cannot execute ' || v_fn || '; ';
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'anon or authenticated can execute ' || v_fn || '; ';
    END IF;
  END LOOP;
  IF has_function_privilege('data_api_reader', 'public.data_api_match_rows()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.data_api_match_rows()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.data_api_match_rows()', 'EXECUTE') THEN
    v_bad := v_bad || 'a caller role can execute the internal public.data_api_match_rows(); ';
  END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '00277 verification failed: %', v_bad;
  END IF;

  SET LOCAL ROLE data_api_reader;
  PERFORM count(*) FROM public.data_api_tournament_events_v2(gen_random_uuid(), gen_random_uuid());
  PERFORM count(*) FROM public.data_api_tournament_entrants_v2(gen_random_uuid(), gen_random_uuid());
  PERFORM count(*) FROM public.data_api_tournament_draw_v2(gen_random_uuid(), gen_random_uuid());
  RESET ROLE;

  RAISE NOTICE '00277 verified: the three v2 tournament readers are reachable by data_api_reader only, the match gate by nobody.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
