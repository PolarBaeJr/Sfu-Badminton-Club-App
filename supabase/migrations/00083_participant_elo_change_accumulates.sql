-- Make a participant's elo_change the EVENT's swing, not the last match's.
--
-- Every rated match overwrote elo_after and elo_change on the participant row,
-- so the Results tab reported only the most recent match. A champion who went
-- 500 -> 520 -> 535 across three rounds was shown "+15" next to an elo_after of
-- 535 and an elo_before of 500 — three numbers that cannot all be true at once.
--
-- elo_after stays "current rating", which the latest match legitimately owns.
-- elo_change accumulates.
--
-- The reversal has to match: it used to NULL both columns, which threw away
-- every other match the player had already played in the event. It now
-- subtracts just this match's contribution and re-reads the rating the reversal
-- itself left on the ladder. NULLIF(...,0) keeps "no contribution left" looking
-- like the untouched state the column started in.
--
-- Depends on 00082 — these are that migration's function bodies with the stamp
-- changed, so apply them in order.

BEGIN;

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
        -- elo_after is this player's CURRENT rating, so the latest match wins.
        -- elo_change ACCUMULATES: it is the event's swing, and overwriting it
        -- made the Results tab report only the last match — a champion who went
        -- 500 -> 520 -> 535 was shown "+15" beside an elo_after of 535, which
        -- does not even agree with the elo_before printed next to it.
        elo_after = v_new_elo,
        elo_change = COALESCE(tournament_participants.elo_change, 0) + v_applied_delta
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

CREATE OR REPLACE FUNCTION public.reverse_tournament_match_rating(p_match_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_match RECORD;
  v_snapshot jsonb;
  v_discipline text;
  v_entry jsonb;
  v_player_id uuid;
  v_threshold integer := rating_setting_int('provisional_threshold', 8);
  v_has_stats boolean;
  v_has_streak boolean;
  v_elo_field text;
  v_matches_field text;
  v_wins_field text;
  v_losses_field text;
  v_prov_field text;
  v_streak_field text;
  v_pts_scored_field text;
  v_pts_allowed_field text;
  v_games_won_field text;
  v_games_lost_field text;
  v_participant_ids uuid[];
BEGIN
  -- FOR UPDATE for the same reason applying takes it: two desks voiding the same
  -- match at once must serialise, or both read the same snapshot and both
  -- subtract the deltas.
  SELECT * INTO v_match FROM tournament_matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament match not found: %', p_match_id;
  END IF;

  v_snapshot := v_match.elo_snapshot;

  -- Nothing to reverse. Not an error: an unopposed walkover is never rated, and a
  -- retry of a reversal that already committed lands here. This RETURN is the
  -- ONLY quiet exit — a snapshot that exists but cannot be read is a refusal.
  IF v_snapshot IS NULL THEN
    RETURN;
  END IF;

  -- Positive test, and not merely for tidiness. Written as
  -- `jsonb_typeof(v_snapshot->'entries') <> 'array'` inside an OR chain, an
  -- ABSENT 'entries' key makes the operand SQL NULL rather than TRUE, the whole
  -- condition evaluates to NULL, the IF does not fire — and then
  -- jsonb_array_elements(NULL) yields zero rows, so the loop below reverses
  -- NOTHING and the function goes on to clear the snapshot anyway. That is the
  -- same trap 00070's header records, and it turns a malformed row into a
  -- silently discarded rating.
  IF COALESCE(jsonb_typeof(v_snapshot->'entries') = 'array', false) IS NOT TRUE
     OR jsonb_array_length(v_snapshot->'entries') = 0 THEN
    RAISE EXCEPTION 'elo_snapshot on match % has no usable entries array — refusing to clear it', p_match_id;
  END IF;

  v_discipline := v_snapshot->>'discipline';
  IF v_discipline NOT IN ('singles', 'doubles') THEN
    RAISE EXCEPTION 'elo_snapshot on match % has an invalid discipline: %', p_match_id, v_discipline;
  END IF;

  v_elo_field         := v_discipline || '_elo';
  v_matches_field     := v_discipline || '_matches_played';
  v_wins_field        := v_discipline || '_wins';
  v_losses_field      := v_discipline || '_losses';
  v_prov_field        := v_discipline || '_provisional';
  v_streak_field      := 'current_' || v_discipline || '_streak';
  v_pts_scored_field  := v_discipline || '_points_scored';
  v_pts_allowed_field := v_discipline || '_points_allowed';
  v_games_won_field   := v_discipline || '_games_won';
  v_games_lost_field  := v_discipline || '_games_lost';

  FOR v_entry IN SELECT * FROM jsonb_array_elements(v_snapshot->'entries') LOOP
    v_player_id := (v_entry->>'player_id')::uuid;

    -- Positive tests — see this file's header. An absent key yields SQL NULL from
    -- jsonb_typeof, `NULL = 'boolean'` is NULL, and COALESCE(NULL, false) routes
    -- the entry to the older branch, which is the conservative direction.
    v_has_stats  := COALESCE(jsonb_typeof(v_entry->'won') = 'boolean', false);
    v_has_streak := COALESCE(jsonb_typeof(v_entry->'streak_before') = 'number', false)
                    AND COALESCE(jsonb_typeof(v_entry->'streak_after') = 'number', false);

    -- The tiers are meant to be whole. A HALF-present entry — one streak field
    -- but not the other, or streak fields with no `won` — is not an older
    -- snapshot, it is a damaged one, and silently reversing it at a lower tier
    -- would leave the statistics or the reliability count permanently wrong with
    -- nothing to say so. Neither function in this file can produce that shape,
    -- so refuse it rather than guess.
    IF COALESCE(jsonb_typeof(v_entry->'streak_before') = 'number', false)
       <> COALESCE(jsonb_typeof(v_entry->'streak_after') = 'number', false)
       OR (v_has_streak AND NOT v_has_stats) THEN
      RAISE EXCEPTION 'elo_snapshot entry for player % on match % is malformed: streak_before/streak_after/won must be present together',
        v_player_id, p_match_id;
    END IF;

    -- An entry whose ratings row is missing cannot be reversed at all. The
    -- TypeScript version counted that as a per-write failure and pressed on with
    -- the others; here it aborts the whole reversal, because a snapshot cleared
    -- for some players and not others is precisely the half-state this function
    -- exists to make unreachable.
    PERFORM 1 FROM ratings WHERE player_id = v_player_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No ratings row for player % — cannot reverse tournament match %',
        v_player_id, p_match_id;
    END IF;

    IF NOT v_has_stats THEN
      -- Pre-00070 snapshot: its match moved the Elo and nothing else.
      EXECUTE format('UPDATE ratings SET %I = %I - $1, updated_at = NOW() WHERE player_id = $2',
                     v_elo_field, v_elo_field)
        USING (v_entry->>'delta')::integer, v_player_id;
    ELSE
      -- The inverse delta is applied regardless of drift, so the net effect on
      -- the ladder is zero even if intermediate matches moved the rating.
      -- Counts floor at 0: a negative matches_played is a worse lie than a
      -- slightly high one.
      --
      -- The provisional flag is only ever SET here, never cleared — dropping back
      -- under the threshold makes a player provisional again, but crossing it is
      -- the job of applying a match.
      EXECUTE format(
        'UPDATE ratings SET '
        '%I = %I - $1, '
        '%I = GREATEST(%I - 1, 0), '
        '%I = CASE WHEN $2 THEN GREATEST(%I - 1, 0) ELSE %I END, '
        '%I = CASE WHEN NOT $2 THEN GREATEST(%I - 1, 0) ELSE %I END, '
        '%I = GREATEST(%I - $3, 0), '
        '%I = GREATEST(%I - $4, 0), '
        '%I = GREATEST(%I - $5, 0), '
        '%I = GREATEST(%I - $6, 0), '
        '%I = CASE '
        '       WHEN $7 IS NOT NULL AND %I = $8 THEN $7 '
        '       WHEN $2 THEN GREATEST(%I - 1, 0) '
        '       ELSE LEAST(%I + 1, 0) '
        '     END, '
        '%I = CASE WHEN GREATEST(%I - 1, 0) < $9 THEN TRUE ELSE %I END, '
        'updated_at = NOW() '
        'WHERE player_id = $10',
        v_elo_field, v_elo_field,
        v_matches_field, v_matches_field,
        v_wins_field, v_wins_field, v_wins_field,
        v_losses_field, v_losses_field, v_losses_field,
        v_pts_scored_field, v_pts_scored_field,
        v_pts_allowed_field, v_pts_allowed_field,
        v_games_won_field, v_games_won_field,
        v_games_lost_field, v_games_lost_field,
        v_streak_field, v_streak_field, v_streak_field, v_streak_field,
        v_prov_field, v_matches_field, v_prov_field
      ) USING
        (v_entry->>'delta')::integer,
        (v_entry->>'won')::boolean,
        COALESCE((v_entry->>'points_scored')::integer, 0),
        COALESCE((v_entry->>'points_allowed')::integer, 0),
        COALESCE((v_entry->>'games_won')::integer, 0),
        COALESCE((v_entry->>'games_lost')::integer, 0),
        CASE WHEN v_has_streak THEN (v_entry->>'streak_before')::integer END,
        CASE WHEN v_has_streak THEN (v_entry->>'streak_after')::integer ELSE NULL END,
        v_threshold,
        v_player_id;
    END IF;

    -- Only a snapshot written by THIS migration's apply path counted the match on
    -- reliability_metrics, so only that tier may take it back off. A 00070-era
    -- entry has statistics but never touched this counter, and decrementing for
    -- it would subtract a challenge somebody actually played.
    IF v_has_streak THEN
      UPDATE reliability_metrics
        SET matches_completed = GREATEST(matches_completed - 1, 0),
            updated_at = NOW()
        WHERE player_id = v_player_id;
    END IF;
  END LOOP;

  -- Singles stamps elo_after/elo_change on the participant rows; doubles has no
  -- per-player participant row to stamp. Read off the locked match rather than
  -- the snapshot, which has never carried participant ids.
  IF v_discipline = 'singles' THEN
    v_participant_ids := ARRAY(
      SELECT x FROM unnest(ARRAY[v_match.winner_participant_id, v_match.loser_participant_id]) AS x
      WHERE x IS NOT NULL
    );
    IF array_length(v_participant_ids, 1) > 0 THEN
      -- Take THIS match's contribution back out, rather than nulling the pair.
      -- elo_change is the event's running swing now, so nulling it threw away
      -- every other match the player had already played in this event; and
      -- elo_after is their current rating, which is knowable — it is what the
      -- reversal above just left on the ladder.
      UPDATE tournament_participants tp
        SET elo_change = NULLIF(COALESCE(tp.elo_change, 0) - COALESCE(e.delta, 0), 0),
            elo_after  = r.elo
        FROM (
          SELECT (x->>'player_id')::uuid AS player_id, (x->>'delta')::integer AS delta
            FROM jsonb_array_elements(v_snapshot->'entries') AS x
        ) e
        JOIN ratings rt ON rt.player_id = e.player_id
        CROSS JOIN LATERAL (SELECT rt.singles_elo AS elo) r
        WHERE tp.id = ANY(v_participant_ids)
          AND tp.player_id = e.player_id;
    END IF;
  END IF;

  -- Cleared wholesale, in the same transaction as the reversal it describes.
  -- The TypeScript version wrote back a REDUCED snapshot holding whatever had not
  -- come off the ladder, because its rating writes could half-land. They cannot
  -- half-land here, so there is never a remainder — and a snapshot that outlived
  -- its own reversal is what let a retry subtract the deltas twice.
  UPDATE tournament_matches SET
    elo_snapshot = NULL,
    updated_at = NOW()
  WHERE id = p_match_id;
END;
$function$

;

COMMIT;
