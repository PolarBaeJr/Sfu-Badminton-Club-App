-- ============================================================
-- 00078 — reversing a tournament rating is atomic, exact, and complete
--
-- Builds directly on 00070, which made APPLYING a tournament rating atomic and
-- moved the statistics alongside the Elo. Reversal was left in TypeScript as a
-- read-modify-write batch, and three defects follow from that:
--
-- 1. A RETRY CAN DOUBLE-REVERSE. reverseEloSnapshot reversed each player's
--    ratings row, then wrote the REDUCED snapshot back in a separate round trip.
--    If the rating writes committed and that snapshot write failed, the original
--    snapshot survived on the match with every delta already off the ladder — so
--    the next attempt reversed the same entries a second time. Since 00070 the
--    statistics travel with the Elo, so a double reverse now also takes off a
--    matches_played, a win, a set of points and a set of games that the match
--    never put on. Floors at 0 hide it rather than prevent it.
--
--    The existing partial-reversal machinery (keep the un-reversed entries on the
--    snapshot, retry the remainder) was the mitigation for a batch that could
--    half-land. A single transaction removes the half-landing, so the mitigation
--    and the hazard go together.
--
-- 2. THE STREAK IS NOT RESTORED, ONLY STEPPED. Reversal moved
--    current_*_streak one toward zero. A player on -3 who wins (streak +1) and
--    has that win undone landed on 0, not -3. Exact restoration needs the prior
--    value, which nothing recorded.
--
-- 3. reliability_metrics.matches_completed NEVER MOVED FOR A TOURNAMENT MATCH.
--    apply_match_result increments it for every confirmed challenge; the
--    tournament path did not, so the console's "Matches Completed" figure and the
--    player's own /my-stats page counted only challenges.
--
-- The fix is a matching reverse_tournament_match_rating RPC plus two new fields
-- on each snapshot entry, and the increment 00070 forgot.
--
-- SNAPSHOT COMPATIBILITY — THREE TIERS, DISCRIMINATED BY WHICH KEYS ARE PRESENT.
-- Reversal must not take off what applying never put on, so an older snapshot has
-- to reverse EXACTLY as it does today:
--
--   no `won`               pre-00070. Its match moved singles_elo/doubles_elo and
--                          nothing else. Reverse the Elo alone. (Three such rows
--                          are live in production.)
--   `won`, no `streak_before`
--                          00070-era. Elo and statistics were applied; reliability
--                          was not, and the prior streak was not recorded. Reverse
--                          Elo + statistics, step the streak toward zero, and
--                          leave matches_completed alone.
--   `streak_before` present
--                          00078+. Everything above plus an exact streak restore
--                          and the reliability decrement.
--
-- Every tier test below is POSITIVE (`jsonb_typeof(...) = 'boolean'` /
-- `= 'number'`). That is deliberate and is the opposite of the bug 00070's header
-- describes: an ABSENT key makes `v_entry->'k'` SQL NULL, jsonb_typeof(NULL) is
-- NULL, and `NULL = 'number'` is NULL — not TRUE — so a missing key falls through
-- to the older, more conservative branch. A negative test (`<> 'number'`) would
-- do the opposite and treat a legacy snapshot as new. Do not "tidy" these into
-- negations.
--
-- Re-runnable: CREATE OR REPLACE plus idempotent GRANT/REVOKE and COMMENT.
-- apply_tournament_match_rating keeps its 00070 signature exactly, so the replace
-- needs no DROP and no grant churn.
--
-- DEPLOY ORDERING — APPLY THIS BEFORE THE APP CODE, AND KEEP THE GAP SHORT.
-- reverseEloSnapshot calls reverse_tournament_match_rating unconditionally, so
-- app-code-first means every void, undo, edit, restore and double-no-show fails
-- on an unknown function. Migration-first is the safe order but is not free
-- either: the new apply increments reliability_metrics.matches_completed while
-- the old TypeScript reversal does not decrement it, so a void through the old
-- code in that window leaves the counter one too high for those players.
-- ============================================================


-- ------------------------------------------------------------
-- apply_tournament_match_rating — now records the streak it moved, and counts
-- the match as completed
-- ------------------------------------------------------------
-- Two changes from 00070, both additive:
--
--   * Each snapshot entry gains `streak_before` and `streak_after`. Both are read
--     and derived HERE rather than accepted from the caller: the value that
--     matters is the one in the row at the instant apply_rating_stats runs, under
--     this function's lock, and a caller-supplied figure would be a read from
--     before the lock was taken.
--
--     `streak_after` exists so reversal can tell whether this match is still the
--     player's most recent rated one. Restoring `streak_before` unconditionally
--     would be worse than today's step-toward-zero whenever a later match has
--     since moved the streak: it would rewind to a stale value and erase every
--     result played in between. Comparing the stored `streak_after` with what is
--     actually in the row is what distinguishes the two cases.
--
--   * reliability_metrics.matches_completed is incremented, which
--     apply_match_result has always done for challenges and this path never did.
--
-- The increment lives here and NOT in apply_rating_stats on purpose. 00070's
-- header invites the next edit of apply_match_result to adopt apply_rating_stats;
-- apply_match_result already increments matches_completed itself, so a helper
-- that also did it would double-count every challenge the moment that adoption
-- happened.
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
  v_streak_field text;
  v_streak_before integer;
  v_streak_after integer;
  v_won boolean;
  v_snapshot_entries jsonb := '[]'::jsonb;
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

    -- Read through the row just locked above: apply_rating_stats derives the new
    -- streak from this value, so anything read outside the lock could disagree
    -- with what actually lands.
    EXECUTE format('SELECT %I FROM ratings WHERE player_id = $1', v_streak_field)
      INTO v_streak_before USING v_player_id;

    PERFORM apply_rating_stats(
      v_player_id,
      p_discipline,
      (v_entry->>'after')::integer,
      v_won,
      COALESCE((v_entry->>'points_scored')::integer, 0),
      COALESCE((v_entry->>'points_allowed')::integer, 0),
      COALESCE((v_entry->>'games_won')::integer, 0),
      COALESCE((v_entry->>'games_lost')::integer, 0)
    );

    -- Mirrors apply_rating_stats' streak expression exactly. Derived rather than
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

    -- Built in the loop rather than by a jsonb_agg over p_entries at the end,
    -- because streak_before/streak_after are only known here.
    v_snapshot_entries := v_snapshot_entries || jsonb_build_object(
      'player_id',      v_entry->>'player_id',
      'before',         (v_entry->>'before')::integer,
      'after',          (v_entry->>'after')::integer,
      'delta',          (v_entry->>'delta')::integer,
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
$function$;

COMMENT ON FUNCTION public.apply_tournament_match_rating(uuid, text, jsonb) IS
  'Applies a tournament match''s pre-computed Elo deltas and match statistics to every player, counts the match on reliability_metrics, stamps singles participants'' elo_after/elo_change, and writes the reversal snapshot (including the streak before and after) — all in one transaction, so ratings can never move without a snapshot recording by how much. Raises if the match is already rated.';


-- ------------------------------------------------------------
-- reverse_tournament_match_rating — undo a rated tournament match, all or
-- nothing
-- ------------------------------------------------------------
-- The exact inverse of the function above, and the reason it has to be a single
-- transaction: the TypeScript batch it replaces could reverse the ratings and
-- then fail to write the reduced snapshot, leaving the original snapshot on a
-- match whose deltas were already off the ladder. The next void/undo/edit then
-- reversed them again.
--
-- Idempotent by construction. The snapshot is cleared in the same transaction as
-- the reversal, so a match with no snapshot has nothing to reverse and returns
-- quietly. That is what makes a retry after an unclear outcome safe — the
-- property the TypeScript version could not offer.
--
-- Two figures still cannot be reversed unconditionally:
--   * best_*_streak is a high-water mark, never written on the way in and never
--     written here.
--   * current_*_streak is restored exactly only when this match is still the
--     player's most recent rated one — detected by the stored streak_after
--     matching what is actually in the row. If a later match has moved it since,
--     rewinding to streak_before would erase that later match's effect, so the
--     old step-toward-zero applies instead.
--
--     That detection is a heuristic, and the bound is worth stating: streak
--     values repeat, so later matches CAN return the row to the stored
--     streak_after (win → +1, then a loss to -1, then a win back to +1), and the
--     restore then rewinds over them. Distinguishing that case needs a per-match
--     streak ledger, which is a bigger change than this migration; the
--     pre-00078 behaviour was wrong in that case too, just differently. What is
--     bounded here is the damage: the collision requires the streak to land back
--     on exactly the stored value, and only current_*_streak is affected —
--     ratings, counts and the reliability figure are all reversed from the
--     entry's own numbers and are unaffected by it.
CREATE OR REPLACE FUNCTION public.reverse_tournament_match_rating(
  p_match_id uuid
)
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
      UPDATE tournament_participants
        SET elo_after = NULL, elo_change = NULL
        WHERE id = ANY(v_participant_ids);
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
$function$;

COMMENT ON FUNCTION public.reverse_tournament_match_rating(uuid) IS
  'Reverses a rated tournament match in one transaction: subtracts each player''s Elo delta and match statistics, restores the current streak exactly when this is still their most recent rated match, decrements reliability_metrics.matches_completed, clears singles participants'' elo_after/elo_change, and clears elo_snapshot. A no-op on an unrated match, so a retry can never reverse twice. Handles pre-00070 (Elo only) and 00070-era (no streak, no reliability) snapshots.';


-- ------------------------------------------------------------
-- Grants — same posture as 00070 for every privileged rating RPC.
-- ------------------------------------------------------------
-- This function mutates ratings and carries no in-body is_admin check, so it must
-- not be reachable by an authenticated member sending a direct PostgREST rpc
-- call — a member who could invoke it could erase any tournament result's rating
-- effect. Only the admin service-role client invokes it.
--
-- 00076 revoked TRUNCATE/REFERENCES/TRIGGER schema-wide and changed the default
-- privileges; nothing here re-grants them.
REVOKE EXECUTE ON FUNCTION public.reverse_tournament_match_rating(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reverse_tournament_match_rating(uuid)
  TO service_role;

-- apply_tournament_match_rating keeps its 00070 signature, so CREATE OR REPLACE
-- preserves its grants. Restated so this file is self-contained if it is ever
-- replayed onto a database that has 00070 but lost the grants.
REVOKE EXECUTE ON FUNCTION public.apply_tournament_match_rating(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_tournament_match_rating(uuid, text, jsonb)
  TO service_role;
