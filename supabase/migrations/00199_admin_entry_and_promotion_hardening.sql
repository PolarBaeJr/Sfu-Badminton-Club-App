-- 00199 — the admin entry paths take the field lock, and the promotion RPC
--         stops trusting its caller (round-8 review of 00198)
--
-- Round 8 read 00198 and found the fence incomplete in one place that matters,
-- plus a set of smaller defects in the promotion RPC itself.
--
-- THE REAL DEFECT. 00196 put the PLAYER's own entry under the field advisory
-- lock and 00198 put the POOL PROMOTION under it, but the two paths an EXEC
-- uses were left writing tournament_participants directly over PostgREST:
-- addParticipantToEvent (participants.ts:377) and addParticipantsToEvent
-- (participants.ts:670). Both ask "is this person already half of a pair?" in
-- one round trip and insert in another, and nothing holds the field still
-- between them. There is no cross-table unique constraint that catches it --
-- the pair lives in tournament_pairs and the entry in tournament_participants
-- -- so the interleaving leaves a member in the event TWICE, which is the
-- original F-004 corruption arriving through a different door. Every other
-- writer of this field now cooperates; these two did not, and a lock that only
-- some writers take is not a lock.
--
-- The fix has the same shape as 00196's and 00198's: an advisory lock cannot be
-- held across separate PostgREST round trips, because each round trip IS the
-- transaction, so the check and the insert move into one RPC that takes the
-- lock and asks the question under it.
--
-- BATCH SEMANTICS, decided here rather than left to the caller. If ANY entry in
-- the call collides under the lock, the WHOLE call is refused and nothing is
-- written. That is not a new behaviour: the bulk path's own insert already
-- refused whole on a unique violation ("Someone was registered while this was
-- being submitted, so nothing was added"), because a partial success it cannot
-- describe is worse than a refusal it can. The app keeps its per-player
-- partitioning ABOVE this call, which is what produces the friendly per-person
-- messages; this RPC is the last line, and its refusals mean "the field moved
-- under you", not "this person is ineligible".
--
-- WHAT THIS CORRECTS IN 00198'S OWN TEXT. 00198's header claims that "inserts
-- within one generator's batch re-acquire a lock they already hold, which is a
-- refcount bump and not a wait". THAT SENTENCE IS FALSE and this header
-- supersedes it. Every stamped insert site (brackets.ts:863, :1230, :1766) is a
-- single-row insert and therefore its own transaction, so each one takes a
-- FRESH transaction-level lock and drops it at commit. The contention is still
-- acceptable -- one row statement, not a whole generation -- but it is a real
-- acquisition each time. 00198 is applied and its checksum is recorded, so its
-- text is not edited; the correction lives here.
--
-- The consequence is worth stating plainly, because it bounds what F-005's fix
-- claims: the trigger's lock stops any SINGLE insert straddling a teardown, and
-- nothing more. A teardown landing between match 40 and match 41 is still
-- possible; what catches that is publish_event_draw, which refuses the loser
-- with 'superseded' and the winner with 'foreign_matches' (00197:277-330).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CHANGE. The unlocked
-- players.is_banned / players.membership_type read in 00196 is still unlocked,
-- for the lock-ordering reason 00196's own header gives, and the pool-seeded
-- publish still passes p_expected = null. Round 8 ruled both still open. They
-- are product decisions with refusal behaviour attached, and they are the
-- owner's to make, not this migration's.

BEGIN;

-- ---------------------------------------------------------------------------
-- The exec's entry path, under the same lock as everybody else's
-- ---------------------------------------------------------------------------
-- p_entries is [{"player_id": "<uuid>", "elo_before": <int>}, ...]. elo_before
-- is computed by the caller because it is the DISCIPLINE'S rating and the
-- caller already read the ratings row; this function does not second-guess it.
--
-- p_doubles is NOT a parameter. 00198's promotion RPC took the caller's word
-- for the discipline and round 8 was right to object: the event knows what it
-- is, and this function reads it off the row it locks anyway.
CREATE OR REPLACE FUNCTION public.add_participants_under_field_lock(
  p_event_id uuid,
  p_admin_id uuid,
  p_entries  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament   uuid;
  v_status       text;
  v_locked       boolean;
  v_type         text;
  v_max          integer;
  v_doubles      boolean;
  v_t_status     text;
  v_suspended    timestamptz;
  v_suspend_why  text;
  v_cap          integer;
  v_count        integer;
  v_ids          uuid[];
  v_id           uuid;
  v_pairs        integer;
  v_unpaired     integer;
  v_singles      integer;
  v_before       integer;
  v_after        integer;
  v_entries      integer;
  v_rows         jsonb;
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'add_participants_under_field_lock: p_entries must be a json array';
  END IF;

  SELECT COUNT(*) INTO v_count FROM jsonb_array_elements(p_entries);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', TRUE, 'participants', '[]'::jsonb);
  END IF;

  -- Every entry must name a player and carry an elo. A null elo_before was the
  -- fabricated-400 case the bulk path already refuses above this call; it must
  -- not become writable by reaching this one directly.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_entries) e
     WHERE NULLIF(e->>'player_id', '') IS NULL
        OR NULLIF(e->>'elo_before', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'add_participants_under_field_lock: every entry needs player_id and elo_before';
  END IF;

  SELECT array_agg(DISTINCT (e->>'player_id')::uuid)
    INTO v_ids FROM jsonb_array_elements(p_entries) e;

  IF array_length(v_ids, 1) <> v_count THEN
    RAISE EXCEPTION 'add_participants_under_field_lock: p_entries names the same player twice';
  END IF;

  -- Which tournament, unlocked, purely to know which row to lock next.
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- Field lock, then parent, then event -- the one order the whole schema uses
  -- (00196's header explains why this direction and not merely a convention).
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT t.max_events_per_player, t.status::TEXT, t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), '')
    INTO v_cap, v_t_status, v_suspended, v_suspend_why
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  IF v_suspended IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_suspended',
                              'suspension_reason', v_suspend_why);
  END IF;
  IF v_t_status IN ('completed', 'archived') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_closed', 'status', v_t_status);
  END IF;

  SELECT e.status::TEXT, e.draw_locked, e.event_type::TEXT, e.max_participants
    INTO v_status, v_locked, v_type, v_max
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- The admin path's two statuses, not the player path's one: an exec adds a
  -- walk-up during check-in, which is the whole reason that door exists.
  IF v_status NOT IN ('registration', 'checkin') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status', 'status', v_status);
  END IF;
  IF COALESCE(v_locked, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_locked');
  END IF;

  v_doubles := v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');

  -- ALREADY HALF OF A PAIR -- the question with no constraint behind it, and
  -- the reason this function exists. Withdrawn and disqualified pairs do not
  -- count, consistently with 00196 and with every count below.
  SELECT pr.player1_id INTO v_id
    FROM tournament_pairs pr
   WHERE pr.event_id = p_event_id
     AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
     AND (pr.player1_id = ANY (v_ids) OR pr.player2_id = ANY (v_ids))
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_pair');
  END IF;

  -- ALREADY A PARTICIPANT. The unique constraint would catch this, but a
  -- refusal that names the reason beats a 23505 the caller has to interpret,
  -- and a withdrawn row must not read as a live entry.
  SELECT tp.player_id INTO v_id
    FROM tournament_participants tp
   WHERE tp.event_id = p_event_id
     AND tp.player_id = ANY (v_ids)
     AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered', 'player_id', v_id);
  END IF;

  -- ---- capacity, counted in DRAW SLOTS for doubles --------------------
  IF v_max IS NOT NULL AND v_max > 0 THEN
    IF v_doubles THEN
      SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

      v_before := v_pairs + CEIL(v_unpaired / 2.0);
      v_after  := v_pairs + CEIL((v_unpaired + v_count) / 2.0);

      IF v_after > v_max AND v_after > v_before THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
      END IF;
    ELSE
      SELECT COUNT(*) INTO v_singles FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      IF v_singles + v_count > v_max THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
      END IF;
    END IF;
  END IF;

  -- ---- the per-member cap, under the tournament lock ------------------
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    FOREACH v_id IN ARRAY v_ids LOOP
      SELECT (
        (SELECT COUNT(*) FROM tournament_participants tp
           JOIN tournament_events te ON te.id = tp.event_id
          WHERE te.tournament_id = v_tournament AND tp.player_id = v_id
            AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
        +
        (SELECT COUNT(*) FROM tournament_pairs pr
           JOIN tournament_events te ON te.id = pr.event_id
          WHERE te.tournament_id = v_tournament
            AND (pr.player1_id = v_id OR pr.player2_id = v_id)
            AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      ) INTO v_entries;

      IF v_entries >= v_cap THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_cap',
                                  'cap', v_cap, 'player_id', v_id);
      END IF;
    END LOOP;
  END IF;

  -- ---- the write, in one statement ------------------------------------
  BEGIN
    WITH ins AS (
      INSERT INTO tournament_participants (event_id, player_id, elo_before, added_by, status)
      SELECT p_event_id,
             (e->>'player_id')::uuid,
             (e->>'elo_before')::integer,
             p_admin_id,
             'registered'
        FROM jsonb_array_elements(p_entries) e
      RETURNING *
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) INTO v_rows FROM ins;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered');
  END;

  RETURN jsonb_build_object('ok', TRUE, 'participants', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.add_participants_under_field_lock(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_participants_under_field_lock(uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.add_participants_under_field_lock(uuid, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.add_participants_under_field_lock(uuid, uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- promote_pool_qualifier stops trusting its caller
-- ---------------------------------------------------------------------------
-- Three defects round 8 found in 00198's version, none of them reachable by the
-- current caller and all of them reachable by the NEXT one:
--
--   1. p_elo was `numeric` with a ROUND(...)::integer on the way in. Every
--      source the caller reads (combined_elo, elo_after, elo_before) is an
--      integer column, so the widening bought nothing and silently accepted a
--      fractional Elo that no caller can legitimately produce. The parameter
--      is now `integer`. That is a signature change, so the old one is dropped.
--   2. No p_player1_id <> p_player2_id check, while tournament_pairs has no
--      distinct-player constraint and pair_tournament_entrants enforces it
--      explicitly (00102:98). A pair of one person is not a pair.
--   3. p_doubles was taken on the caller's word. The event knows its own
--      discipline and this function already touches the row; a caller that
--      passes the wrong flag would write a participant row into a doubles
--      bracket, which is the very shape the duplicate check is defending.
DROP FUNCTION IF EXISTS public.promote_pool_qualifier(
  uuid, boolean, uuid, uuid, text, numeric, integer, uuid, timestamptz);

CREATE FUNCTION public.promote_pool_qualifier(
  p_event_id      uuid,
  p_doubles       boolean,
  p_player1_id    uuid,
  p_player2_id    uuid,
  p_pair_name     text,
  p_elo           integer,
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
  v_type     text;
  v_doubles  boolean;
BEGIN
  IF p_event_id IS NULL OR p_player1_id IS NULL THEN
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

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- THE DISCIPLINE, off the event rather than off the argument. Read after the
  -- lock so it is the value the write will actually land against.
  SELECT e.event_type::TEXT INTO v_type
    FROM tournament_events e WHERE e.id = p_event_id;
  IF v_type IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  v_doubles := v_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles');
  IF v_doubles IS DISTINCT FROM COALESCE(p_doubles, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'discipline_mismatch',
                              'event_type', v_type);
  END IF;

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

REVOKE ALL ON FUNCTION public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- 00198's block asserted only that promote_pool_qualifier EXISTS. Round 8 was
-- right that this proves nothing about what is in it: a later CREATE OR REPLACE
-- that dropped the lock would pass. These assertions read the body.
DO $verify$
DECLARE
  v_bad  text[] := ARRAY[]::text[];
  v_src  text;
  v_sig  text := 'public.promote_pool_qualifier(uuid, boolean, uuid, uuid, text, integer, integer, uuid, timestamptz)';
  v_add  text := 'public.add_participants_under_field_lock(uuid, uuid, jsonb)';
BEGIN
  -- ---- the new admin entry fence --------------------------------------
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'add_participants_under_field_lock';
  IF v_src IS NULL THEN
    v_bad := array_append(v_bad, 'add_participants_under_field_lock is missing');
  ELSE
    IF position('pg_advisory_xact_lock' IN v_src) = 0 THEN
      v_bad := array_append(v_bad, 'add_participants_under_field_lock does not take the field lock');
    END IF;
    IF position('tournament_pairs' IN v_src) = 0 THEN
      v_bad := array_append(v_bad, 'add_participants_under_field_lock does not check for an existing pair');
    END IF;
    -- The lock must come before the pair question, or the question is asked of
    -- a field that can still move.
    IF position('pg_advisory_xact_lock' IN v_src) > position('FROM tournament_pairs pr' IN v_src) THEN
      v_bad := array_append(v_bad, 'add_participants_under_field_lock reads the field before locking');
    END IF;
    IF has_function_privilege('anon', v_add, 'EXECUTE')
       OR has_function_privilege('authenticated', v_add, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'add_participants_under_field_lock is executable by anon or authenticated');
    END IF;
    IF NOT has_function_privilege('service_role', v_add, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'add_participants_under_field_lock is not executable by service_role');
    END IF;
  END IF;

  -- ---- the promotion RPC, by BODY and not by existence -----------------
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'promote_pool_qualifier';
  IF v_src IS NULL THEN
    v_bad := array_append(v_bad, 'promote_pool_qualifier is missing');
  ELSE
    IF position('pg_advisory_xact_lock' IN v_src) = 0 THEN
      v_bad := array_append(v_bad, 'promote_pool_qualifier does not take the field lock');
    END IF;
    IF position('already_in_field' IN v_src) = 0 THEN
      v_bad := array_append(v_bad, 'promote_pool_qualifier has no duplicate check');
    END IF;
    IF position('same_player_twice' IN v_src) = 0 THEN
      v_bad := array_append(v_bad, 'promote_pool_qualifier does not refuse a pair of one person');
    END IF;
    IF position('discipline_mismatch' IN v_src) = 0 THEN
      v_bad := array_append(v_bad, 'promote_pool_qualifier does not check the event discipline');
    END IF;
    -- The lock must be taken before the duplicate question is asked.
    IF position('pg_advisory_xact_lock' IN v_src) > position('already_in_field' IN v_src) THEN
      v_bad := array_append(v_bad, 'promote_pool_qualifier asks the duplicate question before locking');
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'promote_pool_qualifier is executable by anon or authenticated');
    END IF;
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'promote_pool_qualifier is not executable by service_role');
    END IF;
  END IF;

  -- The old numeric signature must be gone, or PostgREST has two candidates and
  -- the caller's argument types decide which fence runs.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'promote_pool_qualifier'
       AND pg_get_function_identity_arguments(p.oid) LIKE '%numeric%'
  ) THEN
    v_bad := array_append(v_bad, 'the old numeric promote_pool_qualifier still exists');
  END IF;

  -- ---- 00198's trigger is still attached, and still locks first --------
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tournament_match_generation_is_current';
  IF v_src IS NULL OR position('pg_advisory_xact_lock' IN v_src) = 0
     OR position('pg_advisory_xact_lock' IN v_src) > position('SELECT e.draw_generation_id' IN v_src) THEN
    v_bad := array_append(v_bad, '00198 generation fence is missing or no longer locks before it reads');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'tournament_matches' AND NOT t.tgisinternal
       AND t.tgfoid = 'public.tournament_match_generation_is_current'::regproc
  ) THEN
    v_bad := array_append(v_bad, '00198 generation fence is not attached to tournament_matches');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00199 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00199: the admin entry paths take the field lock; the promotion RPC checks its own arguments.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
