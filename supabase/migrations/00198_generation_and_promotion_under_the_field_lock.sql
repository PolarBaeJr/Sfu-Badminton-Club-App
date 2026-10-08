-- 00198 — the generation fence and the pool promotion both take the field lock
--         (F-004 core / F-005 residual, from the round-7 review)
--
-- 00196 put the ENTRY path under the field advisory lock. 00197 gave a draw
-- generation a token so a superseded generator cannot write. The round-7 review
-- found that neither is serialized where it has to be, and both defects have the
-- same shape: a check that reads state nothing is holding still.
--
-- F-005. 00197's BEFORE INSERT trigger reads tournament_events.draw_generation_id
-- with a plain SELECT. A plain SELECT takes no lock, so between the trigger's
-- read and the heap insert a second generator can run delete_phase_matches --
-- which deletes the phase and CLAIMS a new generation -- and publish. The first
-- generator's row then lands in a draw that has already been advertised, and its
-- own local copy of the generation is stale in a way it cannot detect. The fix
-- is not a row lock on tournament_events: delete_phase_matches issues its
-- UPDATE at the END of its body, AFTER the DELETE, so a lock that only conflicts
-- with the claim would let the teardown delete this generator's rows and only
-- then block. The lock that conflicts at the right moment is the field advisory
-- lock, which delete_phase_matches takes as its FIRST statement (00197:127).
-- Taking it in the trigger puts the read and the claim in one order:
--
--   * teardown first  -> the trigger blocks, then reads the NEW generation,
--                        finds it different, and refuses. Correct.
--   * insert first    -> the teardown blocks before it deletes anything, then
--                        tears down this row along with the rest and rebuilds.
--                        Correct.
--
-- No deadlock is introduced: both paths take this lock BEFORE any row lock, so
-- the advisory-then-tournaments-then-event order 00196's header fixes is
-- preserved. The lock is taken only for STAMPED rows -- the NULL early return
-- stays above it -- so an insert from any other code path is not serialized at
-- all, and inserts within one generator's batch re-acquire a lock they already
-- hold, which is a refcount bump and not a wait.
--
-- F-004. enter_tournament_event takes the field lock; the POOL PROMOTION in
-- buildFieldFromPool did not. It inserted into tournament_pairs and
-- tournament_participants directly over PostgREST, so a member's entry and a
-- promotion of that same member could interleave and leave them BOTH a
-- participant and half a pair -- the original duplicate-entry corruption. An
-- advisory lock cannot be taken from the application across separate round
-- trips, so the insert moves into this RPC, which takes the same lock and asks
-- the duplicate question under it.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CHANGE. players.is_banned and
-- players.membership_type are still read without FOR SHARE in 00196. That is a
-- documented decision with a stated cost (00196's header, "WHAT DOES NOT GET A
-- LOCK"): locking players would add a fourth relation to an acquisition order
-- that half the application writes for reasons unrelated to tournaments, and a
-- lock ordering only one function respects is not an ordering. The residual
-- window is microseconds and its consequence is one entry an exec can withdraw.
-- It is carried forward as an accepted limitation, not closed here.

BEGIN;

-- ===========================================================================
-- F-005 — the fence reads the generation under the lock that claims it
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.tournament_match_generation_is_current()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_current uuid;
BEGIN
  -- Unstamped rows are not fenced, and are not serialized either. See 00197's
  -- header: the fence is for superseded generators, and only a generator
  -- stamps. Keeping this above the lock is what stops every unrelated insert
  -- into tournament_matches from queueing behind a teardown.
  IF NEW.draw_generation_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- THE LOCK, BEFORE THE READ (00198). Same key delete_phase_matches takes as
  -- its first statement, so the read below cannot straddle a teardown: either
  -- this row commits before the teardown starts deleting, or the read happens
  -- after the teardown has claimed and sees a generation it does not match.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(NEW.event_id::text));

  SELECT e.draw_generation_id INTO v_current
    FROM tournament_events e WHERE e.id = NEW.event_id;

  IF v_current IS DISTINCT FROM NEW.draw_generation_id THEN
    RAISE EXCEPTION
      'This draw was rebuilt by somebody else while it was being generated, so these matches were not saved. Press Generate again to build the current draw.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- ===========================================================================
-- F-004 — the pool promotion enters the field the way an entry does
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.promote_pool_qualifier(
  p_event_id      uuid,
  p_doubles       boolean,
  p_player1_id    uuid,
  p_player2_id    uuid,
  p_pair_name     text,
  p_elo           numeric,
  p_seed          integer,
  p_admin_id      uuid,
  p_checked_in_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id       uuid;
  v_conflict text;
  v_elo      integer := CASE WHEN p_elo IS NULL THEN NULL ELSE ROUND(p_elo)::integer END;
BEGIN
  IF p_event_id IS NULL OR p_player1_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'bad_arguments');
  END IF;
  IF p_doubles AND p_player2_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'bad_arguments');
  END IF;

  -- THE SAME LOCK THE ENTRY PATH TAKES (00196:120). This is the whole point of
  -- the function: the duplicate question below is only answerable while the
  -- lock is held, because enter_tournament_event asks the mirror-image question
  -- under it. Without this, both could answer "no" and both could insert.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- Is either member ALREADY in this event's field by any route? Withdrawn and
  -- disqualified rows do not count, consistently with every other field count
  -- in 00196 and 00102. A pair row here means the caller's own `existing` map
  -- missed it, which is exactly the race this function exists to lose safely.
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
    -- The caller refuses the generation instead -- no matches exist yet at this
    -- point, so re-running it is the whole remedy.
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_field',
                              'conflict', v_conflict);
  END IF;

  BEGIN
    IF p_doubles THEN
      INSERT INTO tournament_pairs
        (event_id, player1_id, player2_id, pair_name, combined_elo,
         status, checked_in_at, checked_in_by, seed_number, added_by)
      VALUES
        (p_event_id, p_player1_id, p_player2_id, p_pair_name, v_elo,
         'checked_in', p_checked_in_at, p_admin_id, p_seed, p_admin_id)
      RETURNING id INTO v_id;
    ELSE
      INSERT INTO tournament_participants
        (event_id, player_id, elo_before,
         status, checked_in_at, checked_in_by, seed_number, added_by)
      VALUES
        (p_event_id, p_player1_id, v_elo,
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

REVOKE ALL ON FUNCTION public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, numeric, integer, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, numeric, integer, uuid, timestamptz)
  TO service_role;

-- ===========================================================================
-- Verification — the two properties this migration exists to create
-- ===========================================================================
DO $verify$
DECLARE
  v_bad text[] := ARRAY[]::text[];
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tournament_match_generation_is_current';

  IF v_src IS NULL THEN
    v_bad := array_append(v_bad, 'trigger function is missing');
  ELSIF position('pg_advisory_xact_lock' in v_src) = 0 THEN
    v_bad := array_append(v_bad, 'trigger function does not take the field lock');
  -- The lock must come BEFORE the read, or it fences nothing.
  ELSIF position('pg_advisory_xact_lock' in v_src) > position('draw_generation_id INTO v_current' in v_src) THEN
    v_bad := array_append(v_bad, 'trigger function reads the generation before locking');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'promote_pool_qualifier'
  ) THEN
    v_bad := array_append(v_bad, 'promote_pool_qualifier is missing');
  END IF;

  -- The promotion RPC writes the field as a definer. anon and authenticated
  -- must not be able to call it; only the admin app's service role.
  IF has_function_privilege('anon', 'public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, numeric, integer, uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, numeric, integer, uuid, timestamptz)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'promote_pool_qualifier is executable by anon or authenticated');
  END IF;

  IF NOT has_function_privilege('service_role', 'public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, numeric, integer, uuid, timestamptz)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'promote_pool_qualifier is not executable by service_role');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00198 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00198: the generation fence and the pool promotion both take the field lock.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
