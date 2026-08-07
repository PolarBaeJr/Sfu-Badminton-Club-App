-- ============================================================
-- 00070 — tournament results move the whole rating row, atomically
--
-- Two defects in the tournament rating path, both confirmed against live data:
--
-- 1. It updated ONLY singles_elo/doubles_elo. matches_played, wins, losses,
--    points, games and streaks were never touched and the provisional flag was
--    never cleared, so a player with eight tournament singles matches still
--    read singles_matches_played = 0, stayed provisional forever, and kept
--    drawing the placement K-factor — which is selected FROM that same unchanged
--    count. Live aggregates already disagree: the stored counts equal the
--    regular-match count alone.
--
-- 2. The rating writes and the elo_snapshot write were separate round trips. If
--    the snapshot write failed after the ratings committed, the ladder had moved
--    with no record of by how much — and undoMatchResult, voidMatch and
--    editMatchResult all reverse from that snapshot, so the half-state was
--    unrecoverable from the club app. The old code said as much in its own error
--    message ("the applied deltas must be corrected by hand").
--
-- The fix is one SECURITY DEFINER function that takes the already-computed
-- per-player deltas and does every write in a single transaction:
-- ratings (elo AND statistics), tournament_participants.elo_after, and the
-- snapshot. Either the whole result is rated or none of it is.
--
-- The Elo arithmetic deliberately stays in TypeScript. It reads platform
-- settings, the typed event format and the margin multiplier through
-- @badminton/shared, and re-implementing that in plpgsql would create exactly
-- the cross-engine drift 00041 exists to prevent.
--
-- Re-runnable: CREATE OR REPLACE plus idempotent GRANT/REVOKE and COMMENT.
-- ============================================================


-- ------------------------------------------------------------
-- apply_rating_stats — the single owner of "one rated match landed on this
-- player's ratings row"
-- ------------------------------------------------------------
-- The UPDATE below is lifted VERBATIM from apply_match_result (00041, and
-- verified identical to the live definition on the server) so the two rating
-- engines cannot disagree about what a match does to a ratings row. Do not
-- "tidy" it here without changing it there: that divergence is the whole reason
-- it was extracted.
--
-- apply_match_result itself is intentionally NOT rewritten to call this. 00041's
-- own header records that its body was rebuilt from the LIVE definition because
-- the server had been hand-patched, so a CREATE OR REPLACE of the challenge
-- rating path written from repo text is a real risk to a path this migration is
-- not trying to change. The next edit to apply_match_result should adopt this
-- helper; until then the format string is duplicated on purpose and both copies
-- are known to be byte-identical.
--
-- Bind parameters, not string concatenation, for every VALUE ($1..$8) — only
-- column IDENTIFIERS go through format()'s %I.
CREATE OR REPLACE FUNCTION public.apply_rating_stats(
  p_player_id uuid,
  p_discipline text,
  p_new_elo integer,
  p_won boolean,
  p_points_scored integer,
  p_points_allowed integer,
  p_games_won integer,
  p_games_lost integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_threshold INTEGER := rating_setting_int('provisional_threshold', 8);
  v_elo_field TEXT;
  v_matches_field TEXT;
  v_wins_field TEXT;
  v_losses_field TEXT;
  v_prov_field TEXT;
  v_streak_field TEXT;
  v_pts_scored_field TEXT;
  v_pts_allowed_field TEXT;
  v_games_won_field TEXT;
  v_games_lost_field TEXT;
BEGIN
  IF p_discipline NOT IN ('singles', 'doubles') THEN
    RAISE EXCEPTION 'invalid discipline: %', p_discipline;
  END IF;

  IF p_discipline = 'singles' THEN
    v_elo_field := 'singles_elo'; v_matches_field := 'singles_matches_played';
    v_wins_field := 'singles_wins'; v_losses_field := 'singles_losses';
    v_prov_field := 'singles_provisional'; v_streak_field := 'current_singles_streak';
    v_pts_scored_field := 'singles_points_scored'; v_pts_allowed_field := 'singles_points_allowed';
    v_games_won_field := 'singles_games_won'; v_games_lost_field := 'singles_games_lost';
  ELSE
    v_elo_field := 'doubles_elo'; v_matches_field := 'doubles_matches_played';
    v_wins_field := 'doubles_wins'; v_losses_field := 'doubles_losses';
    v_prov_field := 'doubles_provisional'; v_streak_field := 'current_doubles_streak';
    v_pts_scored_field := 'doubles_points_scored'; v_pts_allowed_field := 'doubles_points_allowed';
    v_games_won_field := 'doubles_games_won'; v_games_lost_field := 'doubles_games_lost';
  END IF;

  EXECUTE format(
    'UPDATE ratings SET %I = $1, %I = %I + 1, %I = CASE WHEN $2 THEN %I + 1 ELSE %I END, %I = CASE WHEN NOT $2 THEN %I + 1 ELSE %I END, %I = $3 + COALESCE(%I, 0), %I = $4 + COALESCE(%I, 0), %I = $5 + COALESCE(%I, 0), %I = $6 + COALESCE(%I, 0), %I = CASE WHEN $2 THEN GREATEST(COALESCE(%I, 0) + 1, 1) ELSE LEAST(COALESCE(%I, 0) - 1, -1) END, %I = CASE WHEN %I + 1 >= $8 THEN FALSE ELSE %I END, updated_at = NOW() WHERE player_id = $7',
    v_elo_field,
    v_matches_field, v_matches_field,
    v_wins_field, v_wins_field, v_wins_field,
    v_losses_field, v_losses_field, v_losses_field,
    v_pts_scored_field, v_pts_scored_field,
    v_pts_allowed_field, v_pts_allowed_field,
    v_games_won_field, v_games_won_field,
    v_games_lost_field, v_games_lost_field,
    v_streak_field, v_streak_field, v_streak_field,
    v_prov_field, v_matches_field, v_prov_field
  ) USING p_new_elo, p_won,
          COALESCE(p_points_scored, 0), COALESCE(p_points_allowed, 0),
          COALESCE(p_games_won, 0), COALESCE(p_games_lost, 0),
          p_player_id, v_threshold;

  -- best_singles_streak / best_doubles_streak are deliberately absent, exactly
  -- as in apply_match_result: the high-water mark is maintained elsewhere.
END;
$function$;

COMMENT ON FUNCTION public.apply_rating_stats(uuid, text, integer, boolean, integer, integer, integer, integer) IS
  'Applies one rated match to a player''s ratings row: new Elo, match count, win/loss, points, games, current streak, and the provisional flag once the threshold is reached. Extracted verbatim from apply_match_result so the tournament engine and the challenge engine cannot drift.';


-- ------------------------------------------------------------
-- apply_tournament_match_rating — rate a tournament match, all or nothing
-- ------------------------------------------------------------
-- p_entries is the per-player result the TypeScript Elo engine computed:
--   [{ player_id, before, after, delta, won,
--      points_scored, points_allowed, games_won, games_lost,
--      participant_id? }]
-- participant_id is present for singles only; doubles has no per-player
-- tournament_participants row to stamp.
--
-- The snapshot is a SUPERSET of the old shape: player_id/before/after/delta are
-- untouched, so the snapshots already in production stay readable, and the
-- statistics are added alongside them.
--
-- Storing the statistics is what makes reversal correct. undoMatchResult,
-- voidMatch and editMatchResult all reverse from this snapshot, and
-- editMatchResult then RE-rates the match — so a snapshot that recorded only the
-- Elo would leave the counts behind on an undo and add a second set on every
-- edit. The presence of the `won` key is also the version marker: an entry
-- without it predates this migration, its statistics were never applied, and
-- reversal must not try to take them off.
CREATE OR REPLACE FUNCTION public.apply_tournament_match_rating(
  p_match_id uuid,
  p_discipline text,
  p_entries jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match RECORD;
  v_entry jsonb;
  v_player_id uuid;
  v_participant_id uuid;
BEGIN
  IF p_discipline NOT IN ('singles', 'doubles') THEN
    RAISE EXCEPTION 'invalid discipline: %', p_discipline;
  END IF;
  IF p_entries IS NULL
     OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'no rating entries supplied for tournament match %', p_match_id;
  END IF;

  -- FOR UPDATE, so two desks entering the same result at once serialise here
  -- rather than both reading a null snapshot and both applying a delta.
  SELECT * INTO v_match FROM tournament_matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament match not found: %', p_match_id;
  END IF;

  -- Same idempotency rule the caller checks before computing, re-checked under
  -- the lock: a populated snapshot means this match's delta is already on the
  -- ladder, and applying a second one would strand the first with nothing
  -- pointing at it.
  IF v_match.elo_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'Tournament match % is already rated', p_match_id;
  END IF;

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
    v_player_id := (v_entry->>'player_id')::uuid;

    -- A missing ratings row would make the UPDATE below a silent no-op, and the
    -- snapshot would then claim a delta that never landed — the exact class of
    -- lie the snapshot exists to prevent. Refuse the whole match instead.
    PERFORM 1 FROM ratings WHERE player_id = v_player_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No ratings row for player % — cannot rate tournament match %',
        v_player_id, p_match_id;
    END IF;

    PERFORM apply_rating_stats(
      v_player_id,
      p_discipline,
      (v_entry->>'after')::integer,
      (v_entry->>'won')::boolean,
      COALESCE((v_entry->>'points_scored')::integer, 0),
      COALESCE((v_entry->>'points_allowed')::integer, 0),
      COALESCE((v_entry->>'games_won')::integer, 0),
      COALESCE((v_entry->>'games_lost')::integer, 0)
    );

    v_participant_id := NULLIF(v_entry->>'participant_id', '')::uuid;
    IF v_participant_id IS NOT NULL THEN
      UPDATE tournament_participants SET
        elo_after = (v_entry->>'after')::integer,
        elo_change = (v_entry->>'delta')::integer
      WHERE id = v_participant_id;
      -- An id that matches nothing would leave the participant row unstamped
      -- while the ratings and the snapshot committed. Refuse the match instead;
      -- a silently skipped write is the failure mode this whole function exists
      -- to remove.
      IF NOT FOUND THEN
        RAISE EXCEPTION 'No tournament_participants row % — cannot rate tournament match %',
          v_participant_id, p_match_id;
      END IF;
    END IF;
  END LOOP;

  UPDATE tournament_matches SET
    elo_snapshot = jsonb_build_object(
      'discipline', p_discipline,
      'entries', (
        SELECT jsonb_agg(jsonb_build_object(
          'player_id',      e->>'player_id',
          'before',         (e->>'before')::integer,
          'after',          (e->>'after')::integer,
          'delta',          (e->>'delta')::integer,
          -- The statistics reversal needs these, and `won` doubles as the
          -- "this snapshot's statistics were applied" marker.
          'won',            (e->>'won')::boolean,
          'points_scored',  COALESCE((e->>'points_scored')::integer, 0),
          'points_allowed', COALESCE((e->>'points_allowed')::integer, 0),
          'games_won',      COALESCE((e->>'games_won')::integer, 0),
          'games_lost',     COALESCE((e->>'games_lost')::integer, 0)
        ))
        FROM jsonb_array_elements(p_entries) e
      )
    ),
    updated_at = NOW()
  WHERE id = p_match_id;
END;
$function$;

COMMENT ON FUNCTION public.apply_tournament_match_rating(uuid, text, jsonb) IS
  'Applies a tournament match''s pre-computed Elo deltas and match statistics to every player, stamps singles participants'' elo_after/elo_change, and writes the reversal snapshot — all in one transaction, so ratings can never move without a snapshot recording by how much. Raises if the match is already rated.';


-- ------------------------------------------------------------
-- Grants — same posture as 00018 for every privileged rating RPC.
-- ------------------------------------------------------------
-- Both functions mutate ratings and neither carries an in-body is_admin check,
-- so they must not be reachable by an authenticated member sending a direct
-- PostgREST rpc call. Only the admin service-role client invokes them.
REVOKE EXECUTE ON FUNCTION public.apply_rating_stats(uuid, text, integer, boolean, integer, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_rating_stats(uuid, text, integer, boolean, integer, integer, integer, integer)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_tournament_match_rating(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_tournament_match_rating(uuid, text, jsonb)
  TO service_role;
