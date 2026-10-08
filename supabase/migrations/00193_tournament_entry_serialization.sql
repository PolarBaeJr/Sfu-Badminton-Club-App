-- 00193 — serialize the three tournament decisions that still raced (F-004, F-005)
--
-- 00185 moved the entry decision into the database and locked the EVENT row, so
-- capacity and "already registered" stopped racing. Three things it did not
-- close are closed here, plus the one F-005 residual that is the same shape.
--
-- ---------------------------------------------------------------------------
-- 1. THE PER-MEMBER ENTRY CAP WAS NEVER SERIALIZED, because it is not an event
--    property. 00185 counts a member's entries ACROSS every event of the
--    tournament while holding a lock on ONE event row. Two entries into two
--    DIFFERENT events of the same tournament therefore take two different
--    locks, neither excludes the other, both count cap-1 existing entries, and
--    both are admitted. The cap is exceeded by exactly the number of events a
--    member can submit at once. 00098's own header said database-level locking
--    was absent; this is the part of that which survived 00185.
--
--    The lock has to be the row the cap belongs to, which is the TOURNAMENT.
--    It is taken BEFORE the event row, parent then child, so that every path
--    through this function acquires the two in the same order and no pair of
--    concurrent entries can deadlock. The cost is that entries to one
--    tournament serialize against each other; at this club's scale that is
--    free, and correctness here is not optional.
--
-- 2. WAIVER EVIDENCE WAS BEST-EFFORT AND WRITTEN AFTERWARDS. The caller
--    inserted event_waiver_acceptances after the RPC returned, discarding the
--    result. A member could therefore be registered with no acceptance record
--    at all, and the audit's finding on this is blunt: legal evidence should
--    not be best-effort. It moves inside the transaction that creates the
--    entry, so the entry and the evidence stand or fall together.
--
--    The function also refuses an entry that brings no hash when the tournament
--    HAS a waiver. The application already refuses this, but the application is
--    not the boundary — this function is reachable by anything holding the
--    service key, and "you accepted the waiver" is precisely the claim that
--    should not rest on the caller having checked.
--
--    It does NOT recompute the hash. eventWaiverHash lives in TypeScript and
--    duplicating it in plpgsql would create two definitions of what a waiver
--    text hashes to, which is a worse failure than the one being fixed. What is
--    enforced here is presence; the value stays the caller's assertion.
--
-- 3. WITHDRAWAL WAS READ-THEN-UPDATE. The caller read the participant row and
--    the event status, decided, and then issued an unfenced UPDATE keyed on the
--    participant id. A draw published in between turned a legitimate refusal
--    into a silent withdrawal from an event that already has a bracket, which
--    is the exact state the check exists to prevent: the entry stays seeded,
--    the match stays playable, and the forfeit cascade never runs.
--
-- 4. (F-005 residual) PUBLISHING A DRAW WAS NOT FENCED AGAINST A LATE ENTRY.
--    assertFieldDidNotGrow re-counts the field immediately before the status
--    flip, but "immediately before" is not "atomically with": an entry landing
--    between the re-count and the flip is admitted by 00185 — correctly, the
--    event is still open — and is not in the bracket. publish_event_draw does
--    the re-count and the flip under one lock on the event row, which is the
--    same row an entry must take, so the two orderings are the only two
--    possible: the entry commits first and the publish refuses, or the publish
--    commits first and the entry is refused as registration_closed.
--
-- WHAT THIS STILL DOES NOT CLAIM. Draw GENERATION remains dozens of separate
-- round trips; only its publication is atomic. A generation that dies half way
-- still leaves matches behind, and re-running it deletes and rebuilds them —
-- that recovery path is unchanged and is what makes the partial state benign.

BEGIN;

-- ===========================================================================
-- enter_tournament_event — tournament lock, and the waiver inside the entry
-- ===========================================================================
--
-- The four-argument form is dropped rather than left beside the new one: a call
-- omitting the waiver arguments would bind to it exactly and get the old
-- unfenced behaviour. With it gone the same call resolves here through the
-- defaults, which for a tournament with no waiver is unchanged, and for one
-- WITH a waiver is refused. That refusal is the right way round: during the
-- window where the old image is still serving, a member entering a waiver
-- tournament is told to try again rather than being entered with no evidence.
DROP FUNCTION IF EXISTS public.enter_tournament_event(uuid, uuid, integer, boolean);

CREATE OR REPLACE FUNCTION public.enter_tournament_event(
  p_event_id    UUID,
  p_player_id   UUID,
  p_elo_before  INTEGER,
  p_doubles     BOOLEAN,
  p_waiver_hash TEXT DEFAULT NULL,
  p_user_agent  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status        TEXT;
  v_max           INTEGER;
  v_tournament    UUID;
  v_cap           INTEGER;
  v_waiver_text   TEXT;
  v_pairs         INTEGER;
  v_unpaired      INTEGER;
  v_before        INTEGER;
  v_after         INTEGER;
  v_singles       INTEGER;
  v_entries       INTEGER;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  IF p_elo_before IS NULL THEN
    RAISE EXCEPTION 'enter_tournament_event: p_elo_before may not be null';
  END IF;

  -- Which tournament, read WITHOUT a lock, purely to know which row to lock.
  SELECT e.tournament_id INTO v_tournament FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- PARENT FIRST. This is the lock the per-member cap needs, because the cap is
  -- a tournament property counted across events; a lock on one event row does
  -- not exclude an entry into a sibling event. Taking it before the event row
  -- also fixes the acquisition order for every caller, so two entries can queue
  -- but never deadlock.
  SELECT t.max_events_per_player, NULLIF(BTRIM(COALESCE(t.waiver_text, '')), '')
    INTO v_cap, v_waiver_text
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  -- The waiver gate, checked before anything is written. Presence only: see the
  -- header for why the hash is not recomputed here.
  IF v_waiver_text IS NOT NULL AND NULLIF(BTRIM(COALESCE(p_waiver_hash, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'waiver_required');
  END IF;

  -- The event row is still locked, and still for the same reason: capacity and
  -- the duplicate check must see a state no other entry can move.
  SELECT e.status::TEXT, e.max_participants
    INTO v_status, v_max
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_closed', 'status', v_status);
  END IF;

  -- ---- capacity -------------------------------------------------------
  IF v_max IS NOT NULL AND v_max > 0 THEN
    IF p_doubles THEN
      SELECT COUNT(*) INTO v_pairs
        FROM tournament_pairs
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      SELECT COUNT(*) INTO v_unpaired
        FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

      v_before := v_pairs + CEIL(v_unpaired / 2.0);
      v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);

      IF v_after > v_max AND v_after > v_before THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
      END IF;
    ELSE
      SELECT COUNT(*) INTO v_singles
        FROM tournament_participants
       WHERE event_id = p_event_id
         AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
      IF v_singles >= v_max THEN
        RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_full');
      END IF;
    END IF;
  END IF;

  -- ---- per-member entry cap (00098), now under the tournament lock -----
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    SELECT (
      (SELECT COUNT(*) FROM tournament_participants tp
         JOIN tournament_events te ON te.id = tp.event_id
        WHERE te.tournament_id = v_tournament AND tp.player_id = p_player_id
          AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      +
      (SELECT COUNT(*) FROM tournament_pairs pr
         JOIN tournament_events te ON te.id = pr.event_id
        WHERE te.tournament_id = v_tournament
          AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
          AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
    ) INTO v_entries;

    IF v_entries >= v_cap THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_cap', 'cap', v_cap);
    END IF;
  END IF;

  -- ---- the write ------------------------------------------------------
  BEGIN
    INSERT INTO tournament_participants (event_id, player_id, elo_before, status)
    VALUES (p_event_id, p_player_id, p_elo_before, 'registered');
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered');
  END;

  -- ---- the evidence, in the same transaction --------------------------
  -- Idempotent on the natural key, so a retry of a partly-failed entry does not
  -- fail on the acceptance row. Nothing here is best-effort any more: if this
  -- raises, the participant row goes with it.
  IF v_waiver_text IS NOT NULL THEN
    INSERT INTO event_waiver_acceptances (player_id, tournament_id, waiver_hash, user_agent)
    VALUES (p_player_id, v_tournament, p_waiver_hash, p_user_agent)
    ON CONFLICT (player_id, tournament_id, waiver_hash) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.enter_tournament_event(uuid, uuid, integer, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enter_tournament_event(uuid, uuid, integer, boolean, text, text) TO service_role;

-- ===========================================================================
-- withdraw_from_tournament_event — the decision and the write in one statement
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.withdraw_from_tournament_event(
  p_event_id  UUID,
  p_player_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event_status TEXT;
  v_tournament   UUID;
  v_part_id      UUID;
  v_part_status  TEXT;
  v_paired       BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  -- The event row is the fence. A draw published concurrently either commits
  -- before this lock is taken — in which case the status read below sees it and
  -- refuses — or waits behind it, in which case the withdrawal is already
  -- recorded and the generation counts the field without this member.
  SELECT e.status::TEXT, e.tournament_id
    INTO v_event_status, v_tournament
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_event_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  SELECT tp.id, tp.status::TEXT INTO v_part_id, v_part_status
    FROM tournament_participants tp
   WHERE tp.event_id = p_event_id AND tp.player_id = p_player_id
   FOR UPDATE;

  -- No participant row is not the same as not entered: half of a formed pair is
  -- entered and has no row here. Leaving a pair takes somebody else's team away
  -- from them, so it stays an exec action — the same line the app draws once a
  -- draw exists.
  IF v_part_id IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM tournament_pairs pr
       WHERE pr.event_id = p_event_id
         AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
    ) INTO v_paired;
    IF v_paired THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'in_pair');
    END IF;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_registered');
  END IF;

  IF v_part_status NOT IN ('registered', 'checked_in') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_withdrawable', 'status', v_part_status);
  END IF;

  -- DRAWN_EVENT_STATUSES in packages/shared/src/utils/tournament-withdrawal.ts.
  -- The pool half counts: a pool_to_bracket event publishes its fixtures at
  -- pool_generated and from that moment people have been told who they play.
  IF v_event_status IN ('pool_generated', 'pool_live', 'bracket_generated', 'live', 'completed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_published');
  END IF;

  UPDATE tournament_participants SET status = 'withdrawn' WHERE id = v_part_id;

  RETURN jsonb_build_object('ok', TRUE, 'tournament_id', v_tournament);
END;
$function$;

REVOKE ALL ON FUNCTION public.withdraw_from_tournament_event(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_from_tournament_event(uuid, uuid) TO service_role;

-- ===========================================================================
-- publish_event_draw — re-count and flip under one lock (F-005 residual)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.publish_event_draw(
  p_event_id   UUID,
  p_new_status TEXT,
  p_doubles    BOOLEAN,
  p_expected   INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status TEXT;
  v_now    INTEGER;
BEGIN
  -- statusAfterDraw's four possible outcomes. An unconstrained status argument
  -- on a SECURITY DEFINER function reachable with the service key is a way to
  -- put an event into any state at all, including completed.
  IF p_new_status NOT IN ('bracket_generated', 'live', 'pool_generated', 'pool_live') THEN
    RAISE EXCEPTION 'publish_event_draw: % is not a draw-publication status', p_new_status;
  END IF;

  SELECT e.status::TEXT INTO v_status
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- The same count assertFieldDidNotGrow makes, made again under the lock. The
  -- application's earlier check is not redundant: it fails the generation early
  -- and cheaply. This one is the one that cannot be overtaken.
  IF p_doubles THEN
    SELECT COUNT(*) INTO v_now FROM tournament_pairs
     WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in');
  ELSE
    SELECT COUNT(*) INTO v_now FROM tournament_participants
     WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in');
  END IF;

  IF p_expected IS NOT NULL AND v_now > p_expected THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'field_grew',
                              'expected', p_expected, 'now', v_now);
  END IF;

  UPDATE tournament_events
     SET status = p_new_status, updated_at = NOW()
   WHERE id = p_event_id;

  RETURN jsonb_build_object('ok', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.publish_event_draw(uuid, text, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_event_draw(uuid, text, boolean, integer) TO service_role;

DO $verify$
DECLARE
  v_bad TEXT[] := ARRAY[]::TEXT[];
  v_oid oid;
  r RECORD;
BEGIN
  -- The unfenced entry signature must be gone, not merely superseded.
  IF to_regprocedure('public.enter_tournament_event(uuid,uuid,integer,boolean)') IS NOT NULL THEN
    v_bad := array_append(v_bad, 'enter_tournament_event(uuid,uuid,integer,boolean) still exists');
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)'),
      ('public.withdraw_from_tournament_event(uuid,uuid)'),
      ('public.publish_event_draw(uuid,text,boolean,integer)')
    ) AS t(sig)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, r.sig || ' missing');
    ELSE
      IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        v_bad := array_append(v_bad, r.sig || ': anon can execute');
      END IF;
      IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        v_bad := array_append(v_bad, r.sig || ': authenticated can execute');
      END IF;
      IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
        v_bad := array_append(v_bad, r.sig || ': service_role CANNOT execute');
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00193 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00193: entry, withdrawal and draw publication are all serialized.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
