-- ============================================================
-- 00265 THE DATA API SERVES MATCH HISTORY
--
-- WHAT IS ADDED: the functions behind the data API's match, head-to-head,
-- season and rating-history routes. Six internal helpers (no grant) and eight
-- public functions (EXECUTE for data_api_reader only).
--
-- ------------------------------------------------------------
-- ONE GATE
-- ------------------------------------------------------------
-- Every public function below that returns a match, a rating change or a
-- total derived from matches reads data_api_match_rows(), and nothing else
-- reads matches, match_participants, match_games or tournament_matches. That
-- function is the privacy boundary for history, in the way the column list of
-- data_api_player_feed is the boundary for the roster (00241). It keeps a row
-- only when:
--   (a) its season is visible: NULL, or a season whose hidden_flag is false;
--   (b) it is final: club confirmed, walkover or voided; tournament completed,
--       walkover or voided, and not a bye;
--   (c) EVERY player on it is published (data_api_published_player).
--
-- (c) drops the WHOLE match when any one player is unpublished, including when
-- that player is only the opponent. Keeping the visible side would not be
-- enough: its rating before and delta, with the Elo formula, give back the
-- hidden member's rating. The consequence, documented in API.md: the lifetime
-- counters in /v1/players will not add up to /v1/matches.
--
-- ------------------------------------------------------------
-- TWO VISIBILITY TESTS, ON PURPOSE
-- ------------------------------------------------------------
-- PUBLISHED (data_api_published_player): not hide_from_leaderboard, no
-- deletion request, not pending_approval. Governs everything historical.
-- ROSTER (00241's four conditions, in data_api_players): also active and not
-- suspended. Governs /v1/players and the standings ladders.
-- Using the roster test for history would erase every match of every member
-- who went inactive or graduated, and leave holes in their opponents' records
-- that the member app does not have. Suspension is disciplinary, not a privacy
-- choice, so a suspended member's past matches stay. deletion_requested_at
-- survives the 00155 purge, so the privacy arm holds after a purge.
--
-- ------------------------------------------------------------
-- MATCH REFS
-- ------------------------------------------------------------
-- A match is named to a consumer by an opaque match_ref, sha256 of the
-- consumer's salt, a ':m:' domain tag, the source and the id. Raw ids would let
-- two consumers join on a shared match id and so map one consumer's player_refs
-- onto the other's. Seasons, tournaments and events keep their raw ids: they
-- are club objects already visible in public URLs.
--
-- ------------------------------------------------------------
-- SEASON ATTRIBUTION
-- ------------------------------------------------------------
-- By season_id, never by date range. The 00261 rollover stamped days of rows
-- with the older season, and a date range would disagree with the member app.
-- A tournament match takes its season from its tournament.
--
-- ------------------------------------------------------------
-- RATINGS
-- ------------------------------------------------------------
-- Club: `before` is post_rating - rating_delta, the live rating immediately
-- before the applied (clamped) change. pre_rating is the snapshot the
-- calculation used at submission and is not served. Tournament: elo_snapshot
-- entries. A voided row keeps its sides and loses its ratings. Season resets
-- and admin rating edits are not journalled anywhere, so a consumer reads
-- `after` and never sums deltas.
--
-- Every function is SECURITY DEFINER with a pinned search_path, REVOKEd from
-- PUBLIC, anon and authenticated, and granted (when public) to
-- data_api_reader alone. data_api_reader still holds no table privilege.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Internal helpers. No grant.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.data_api_published_player(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM players p
     WHERE p.id = p_player_id
       AND p.hide_from_leaderboard = FALSE
       AND p.deletion_requested_at IS NULL
       AND p.status <> 'pending_approval'
  );
$function$;
COMMENT ON FUNCTION public.data_api_published_player(uuid) IS
  'The data API history test: a member may appear in match history, rating history, head-to-head and draws. hide_from_leaderboard and deletion_requested_at are privacy controls; removing either is a privacy change. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_published_player(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.data_api_visible_season(p_season_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_season_id IS NULL
      OR EXISTS (SELECT 1 FROM seasons s WHERE s.id = p_season_id AND s.hidden_flag = FALSE);
$function$;
COMMENT ON FUNCTION public.data_api_visible_season(uuid) IS
  'True for no season or a season the club has not hidden. A hidden season and everything in it is invisible to the data API. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_visible_season(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.data_api_match_ref(p_consumer_id uuid, p_source text, p_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT encode(
    sha256(convert_to(
      c.player_ref_salt || ':m:' || p_source || ':' || p_id::text || ':' || c.player_ref_salt,
      'utf8'
    )),
    'hex'
  )
  FROM data_api_consumers c
  WHERE c.id = p_consumer_id;
$function$;
COMMENT ON FUNCTION public.data_api_match_ref(uuid, text, uuid) IS
  'The per-consumer name for a match. The '':m:'' tag keeps it from ever equalling a player_ref. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_match_ref(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.data_api_resolve_ref(p_consumer_id uuid, p_player_ref text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.id
    FROM players p
   WHERE p_player_ref ~ '^[0-9a-f]{64}$'
     AND data_api_published_player(p.id)
     AND data_api_player_ref(p_consumer_id, p.id) = p_player_ref
   LIMIT 1;
$function$;
COMMENT ON FUNCTION public.data_api_resolve_ref(uuid, text) IS
  'A player_ref back to a published member id, by rehashing rather than a lookup table (see 00241 on data_api_player_by_ref). Linear in the membership. Internal: no role is granted EXECUTE, since it turns a pseudonym into an id.';
REVOKE ALL ON FUNCTION public.data_api_resolve_ref(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.data_api_tournament_match_players(p_match_id uuid)
RETURNS TABLE(side text, player_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.side, x.player_id
    FROM tournament_matches tm
    CROSS JOIN LATERAL (VALUES ('a', tm.participant_a_id, tm.pair_a_id),
                               ('b', tm.participant_b_id, tm.pair_b_id)) AS s(side, part_id, pair_id)
    CROSS JOIN LATERAL (
      SELECT tp.player_id FROM tournament_participants tp WHERE tp.id = s.part_id
      UNION ALL
      SELECT pr.player1_id FROM tournament_pairs pr WHERE pr.id = s.pair_id
      UNION ALL
      SELECT pr.player2_id FROM tournament_pairs pr WHERE pr.id = s.pair_id
    ) AS x(player_id)
   WHERE tm.id = p_match_id;
$function$;
COMMENT ON FUNCTION public.data_api_tournament_match_players(uuid) IS
  'The players on each side of a tournament match, through its entrant or pair hist. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_tournament_match_players(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.data_api_tournament_match_publishable(p_match_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1
      FROM data_api_tournament_match_players(p_match_id) mp
     WHERE NOT data_api_published_player(mp.player_id)
  );
$function$;
COMMENT ON FUNCTION public.data_api_tournament_match_publishable(uuid) IS
  'True when every player on a tournament match is published. Shared by the match gate and by the draw, so a draw withholds exactly what the match list drops. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_tournament_match_publishable(uuid) FROM PUBLIC, anon, authenticated;

-- THE GATE. participants carries raw player ids, which is safe only because
-- nothing outside the definer functions can call this.
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
      'is_third_place', tm.is_third_place
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
  'THE PRIVACY BOUNDARY OF DATA API HISTORY. Club and tournament matches that are final, in a visible season, with every player published. participants holds raw player ids and is hashed by the public callers after paging. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_match_rows() FROM PUBLIC, anon, authenticated;

-- A participants array as the consumer sees it: refs for ids, ratings dropped
-- on a voided row.
CREATE OR REPLACE FUNCTION public.data_api_sides(p_consumer_id uuid, p_participants jsonb, p_voided boolean)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'a', COALESCE((SELECT jsonb_agg(x.o ORDER BY x.o ->> 'player_ref') FROM (
            SELECT jsonb_build_object(
              'player_ref', data_api_player_ref(p_consumer_id, (e ->> 'player_id')::uuid),
              'won', e -> 'won',
              'rating', CASE WHEN p_voided OR jsonb_typeof(e -> 'after') IS DISTINCT FROM 'number' THEN NULL
                             ELSE jsonb_build_object('before', e -> 'before', 'after', e -> 'after', 'delta', e -> 'delta') END,
              'points_scored', e -> 'points_scored',
              'points_allowed', e -> 'points_allowed',
              'games_won', e -> 'games_won',
              'games_lost', e -> 'games_lost'
            ) AS o
            FROM jsonb_array_elements(p_participants) e WHERE e ->> 'side' = 'a') x), '[]'::jsonb),
    'b', COALESCE((SELECT jsonb_agg(x.o ORDER BY x.o ->> 'player_ref') FROM (
            SELECT jsonb_build_object(
              'player_ref', data_api_player_ref(p_consumer_id, (e ->> 'player_id')::uuid),
              'won', e -> 'won',
              'rating', CASE WHEN p_voided OR jsonb_typeof(e -> 'after') IS DISTINCT FROM 'number' THEN NULL
                             ELSE jsonb_build_object('before', e -> 'before', 'after', e -> 'after', 'delta', e -> 'delta') END,
              'points_scored', e -> 'points_scored',
              'points_allowed', e -> 'points_allowed',
              'games_won', e -> 'games_won',
              'games_lost', e -> 'games_lost'
            ) AS o
            FROM jsonb_array_elements(p_participants) e WHERE e ->> 'side' = 'b') x), '[]'::jsonb)
  );
$function$;
COMMENT ON FUNCTION public.data_api_sides(uuid, jsonb, boolean) IS
  'Turns the gate''s participants array into the consumer-facing sides object. Internal: no role is granted EXECUTE.';
REVOKE ALL ON FUNCTION public.data_api_sides(uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Public functions. EXECUTE for data_api_reader only.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.data_api_active_season(p_consumer_id uuid)
RETURNS TABLE(id uuid, name text, term text, year int, start_date date, end_date date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- p_consumer_id is unused. Every data API function takes it first, so the
  -- service calls them all the same way.
  SELECT s.id, s.name, s.term::text, s.year, s.start_date, s.end_date
    FROM seasons s
   WHERE s.active_flag = TRUE
     AND s.hidden_flag = FALSE
   ORDER BY s.start_date DESC
   LIMIT 1;
$function$;
COMMENT ON FUNCTION public.data_api_active_season(uuid) IS
  'The club''s active season, or zero rows when there is none or it is hidden. Never names a hidden season.';
REVOKE ALL ON FUNCTION public.data_api_active_season(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_active_season(uuid) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_matches(
  p_consumer_id uuid,
  p_season uuid DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_until timestamptz DEFAULT NULL,
  p_player_ref text DEFAULT NULL,
  p_opponent_ref text DEFAULT NULL,
  p_type text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_rated boolean DEFAULT NULL,
  p_status text DEFAULT 'final',
  p_updated_since timestamptz DEFAULT NULL,
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  match_ref text,
  source text,
  status text,
  counts_toward_stats boolean,
  played_at timestamptz,
  updated_at timestamptz,
  season_id uuid,
  season_name text,
  discipline text,
  kind text,
  rated boolean,
  format text,
  games_per_match int,
  points_per_game int,
  walkover jsonb,
  winner_side text,
  score_summary text,
  games jsonb,
  sides jsonb,
  tournament jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_player uuid;
  v_opponent uuid;
BEGIN
  IF p_player_ref IS NOT NULL THEN
    v_player := data_api_resolve_ref(p_consumer_id, p_player_ref);
    IF v_player IS NULL THEN RETURN; END IF;
  END IF;
  IF p_opponent_ref IS NOT NULL THEN
    v_opponent := data_api_resolve_ref(p_consumer_id, p_opponent_ref);
    IF v_opponent IS NULL THEN RETURN; END IF;
  END IF;

  RETURN QUERY
  SELECT
    data_api_match_ref(p_consumer_id, r.source, r.id),
    r.source,
    r.status,
    r.counts_toward_stats,
    r.played_at,
    r.updated_at,
    r.season_id,
    s.name,
    r.discipline,
    r.kind,
    r.rated,
    r.format,
    r.games_per_match,
    r.points_per_game,
    r.walkover,
    r.winner_side,
    r.score_summary,
    r.games,
    data_api_sides(p_consumer_id, r.participants, r.status = 'voided'),
    CASE WHEN r.source = 'tournament'
         THEN jsonb_build_object('id', r.tournament_id, 'event_id', r.event_id) || r.bracket END
  FROM data_api_match_rows() r
  LEFT JOIN seasons s ON s.id = r.season_id
  WHERE (p_status = 'all'
         OR (COALESCE(p_status, 'final') = 'final' AND r.status <> 'voided')
         OR (p_status = 'voided' AND r.status = 'voided'))
    AND (p_season IS NULL OR r.season_id = p_season)
    AND (p_since IS NULL OR r.played_at >= p_since)
    AND (p_until IS NULL OR r.played_at < p_until)
    AND (p_type IS NULL OR r.discipline = p_type)
    AND (p_source IS NULL OR r.source = p_source)
    AND (p_rated IS NULL OR r.rated = p_rated)
    AND (p_updated_since IS NULL OR r.updated_at > p_updated_since)
    AND (v_player IS NULL OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.participants) me
           WHERE me ->> 'player_id' = v_player::text
             AND (v_opponent IS NULL OR EXISTS (
                   SELECT 1 FROM jsonb_array_elements(r.participants) op
                    WHERE op ->> 'player_id' = v_opponent::text
                      AND op ->> 'side' <> me ->> 'side'))))
  ORDER BY
    CASE WHEN p_updated_since IS NOT NULL THEN r.updated_at END ASC,
    CASE WHEN p_updated_since IS NULL THEN r.played_at END DESC NULLS LAST,
    r.source, r.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 501)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END
$function$;
COMMENT ON FUNCTION public.data_api_matches(uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean, text, timestamptz, int, int) IS
  'Match history for one consumer, filtered and paged, read only through data_api_match_hist. An unknown player or opponent ref is zero hist. The limit is clamped to 501 behind the service''s own 400 for anything over 500.';
REVOKE ALL ON FUNCTION public.data_api_matches(uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean, text, timestamptz, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_matches(uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean, text, timestamptz, int, int) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_match_by_ref(p_consumer_id uuid, p_match_ref text)
RETURNS TABLE(
  match_ref text,
  source text,
  status text,
  counts_toward_stats boolean,
  played_at timestamptz,
  updated_at timestamptz,
  season_id uuid,
  season_name text,
  discipline text,
  kind text,
  rated boolean,
  format text,
  games_per_match int,
  points_per_game int,
  walkover jsonb,
  winner_side text,
  score_summary text,
  games jsonb,
  sides jsonb,
  tournament jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The same projection as data_api_matches, over every status, for the one
  -- row whose per-consumer ref matches. Linear in the gate, like the player
  -- lookups.
  SELECT
    data_api_match_ref(p_consumer_id, r.source, r.id),
    r.source,
    r.status,
    r.counts_toward_stats,
    r.played_at,
    r.updated_at,
    r.season_id,
    s.name,
    r.discipline,
    r.kind,
    r.rated,
    r.format,
    r.games_per_match,
    r.points_per_game,
    r.walkover,
    r.winner_side,
    r.score_summary,
    r.games,
    data_api_sides(p_consumer_id, r.participants, r.status = 'voided'),
    CASE WHEN r.source = 'tournament'
         THEN jsonb_build_object('id', r.tournament_id, 'event_id', r.event_id) || r.bracket END
  FROM data_api_match_rows() r
  LEFT JOIN seasons s ON s.id = r.season_id
  WHERE p_match_ref ~ '^[0-9a-f]{64}$'
    AND data_api_match_ref(p_consumer_id, r.source, r.id) = p_match_ref
  LIMIT 1;
$function$;
COMMENT ON FUNCTION public.data_api_match_by_ref(uuid, text) IS
  'One match by its per-consumer match_ref, voided or not.';
REVOKE ALL ON FUNCTION public.data_api_match_by_ref(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_match_by_ref(uuid, text) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_player_published(p_consumer_id uuid, p_player_ref text)
RETURNS TABLE(published boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT TRUE WHERE data_api_resolve_ref(p_consumer_id, p_player_ref) IS NOT NULL;
$function$;
COMMENT ON FUNCTION public.data_api_player_published(uuid, text) IS
  'One row when the ref names a published member, zero otherwise. The history routes 404 on zero.';
REVOKE ALL ON FUNCTION public.data_api_player_published(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_player_published(uuid, text) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_head_to_head(
  p_consumer_id uuid,
  p_player_ref text,
  p_other_ref text,
  p_type text DEFAULT NULL,
  p_season uuid DEFAULT NULL
)
RETURNS TABLE(relation text, discipline text, matches int, wins int, losses int)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := data_api_resolve_ref(p_consumer_id, p_player_ref);
  v_other uuid := data_api_resolve_ref(p_consumer_id, p_other_ref);
BEGIN
  IF v_me IS NULL OR v_other IS NULL OR v_me = v_other THEN RETURN; END IF;
  RETURN QUERY
  SELECT
    CASE WHEN me ->> 'side' = ot ->> 'side' THEN 'partners' ELSE 'opponents' END,
    r.discipline,
    COUNT(*)::int,
    COUNT(*) FILTER (WHERE r.winner_side = me ->> 'side')::int,
    COUNT(*) FILTER (WHERE r.winner_side IS NOT NULL AND r.winner_side <> me ->> 'side')::int
  FROM data_api_match_rows() r
  CROSS JOIN LATERAL (SELECT e FROM jsonb_array_elements(r.participants) e
                       WHERE e ->> 'player_id' = v_me::text LIMIT 1) m(me)
  CROSS JOIN LATERAL (SELECT e FROM jsonb_array_elements(r.participants) e
                       WHERE e ->> 'player_id' = v_other::text LIMIT 1) o(ot)
  WHERE r.counts_toward_stats
    AND (p_type IS NULL OR r.discipline = p_type)
    AND (p_season IS NULL OR r.season_id = p_season)
  GROUP BY 1, 2;
END
$function$;
COMMENT ON FUNCTION public.data_api_head_to_head(uuid, text, text, text, uuid) IS
  'Derived head-to-head and partnership records between two published members, from the gate only. head_to_head_stats and partnership_stats are not read: they include hidden members and hidden seasons.';
REVOKE ALL ON FUNCTION public.data_api_head_to_head(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_head_to_head(uuid, text, text, text, uuid) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_player_seasons(p_consumer_id uuid, p_player_ref text)
RETURNS TABLE(
  season_id uuid,
  season_name text,
  active boolean,
  start_date date,
  discipline text,
  matches int,
  wins int,
  losses int,
  games_won int,
  games_lost int,
  points_scored int,
  points_allowed int,
  final_singles_elo int,
  final_doubles_elo int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := data_api_resolve_ref(p_consumer_id, p_player_ref);
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH mine AS (
    SELECT r.season_id, r.discipline, r.winner_side, e
      FROM data_api_match_rows() r
      CROSS JOIN LATERAL jsonb_array_elements(r.participants) e
     WHERE r.counts_toward_stats
       AND r.season_id IS NOT NULL
       AND e ->> 'player_id' = v_me::text
  ), agg AS (
    SELECT mine.season_id, mine.discipline,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE mine.winner_side = e ->> 'side')::int AS w,
           COUNT(*) FILTER (WHERE mine.winner_side IS NOT NULL AND mine.winner_side <> e ->> 'side')::int AS l,
           COALESCE(SUM((e ->> 'games_won')::int), 0)::int AS gw,
           COALESCE(SUM((e ->> 'games_lost')::int), 0)::int AS gl,
           COALESCE(SUM((e ->> 'points_scored')::int), 0)::int AS ps,
           COALESCE(SUM((e ->> 'points_allowed')::int), 0)::int AS pa
      FROM mine
     GROUP BY mine.season_id, mine.discipline
  ), finals AS (
    SELECT f.season_id, f.singles_elo, f.doubles_elo
      FROM season_final_ratings f
     WHERE f.player_id = v_me
  ), keys AS (
    SELECT agg.season_id, agg.discipline FROM agg
    UNION
    SELECT finals.season_id, NULL::text FROM finals
     WHERE NOT EXISTS (SELECT 1 FROM agg WHERE agg.season_id = finals.season_id)
  )
  SELECT s.id, s.name, s.active_flag, s.start_date, k.discipline,
         COALESCE(a.n, 0), COALESCE(a.w, 0), COALESCE(a.l, 0),
         COALESCE(a.gw, 0), COALESCE(a.gl, 0), COALESCE(a.ps, 0), COALESCE(a.pa, 0),
         fi.singles_elo, fi.doubles_elo
    FROM keys k
    JOIN seasons s ON s.id = k.season_id AND s.hidden_flag = FALSE
    LEFT JOIN agg a ON a.season_id = k.season_id AND a.discipline IS NOT DISTINCT FROM k.discipline
    LEFT JOIN finals fi ON fi.season_id = k.season_id
   ORDER BY s.start_date DESC, k.discipline;
END
$function$;
COMMENT ON FUNCTION public.data_api_player_seasons(uuid, text) IS
  'Derived per-season records for one published member, from matches that count toward stats, plus their archived final ratings. Ratings themselves are lifetime; these totals are the per-season view.';
REVOKE ALL ON FUNCTION public.data_api_player_seasons(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_player_seasons(uuid, text) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_rating_history(
  p_consumer_id uuid,
  p_player_ref text,
  p_type text DEFAULT NULL,
  p_season uuid DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_until timestamptz DEFAULT NULL,
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  at timestamptz,
  discipline text,
  kind text,
  source text,
  match_ref text,
  before int,
  after int,
  delta int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := data_api_resolve_ref(p_consumer_id, p_player_ref);
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;
  RETURN QUERY
  WITH hist AS (
    SELECT r.played_at AS at, r.discipline, 'match'::text AS kind, r.source,
           data_api_match_ref(p_consumer_id, r.source, r.id) AS match_ref,
           r.season_id,
           (e ->> 'before')::int AS before, (e ->> 'after')::int AS after, (e ->> 'delta')::int AS delta,
           r.id AS sort_id
      FROM data_api_match_rows() r
      CROSS JOIN LATERAL jsonb_array_elements(r.participants) e
     WHERE r.status <> 'voided'
       AND e ->> 'player_id' = v_me::text
       AND jsonb_typeof(e -> 'delta') = 'number'
    UNION ALL
    -- Placement bonuses. kind 'rating' grants are keyed on the player id
    -- (00188); participant_credit and legacy markers are not rating changes.
    SELECT g.granted_at, g.discipline, 'placement_bonus'::text, 'tournament'::text,
           NULL::text, t.season_id, NULL::int, NULL::int, g.applied_delta, g.id
      FROM tournament_bonus_grants g
      JOIN tournament_events te ON te.id = g.event_id
      JOIN tournaments t ON t.id = te.tournament_id
     WHERE g.kind = 'rating'
       AND g.subject_id = v_me
       AND g.applied_delta <> 0
       AND t.status <> 'draft'
       AND data_api_visible_season(t.season_id)
  )
  SELECT hist.at, hist.discipline, hist.kind, hist.source, hist.match_ref,
         hist.before, hist.after, hist.delta
    FROM hist
   WHERE (p_type IS NULL OR hist.discipline = p_type)
     AND (p_season IS NULL OR hist.season_id = p_season)
     AND (p_since IS NULL OR hist.at >= p_since)
     AND (p_until IS NULL OR hist.at < p_until)
   ORDER BY hist.at ASC NULLS FIRST, hist.sort_id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 501)
   OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END
$function$;
COMMENT ON FUNCTION public.data_api_rating_history(uuid, text, text, uuid, timestamptz, timestamptz, int, int) IS
  'Per-match rating changes and placement bonuses for one published member. Season resets and admin edits are not journalled, so a consumer reads after rather than summing delta.';
REVOKE ALL ON FUNCTION public.data_api_rating_history(uuid, text, text, uuid, timestamptz, timestamptz, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_rating_history(uuid, text, text, uuid, timestamptz, timestamptz, int, int) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_seasons(p_consumer_id uuid, p_season_id uuid DEFAULT NULL)
RETURNS TABLE(
  id uuid,
  name text,
  term text,
  year int,
  start_date date,
  end_date date,
  active boolean,
  club_matches int,
  tournament_matches int,
  players_with_matches int,
  sessions int,
  tournaments int,
  events int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH final_rows AS (
    SELECT r.season_id, r.source, r.participants
      FROM data_api_match_rows() r
     WHERE r.status <> 'voided'
  )
  SELECT
    s.id, s.name, s.term::text, s.year, s.start_date, s.end_date, s.active_flag,
    (SELECT COUNT(*) FROM final_rows f WHERE f.season_id = s.id AND f.source = 'club')::int,
    (SELECT COUNT(*) FROM final_rows f WHERE f.season_id = s.id AND f.source = 'tournament')::int,
    (SELECT COUNT(DISTINCT e ->> 'player_id') FROM final_rows f
       CROSS JOIN LATERAL jsonb_array_elements(f.participants) e WHERE f.season_id = s.id)::int,
    (SELECT COUNT(*) FROM sessions se WHERE se.season_id = s.id)::int,
    (SELECT COUNT(*) FROM tournaments t WHERE t.season_id = s.id AND t.status <> 'draft')::int,
    (SELECT COUNT(*) FROM club_events ce
      WHERE ce.status IN ('published', 'cancelled')
        AND ce.starts_at >= s.start_date::timestamptz
        AND (s.end_date IS NULL OR ce.starts_at < (s.end_date + 1)::timestamptz))::int
  FROM seasons s
  WHERE s.hidden_flag = FALSE
    AND (p_season_id IS NULL OR s.id = p_season_id)
  ORDER BY s.start_date DESC;
$function$;
COMMENT ON FUNCTION public.data_api_seasons(uuid, uuid) IS
  'Visible seasons with totals computed from the filtered sets. A hidden season is zero rows, so it 404s. Club events carry no season, so they are counted by date.';
REVOKE ALL ON FUNCTION public.data_api_seasons(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_seasons(uuid, uuid) TO data_api_reader;

CREATE OR REPLACE FUNCTION public.data_api_season_standings(p_consumer_id uuid, p_season_id uuid)
RETURNS TABLE(
  source text,
  player_ref text,
  singles_elo int,
  doubles_elo int,
  singles_rank int,
  doubles_rank int,
  matches int,
  wins int,
  losses int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH season AS (
    SELECT s.id, s.active_flag FROM seasons s WHERE s.id = p_season_id AND s.hidden_flag = FALSE
  ), roster AS (
    -- 00241's roster test, the same four conditions data_api_players applies.
    SELECT p.id FROM players p
     WHERE p.active_flag = TRUE
       AND p.status NOT IN ('pending_approval', 'suspended')
       AND p.hide_from_leaderboard = FALSE
       AND p.deletion_requested_at IS NULL
  ), board AS (
    SELECT 'live'::text AS src, r.player_id, r.singles_elo, r.doubles_elo
      FROM ratings r JOIN roster ON roster.id = r.player_id
     WHERE EXISTS (SELECT 1 FROM season WHERE season.active_flag)
    UNION ALL
    SELECT 'archived'::text, f.player_id, f.singles_elo, f.doubles_elo
      FROM season_final_ratings f JOIN roster ON roster.id = f.player_id
     WHERE f.season_id = p_season_id
       AND EXISTS (SELECT 1 FROM season WHERE NOT season.active_flag)
  ), derived AS (
    SELECT (e ->> 'player_id')::uuid AS player_id,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE r.winner_side = e ->> 'side')::int AS w,
           COUNT(*) FILTER (WHERE r.winner_side IS NOT NULL AND r.winner_side <> e ->> 'side')::int AS l
      FROM data_api_match_rows() r
      CROSS JOIN LATERAL jsonb_array_elements(r.participants) e
     WHERE r.counts_toward_stats AND r.season_id = p_season_id
     GROUP BY 1
  )
  SELECT b.src,
         data_api_player_ref(p_consumer_id, b.player_id),
         b.singles_elo, b.doubles_elo,
         (RANK() OVER (ORDER BY b.singles_elo DESC NULLS LAST))::int,
         (RANK() OVER (ORDER BY b.doubles_elo DESC NULLS LAST))::int,
         COALESCE(d.n, 0), COALESCE(d.w, 0), COALESCE(d.l, 0)
    FROM board b
    LEFT JOIN derived d ON d.player_id = b.player_id
   ORDER BY b.singles_elo DESC NULLS LAST, 2;
$function$;
COMMENT ON FUNCTION public.data_api_season_standings(uuid, uuid) IS
  'The ladder for a visible season: live ratings for the active season, season_final_ratings for an archived one. Membership is the roster test. The derived record comes from the gate.';
REVOKE ALL ON FUNCTION public.data_api_season_standings(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_season_standings(uuid, uuid) TO data_api_reader;

-- ------------------------------------------------------------
-- Verification
-- ------------------------------------------------------------
DO $verify$
DECLARE
  v_fn text;
  v_bad text := '';
  v_n integer;
  v_consumer uuid := '00000000-0000-0000-0000-000000000265';
  v_match record;
  v_player uuid;
  v_ref text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_active_season(uuid)',
    'public.data_api_matches(uuid,uuid,timestamptz,timestamptz,text,text,text,text,boolean,text,timestamptz,int,int)',
    'public.data_api_match_by_ref(uuid,text)',
    'public.data_api_player_published(uuid,text)',
    'public.data_api_head_to_head(uuid,text,text,text,uuid)',
    'public.data_api_player_seasons(uuid,text)',
    'public.data_api_rating_history(uuid,text,text,uuid,timestamptz,timestamptz,int,int)',
    'public.data_api_seasons(uuid,uuid)',
    'public.data_api_season_standings(uuid,uuid)'
  ] LOOP
    IF NOT has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'data_api_reader cannot execute ' || v_fn || '; ';
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'anon or authenticated can execute ' || v_fn || '; ';
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_published_player(uuid)',
    'public.data_api_visible_season(uuid)',
    'public.data_api_match_ref(uuid,text,uuid)',
    'public.data_api_resolve_ref(uuid,text)',
    'public.data_api_tournament_match_players(uuid)',
    'public.data_api_tournament_match_publishable(uuid)',
    'public.data_api_match_rows()',
    'public.data_api_sides(uuid,jsonb,boolean)'
  ] LOOP
    IF has_function_privilege('data_api_reader', v_fn, 'EXECUTE')
       OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'internal helper is reachable: ' || v_fn || '; ';
    END IF;
  END LOOP;

  IF v_bad <> '' THEN
    RAISE EXCEPTION '00265 verification failed: %', v_bad;
  END IF;

  -- As the role, every public function answers for an unknown consumer.
  SET LOCAL ROLE data_api_reader;
  PERFORM count(*) FROM public.data_api_active_season(gen_random_uuid());
  PERFORM count(*) FROM public.data_api_matches(gen_random_uuid());
  PERFORM count(*) FROM public.data_api_match_by_ref(gen_random_uuid(), repeat('0', 64));
  PERFORM count(*) FROM public.data_api_player_published(gen_random_uuid(), repeat('0', 64));
  PERFORM count(*) FROM public.data_api_head_to_head(gen_random_uuid(), repeat('0', 64), repeat('1', 64));
  PERFORM count(*) FROM public.data_api_player_seasons(gen_random_uuid(), repeat('0', 64));
  PERFORM count(*) FROM public.data_api_rating_history(gen_random_uuid(), repeat('0', 64));
  PERFORM count(*) FROM public.data_api_seasons(gen_random_uuid());
  PERFORM count(*) FROM public.data_api_season_standings(gen_random_uuid(), gen_random_uuid());
  RESET ROLE;

  -- The gate itself is refused to the role.
  BEGIN
    SET LOCAL ROLE data_api_reader;
    PERFORM count(*) FROM public.data_api_match_rows();
    RESET ROLE;
    RAISE EXCEPTION '00265: data_api_reader can call data_api_match_rows';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
  END;

  -- With data: refs agree with the roster feed, and hiding a player or a
  -- season removes the match. Rolled back by the subtransaction.
  SELECT r.source, r.id, r.season_id, r.participants INTO v_match
    FROM public.data_api_match_rows() r
   WHERE r.status <> 'voided' AND jsonb_array_length(r.participants) > 0
   LIMIT 1;
  IF v_match.id IS NULL THEN
    RAISE NOTICE '00265: no visible match on this database, fixture checks skipped.';
  ELSE
    BEGIN
      INSERT INTO public.data_api_consumers (id, name) VALUES (v_consumer, '00265 self-check');
      v_player := (v_match.participants -> 0 ->> 'player_id')::uuid;
      v_ref := public.data_api_player_ref(v_consumer, v_player);

      SELECT count(*) INTO v_n FROM public.data_api_matches(v_consumer, p_player_ref => v_ref)
       WHERE match_ref = public.data_api_match_ref(v_consumer, v_match.source, v_match.id);
      IF v_n <> 1 THEN
        RAISE EXCEPTION '00265: a player''s own match is missing from data_api_matches filtered by their ref';
      END IF;

      UPDATE public.players SET hide_from_leaderboard = TRUE WHERE id = v_player;
      SELECT count(*) INTO v_n FROM public.data_api_matches(v_consumer, p_status => 'all')
       WHERE match_ref = public.data_api_match_ref(v_consumer, v_match.source, v_match.id);
      IF v_n <> 0 THEN
        RAISE EXCEPTION '00265: a match survived one of its players hiding from the leaderboard';
      END IF;
      UPDATE public.players SET hide_from_leaderboard = FALSE WHERE id = v_player;

      IF v_match.season_id IS NOT NULL THEN
        UPDATE public.seasons SET hidden_flag = TRUE WHERE id = v_match.season_id;
        SELECT count(*) INTO v_n FROM public.data_api_matches(v_consumer, p_status => 'all')
         WHERE match_ref = public.data_api_match_ref(v_consumer, v_match.source, v_match.id);
        IF v_n <> 0 THEN
          RAISE EXCEPTION '00265: a match survived its season being hidden';
        END IF;
      END IF;

      RAISE EXCEPTION USING ERRCODE = 'P0265', MESSAGE = 'rollback';
    EXCEPTION WHEN SQLSTATE 'P0265' THEN
      NULL;
    END;
  END IF;

  RAISE NOTICE '00265 verified: nine public functions reachable by data_api_reader only, the gate and its helpers reachable by nobody, and a hidden player or season drops the match.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
