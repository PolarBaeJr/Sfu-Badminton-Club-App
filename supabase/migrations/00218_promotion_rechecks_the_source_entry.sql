-- 00218 — A PROMOTION THAT DOES NOT RE-READ ITS SOURCE CAN OVER-ADMIT
--
-- codex round 28 found this and it was right; 00201's cap serialisation does
-- not reach it. The sequence, in full:
--
--   1. max_events_per_player = 1. Member M is in pool event P of tournament T.
--   2. An exec generates a bracket from P. seedBracketFromPool reads the pool
--      standings ONCE, up front, and holds no lock on P afterwards
--      (brackets.ts:571). M is in that snapshot.
--   3. Before the generator reaches M's row, M is withdrawn from P — an
--      ordinary exec action, permitted while P is not completed.
--   4. M now holds zero live entries in T, so enter_tournament_event lets M
--      into a DIFFERENT event E. Correct: the cap counter sees a count of 0.
--   5. The generator reaches M and calls promote_pool_qualifier, which reads
--      no cap, takes no tournament row, and — until this migration — had no
--      way to ask whether M's pool entry still existed. M is inserted into the
--      bracket. M now holds two live entries under a cap of one.
--
-- The generator's own withdrawal guard cannot see this: `existing` is built
-- from the TARGET event only (brackets.ts:625 filters .eq('event_id',
-- eventId)), so a SOURCE-side withdrawal is invisible to it. And
-- computeRoundRobinStandings does filter withdrawals out — but only those
-- visible when the snapshot was taken, which is before step 3.
--
-- THE SOURCE RE-CHECK ALONE IS NOT ENOUGH, and that is the whole reason this
-- function now takes the tournaments row. Re-read at T1, withdrawal commits at
-- T2, M enters E at T3, this insert commits at T4: every read this function
-- makes was true when it made it, and the result is still two entries under a
-- cap of one. What closes it is holding the tournament row from BEFORE the
-- source read until commit, because enter_tournament_event takes that same row
-- (00201). M's entry into E can then no longer interleave — it either goes
-- first and is refused by the cap (the pool row it counts is still live), or it
-- goes second and this function has already seen the withdrawal and skipped.
--
-- Lock order is unchanged and is the one 00196 fixed: advisory field key →
-- tournaments → tournament_events. The row lock slots between the two locks
-- this function already took, so no caller acquires them in a new order.
--
-- WHAT A REFUSAL MEANS. 'source_entry_left' is a SKIP, not an error, and that
-- is not a new product decision: brackets.ts already answers it for the
-- target side — "a qualifier who has withdrawn does not take a slot, and is
-- not resurrected by re-inserting them — the next finisher moves up"
-- (brackets.ts:695). A member who left the pool is in exactly that position.
-- 'already_in_field' keeps its existing meaning and still fails the whole
-- generation, because that one means the field moved, not that somebody left.
--
-- p_source_event_id IS CLIENT-CONTROLLED. It arrives over PostgREST like every
-- other argument, so a caller could pass an unrelated event and make the check
-- vacuous. It is therefore required, and required to belong to the same
-- tournament as the target — the same pairing seedBracketFromPool validates
-- before it calls, asked again here where the write lands.

BEGIN;

-- A new parameter is a new signature. The old one is dropped rather than left
-- beside it: two live overloads of a field writer is exactly the shape the
-- entry-cap guard test refuses, and a stale caller silently resolving to the
-- unchecked nine-argument version is the defect itself coming back.
DROP FUNCTION IF EXISTS public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamptz);

CREATE OR REPLACE FUNCTION public.promote_pool_qualifier(
  p_event_id        uuid,
  p_source_event_id uuid,
  p_doubles         boolean,
  p_player1_id      uuid,
  p_player2_id      uuid,
  p_pair_name       text,
  p_elo             integer,
  p_seed            integer,
  p_admin_id        uuid,
  p_checked_in_at   timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id         uuid;
  v_conflict   text;
  v_type       text;
  v_doubles    boolean;
  v_status     text;      -- 00202
  v_tournament uuid;      -- 00218
  v_src_t      uuid;      -- 00218
  v_missing    uuid;      -- 00218
BEGIN
  IF p_event_id IS NULL OR p_player1_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'bad_arguments');
  END IF;
  -- REQUIRED, not optional. A promotion with no source is a promotion whose
  -- cap check cannot be made, and this function has no business guessing.
  IF p_source_event_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'bad_arguments');
  END IF;
  IF p_doubles AND p_player2_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'bad_arguments');
  END IF;
  -- A pair of one person. No constraint catches it; 00102 refuses it by hand
  -- and so does this.
  IF p_doubles AND p_player1_id = p_player2_id THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'same_player_twice');
  END IF;

  -- Which tournament, read WITHOUT a lock, purely to know which row to lock —
  -- the same probe enter_tournament_event makes and for the same reason. Its
  -- answer is re-asked under the locks below before anything depends on it.
  SELECT e.tournament_id INTO v_tournament
    FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- THE TOURNAMENT ROW — 00218. Not read for any value: nothing below wants a
  -- column off it. It is held because enter_tournament_event holds it while it
  -- counts the cap, and holding it here is what stops an entry into a sibling
  -- event committing between the source re-read and the insert. See the header.
  PERFORM 1 FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  -- THE DISCIPLINE, off the event rather than off the argument. Read after the
  -- lock so it is the value the write will actually land against.
  --
  -- FOR UPDATE IS NEW IN 00202. The lock was taken and the event row was then
  -- read without one, so the row could still move: a finalization committing
  -- 'completed' between this read and the insert below left this function
  -- inserting a checked_in entrant into a finished event.
  SELECT e.event_type::TEXT, e.status::TEXT, e.tournament_id
    INTO v_type, v_status, v_src_t
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_type IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  -- The probe's answer, re-asked. The tournament a row belongs to is not
  -- something any code path rewrites, so this can only fire if one is added
  -- later — and if it does, the row lock being held is on the wrong tournament
  -- and nothing above is serialised at all.
  IF v_src_t IS DISTINCT FROM v_tournament THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_moved_tournament');
  END IF;

  -- ONLY 'completed', AND DELIBERATELY NOT A BLANKET PUBLISHED-STATUS REFUSAL
  -- -- 00202. Promotion into an event whose draw already exists is the normal
  -- case for a redraw, so refusing every generated or live status would break
  -- ordinary work. 'completed' is the one status from which no entrant should
  -- ever be added, and it is the one this defect was about.
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;
  v_doubles := v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');
  IF v_doubles IS DISTINCT FROM COALESCE(p_doubles, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'discipline_mismatch',
                              'event_type', v_type);
  END IF;

  -- THE SOURCE EVENT BELONGS TO THIS TOURNAMENT — 00218. Asked before the
  -- entry check because an unrelated source event would make that check
  -- vacuous: the caller could name any event where the member happens to still
  -- be entered and the cap question would never be put. seedBracketFromPool
  -- validates this pairing too; this is the ask the write lands against.
  SELECT s.tournament_id INTO v_src_t
    FROM tournament_events s WHERE s.id = p_source_event_id;
  IF v_src_t IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'source_event_not_found');
  END IF;
  IF v_src_t IS DISTINCT FROM v_tournament THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'source_event_mismatch');
  END IF;

  -- IS THE ENTRY THAT EARNED THIS PROMOTION STILL THERE? — 00218.
  --
  -- Per member, and by ANY route, because that is the shape the cap counts in:
  -- a pair row is one live entry for both of its members, and a pair has one
  -- status, so a withdrawn pair takes both halves out at once. Withdrawn and
  -- disqualified do not count, consistently with every other field count in
  -- 00196 and 00102.
  --
  -- The reads are unlocked and do not need to be. The tournament row above is
  -- what makes their answers hold: no entry into a sibling event of this
  -- tournament can commit between here and this transaction's end.
  SELECT m.id INTO v_missing
    FROM (SELECT p_player1_id AS id
          UNION ALL
          SELECT p_player2_id WHERE COALESCE(p_doubles, FALSE) AND p_player2_id IS NOT NULL) m
   WHERE NOT EXISTS (
           SELECT 1 FROM tournament_participants tp
            WHERE tp.event_id = p_source_event_id
              AND tp.player_id = m.id
              AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
         )
     AND NOT EXISTS (
           SELECT 1 FROM tournament_pairs pr
            WHERE pr.event_id = p_source_event_id
              AND (pr.player1_id = m.id OR pr.player2_id = m.id)
              AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
         )
   LIMIT 1;

  IF v_missing IS NOT NULL THEN
    -- A SKIP, and the caller treats it as one. They left the pool; the next
    -- finisher moves up. See the header.
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'source_entry_left',
                              'player_id', v_missing);
  END IF;

  -- Is either member ALREADY in this event's field by any route? Withdrawn and
  -- disqualified rows do not count, consistently with every other field count
  -- in 00196 and 00102. A pair row here means the caller's own `existing` map
  -- missed it, which is exactly the race this function exists to lose safely.
  --
  -- This is also what refuses a caller that passes the target as its own
  -- source: the member is live in it, so the source check above passes, and
  -- this one then reports the collision.
  SELECT CASE
           WHEN EXISTS (
             SELECT 1 FROM tournament_participants tp
              WHERE tp.event_id = p_event_id
                AND tp.player_id IN (p_player1_id, p_player2_id)
                AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
           ) THEN 'participant'
           WHEN EXISTS (
             SELECT 1 FROM tournament_pairs pr
              WHERE pr.event_id = p_event_id
                AND (pr.player1_id IN (p_player1_id, p_player2_id)
                  OR pr.player2_id IN (p_player1_id, p_player2_id))
                AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
           ) THEN 'pair'
           ELSE NULL
         END
    INTO v_conflict;

  IF v_conflict IS NOT NULL THEN
    -- NOT counted as a skip. A withdrawal is a state the exec chose and the
    -- next finisher moving up is correct; this is a collision, and promoting
    -- around it would silently build a bracket that disagrees with the pool.
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_field',
                              'conflict', v_conflict);
  END IF;

  BEGIN
    IF p_doubles THEN
      INSERT INTO tournament_pairs
        (event_id, player1_id, player2_id, pair_name, combined_elo,
         status, checked_in_at, checked_in_by, seed_number, added_by)
      VALUES
        (p_event_id, p_player1_id, p_player2_id, p_pair_name, p_elo,
         'checked_in', p_checked_in_at, p_admin_id, p_seed, p_admin_id)
      RETURNING id INTO v_id;
    ELSE
      INSERT INTO tournament_participants
        (event_id, player_id, elo_before,
         status, checked_in_at, checked_in_by, seed_number, added_by)
      VALUES
        (p_event_id, p_player1_id, p_elo,
         'checked_in', p_checked_in_at, p_admin_id, p_seed, p_admin_id)
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    -- Belt and braces. The check above holds the lock, so reaching this means a
    -- constraint the check does not model, not the race it does.
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_field',
                              'conflict', 'unique_violation');
  END;

  RETURN jsonb_build_object('ok', TRUE, 'id', v_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.promote_pool_qualifier(uuid, uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_pool_qualifier(uuid, uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamptz) TO service_role;

-- Exactly one live signature. Two would let a stale caller resolve to the
-- version without the source check, which is the defect this migration closes.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'promote_pool_qualifier';
  IF n <> 1 THEN
    RAISE EXCEPTION '00218: expected exactly 1 promote_pool_qualifier, found %', n;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
