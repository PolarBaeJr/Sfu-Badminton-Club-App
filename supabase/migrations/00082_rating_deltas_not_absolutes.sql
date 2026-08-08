-- Make the tournament ladder move by DELTAS, not by absolutes.
--
-- The bug this removes is a lost update that the existing row lock could not
-- prevent, because the lock was taken after the arithmetic. TypeScript read a
-- player's rating, computed `after`, and only then called the RPC; the RPC
-- locked the row and wrote that absolute. Two events rating the same player
-- from 500 — one a +20 win, one a -20 loss — both computed their own absolute,
-- and whichever RPC committed second silently erased the other. The erased
-- match's elo_snapshot still said its delta had been applied, so reversing THAT
-- match later subtracted 20 from a number it had never been added to.
--
-- The ordinary challenge path shows the same shape without any concurrency at
-- all: a challenge stamps pre_rating at submission, a tournament win moves the
-- player, and confirming the challenge writes an absolute computed from the
-- stale pre_rating.
--
-- Deltas commute. Absolutes do not. apply_rating_delta reads the current value
-- THROUGH the lock the caller already holds, adds the delta, and clamps.
--
-- It returns what actually landed, which is not always what was asked for: at
-- the ceiling or the floor the clamp absorbs part of the delta. That figure —
-- not the request — is what goes into the participant row and into the
-- reversal snapshot, because reverse_tournament_match_rating SUBTRACTS the
-- snapshot's delta. Recording the request instead would walk a clamped player
-- past where they started every time a result was corrected.
--
-- apply_rating_stats is dropped: apply_tournament_match_rating was its only
-- caller, and leaving an absolute-writing twin in the schema is an invitation.
--
-- NOT addressed here, and still open: apply_match_result (00041) computes the
-- ordinary challenge path from a stored pre_rating and writes an absolute.
-- Same class of bug, different function, and it needs its own migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_rating_delta(p_player_id uuid, p_discipline text, p_delta integer, p_won boolean, p_points_scored integer, p_points_allowed integer, p_games_won integer, p_games_lost integer)
 RETURNS jsonb
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
  v_lo INTEGER;
  v_hi INTEGER;
  v_old_elo INTEGER;
  v_new_elo INTEGER;
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

  -- The caller holds the row lock (see apply_tournament_match_rating). Read the
  -- CURRENT value through it and add the delta, rather than trusting an absolute
  -- computed before the lock existed. Deltas commute; absolutes do not, and two
  -- events rating the same player at once used to lose one of them entirely.
  SELECT lo, hi INTO v_lo, v_hi FROM rating_bounds();
  EXECUTE format('SELECT %I FROM ratings WHERE player_id = $1', v_elo_field)
    INTO v_old_elo USING p_player_id;
  IF v_old_elo IS NULL THEN
    RAISE EXCEPTION 'No ratings row for player % — cannot apply a rating delta', p_player_id;
  END IF;
  v_new_elo := LEAST(GREATEST(v_old_elo + COALESCE(p_delta, 0), v_lo), v_hi);

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
  ) USING v_new_elo, p_won,
          COALESCE(p_points_scored, 0), COALESCE(p_points_allowed, 0),
          COALESCE(p_games_won, 0), COALESCE(p_games_lost, 0),
          p_player_id, v_threshold;

  -- best_singles_streak / best_doubles_streak are deliberately absent, exactly
  -- as in apply_match_result: the high-water mark is maintained elsewhere.
  -- The caller writes BOTH of these into the participant row and the reversal
  -- snapshot. The applied delta is what actually moved, which differs from the
  -- requested delta whenever the clamp absorbed part of it — and the reversal
  -- subtracts this number, so recording the request instead would push the
  -- player past where they started.
  RETURN jsonb_build_object('new_elo', v_new_elo, 'applied_delta', v_new_elo - v_old_elo);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.apply_tournament_match_rating(p_match_id uuid, p_discipline text, p_entries jsonb)
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
  v_streak_field text;
  v_streak_before integer;
  v_streak_after integer;
  v_won boolean;
  v_snapshot_entries jsonb := '[]'::jsonb;
  -- What the ladder ACTUALLY moved by, which is not always what the caller
  -- asked for: the delta is applied to the value under the lock, and the
  -- clamp can absorb part of it at the ceiling or the floor.
  v_applied jsonb;
  v_new_elo integer;
  v_applied_delta integer;
BEGIN
  IF p_discipline NOT IN ('singles', 'doubles') THEN
    RAISE EXCEPTION 'invalid discipline: %', p_discipline;
  END IF;
  IF p_entries IS NULL
     OR jsonb_typeof(p_entries) <> 'array'
     OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'no rating entries supplied for tournament match %', p_match_id;
  END IF;

  v_streak_field := 'current_' || p_discipline || '_streak';

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

    -- `won` is the snapshot's oldest version marker as well as a statistic:
    -- reversal reads an entry WITHOUT it as pre-00070 and leaves the counts
    -- alone. A caller that omitted it would therefore write a new-format snapshot
    -- that reversal misclassifies as legacy, and the counts would never come off.
    -- The typed builder always sends it; enforce it here anyway, because this
    -- function is the boundary the invariant belongs to.
    -- COALESCE, not a bare comparison: an ABSENT key makes `v_entry->'won'`
    -- SQL NULL, jsonb_typeof(NULL) is NULL, and `NULL <> 'boolean'` is NULL —
    -- which is not TRUE, so the plain form waves the missing key straight
    -- through. A JSON `null` gives the string 'null' and is caught either way.
    IF COALESCE(jsonb_typeof(v_entry->'won'), 'missing') <> 'boolean' THEN
      RAISE EXCEPTION 'rating entry for player % has no boolean "won" — cannot rate tournament match %',
        v_player_id, p_match_id;
    END IF;
    v_won := (v_entry->>'won')::boolean;

    -- A missing ratings row would make the UPDATE below a silent no-op, and the
    -- snapshot would then claim a delta that never landed — the exact class of
    -- lie the snapshot exists to prevent. Refuse the whole match instead.
    --
    -- PERFORM, not the EXECUTE below, is what carries this guard: PL/pgSQL does
    -- NOT set FOUND from an EXECUTE (it sets ROW_COUNT instead), so `IF NOT
    -- FOUND` after the dynamic SELECT would read whatever the previous statement
    -- left behind and wave a missing row through.
    PERFORM 1 FROM ratings WHERE player_id = v_player_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No ratings row for player % — cannot rate tournament match %',
        v_player_id, p_match_id;
    END IF;

    -- Read through the row just locked above: apply_rating_delta derives the new
    -- streak from this value, so anything read outside the lock could disagree
    -- with what actually lands.
    EXECUTE format('SELECT %I FROM ratings WHERE player_id = $1', v_streak_field)
      INTO v_streak_before USING v_player_id;

    -- The DELTA, not the caller's absolute. The caller read the rating, computed
    -- `after`, and only then did this function take the lock — so by the time we
    -- write, `after` may have been computed from a value that no longer exists.
    -- Writing it absolute makes the ladder depend on which RPC finishes last:
    -- two events rating the same player from 500 (one +20, one -20) both wrote
    -- their own absolute, and the second silently erased the first while its
    -- snapshot still claimed the delta had been applied. Reversing that snapshot
    -- then damaged the OTHER match. Deltas commute; absolutes do not.
    SELECT * INTO v_applied FROM apply_rating_delta(
      v_player_id,
      p_discipline,
      (v_entry->>'delta')::integer,
      v_won,
      COALESCE((v_entry->>'points_scored')::integer, 0),
      COALESCE((v_entry->>'points_allowed')::integer, 0),
      COALESCE((v_entry->>'games_won')::integer, 0),
      COALESCE((v_entry->>'games_lost')::integer, 0)
    );
    v_new_elo       := (v_applied->>'new_elo')::integer;
    v_applied_delta := (v_applied->>'applied_delta')::integer;

    -- Mirrors apply_rating_delta's streak expression exactly. Derived rather than
    -- re-read so the two cannot drift: if that expression ever changes, this line
    -- is the one the compiler-less reader has to change with it, and the round
    -- trip a re-read would cost buys nothing.
    v_streak_after := CASE
      WHEN v_won THEN GREATEST(COALESCE(v_streak_before, 0) + 1, 1)
      ELSE LEAST(COALESCE(v_streak_before, 0) - 1, -1)
    END;

    -- The half apply_match_result has always done for challenges. ON CONFLICT
    -- rather than a bare UPDATE: an UPDATE matching no row is a silent no-op, and
    -- while the on-player-insert trigger guarantees a row for every player today,
    -- a silently skipped counter is exactly the failure this file exists to
    -- remove.
    INSERT INTO reliability_metrics (player_id, matches_completed)
    VALUES (v_player_id, 1)
    ON CONFLICT (player_id) DO UPDATE
      SET matches_completed = reliability_metrics.matches_completed + 1,
          updated_at = NOW();

    v_participant_id := NULLIF(v_entry->>'participant_id', '')::uuid;
    IF v_participant_id IS NOT NULL THEN
      UPDATE tournament_participants SET
        elo_after = v_new_elo,
        elo_change = v_applied_delta
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

    -- Built in the loop rather than by a jsonb_agg over p_entries at the end,
    -- because streak_before/streak_after are only known here.
    v_snapshot_entries := v_snapshot_entries || jsonb_build_object(
      'player_id',      v_entry->>'player_id',
      'before',         (v_entry->>'before')::integer,
      -- What LANDED, not what was requested. reverse_tournament_match_rating
      -- subtracts this number, so recording the asked-for delta after the clamp
      -- absorbed part of it would push the player past where they started.
      'after',          v_new_elo,
      'delta',          v_applied_delta,
      -- The statistics reversal needs these, and `won` doubles as the
      -- "this snapshot's statistics were applied" marker.
      'won',            v_won,
      'points_scored',  COALESCE((v_entry->>'points_scored')::integer, 0),
      'points_allowed', COALESCE((v_entry->>'points_allowed')::integer, 0),
      'games_won',      COALESCE((v_entry->>'games_won')::integer, 0),
      'games_lost',     COALESCE((v_entry->>'games_lost')::integer, 0),
      -- Presence of streak_before is the 00078 marker: it says both that the
      -- streak can be restored exactly and that matches_completed was
      -- incremented and must be decremented on the way back out.
      'streak_before',  COALESCE(v_streak_before, 0),
      'streak_after',   v_streak_after
    );
  END LOOP;

  UPDATE tournament_matches SET
    elo_snapshot = jsonb_build_object('discipline', p_discipline, 'entries', v_snapshot_entries),
    updated_at = NOW()
  WHERE id = p_match_id;
END;
$function$

;


DROP FUNCTION IF EXISTS public.apply_rating_stats(uuid, text, integer, boolean, integer, integer, integer, integer);

COMMIT;
