-- 00196 — the eligibility facts an entry is decided on, read under the lock it
--         is decided under (F-004 residual)
--
-- 00193 serialized the three things that are COUNTED — capacity, the per-member
-- cap, the duplicate — by locking the tournament and then the event. What it did
-- not move is the set of facts that decide whether this member may enter AT ALL.
-- Those still lived in registerForEventImpl: the tournament's status, its
-- suspension, its allowed_memberships, the member's own suspension, and whether
-- the member is already half of a pair. Every one of them was read hundreds of
-- milliseconds before the RPC, under the service role, with nothing holding any
-- of it still, and every one of them fails OPEN — the read says "eligible", the
-- world changes, the entry lands anyway.
--
-- Concretely, and each of these is a sequence and not a worry:
--
--   * An exec suspends a tournament, or archives it, while a member is on the
--     registration dialog. The member's read said 'active'; the insert happens
--     after the suspension commits. They are entered into a suspended
--     tournament and nothing in the database ever objected.
--   * An exec narrows allowed_memberships to internal-only. An alumnus whose
--     read caught the old array enters anyway.
--   * An exec bans a member between requirePlayer() and the RPC. The ban is the
--     one gate whose entire purpose is to stop the account acting.
--   * An exec pairs the member with somebody in the same event. add_tournament_pair
--     (00102) does that under an advisory lock on the event field, checks that
--     neither player is spoken for, and commits. enter_tournament_event held no
--     such lock, so the participant row goes in beside the pair and the member is
--     now in the event twice — counted twice by capacity, twice by the entry cap,
--     and seeded twice by the generator.
--
-- WHAT MOVES, AND WHY IT IS CHEAP. status, suspended_at, suspension_reason and
-- allowed_memberships are columns of the tournaments row 00193 ALREADY locks
-- FOR UPDATE. Reading them costs nothing extra and they become as serialized as
-- the entry cap is, because they are the same row lock. This is the whole of the
-- fix for three of the four sequences above.
--
-- WHAT DOES NOT GET A LOCK, AND WHY THAT IS DELIBERATE. players.is_banned and
-- players.membership_type are read inside the transaction but WITHOUT FOR SHARE.
-- Taking the players row would put a fourth relation into the acquisition order
-- of a function that already fixes tournaments-then-event, and players is a row
-- that half the application updates for reasons that have nothing to do with
-- tournaments — attendance, ratings, profile edits. A lock ordering that only
-- this function respects is not an ordering. The residual window is therefore a
-- ban or a membership change that commits between this SELECT and the INSERT a
-- few statements later, which is microseconds rather than the round trips the
-- old shape left open, and the consequence of losing it is one entry an exec can
-- withdraw. That is a real limitation and it is stated rather than papered over.
--
-- THE ADVISORY LOCK IS TAKEN FIRST, before the tournaments row. It is the same
-- lock add_tournament_pair, unpair_tournament_pair, swap_tournament_pair_member
-- (00102, 00103, 00125) and delete_phase_matches (00144) take, and none of those
-- four takes the tournaments row at all — 00193's is the only FOR UPDATE on that
-- table in the schema. So advisory-then-tournaments-then-event is a total order
-- every caller agrees on, and the pair check below is the check that lock was
-- always missing: holding it without asking the question would have serialized
-- nothing.
--
-- THE APPLICATION KEEPS ITS COPIES. They are not redundant: they produce the
-- sentence the member reads, they do it before the waiver dialog rather than
-- after, and they refuse without a round trip. What changes is that they are no
-- longer the boundary. Reaching one of the new reason codes means the app-side
-- check and this function disagreed, which is exactly the race being closed, and
-- each one gets its own sentence rather than the generic retry message.

BEGIN;

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
  v_t_status      TEXT;
  v_suspended     TIMESTAMPTZ;
  v_suspend_why   TEXT;
  v_allowed       membership_type[];
  v_banned        BOOLEAN;
  v_membership    membership_type;
  v_in_pair       BOOLEAN;
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

  -- THE FIELD LOCK, FIRST. Everything that changes who is in this event holds
  -- it: pairing, unpairing, swapping a partner, tearing a draw down. An entry
  -- changes who is in the event too, and until now it was the one operation
  -- that did so without asking. Taken before the two row locks so the whole
  -- schema acquires these three in one order; see the header for why that is
  -- the safe direction and not merely a convention.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- PARENT FIRST. This is the lock the per-member cap needs, because the cap is
  -- a tournament property counted across events; a lock on one event row does
  -- not exclude an entry into a sibling event. Taking it before the event row
  -- also fixes the acquisition order for every caller, so two entries can queue
  -- but never deadlock.
  --
  -- The eligibility columns come off the SAME locked row (00196). They are not
  -- an extra cost and they are not advisory copies of what the caller read:
  -- they are the values as of a state no concurrent exec action can move.
  SELECT t.max_events_per_player,
         NULLIF(BTRIM(COALESCE(t.waiver_text, '')), ''),
         t.status::TEXT,
         t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), ''),
         t.allowed_memberships
    INTO v_cap, v_waiver_text, v_t_status, v_suspended, v_suspend_why, v_allowed
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  -- Suspension before status, in that order, because it is the more specific
  -- and more actionable answer and it is what the player app says first.
  IF v_suspended IS NOT NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_suspended',
                              'suspension_reason', v_suspend_why);
  END IF;

  -- The same two statuses refuseClosedTournament refuses. 'draft' is
  -- deliberately NOT one of them: an unpublished tournament is not a closed
  -- one, and the app has always allowed it.
  IF v_t_status IN ('completed', 'archived') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'tournament_closed', 'status', v_t_status);
  END IF;

  -- The member's own two facts. Unlocked on purpose — see the header.
  SELECT p.is_banned, p.membership_type
    INTO v_banned, v_membership
    FROM players p WHERE p.id = p_player_id;

  IF v_banned IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'player_not_found');
  END IF;
  IF v_banned THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'player_suspended');
  END IF;

  -- isMembershipAllowed, in plpgsql: a null or empty array is "open to
  -- everyone", which is the shape a tournament that never set the field has.
  IF v_allowed IS NOT NULL AND array_length(v_allowed, 1) > 0
     AND NOT (COALESCE(v_membership, 'internal') = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'membership_not_allowed',
                              'allowed', to_jsonb(v_allowed));
  END IF;

  -- The waiver gate, checked before anything is written. Presence only: see
  -- 00193's header for why the hash is not recomputed here.
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

  -- ALREADY HALF OF A PAIR. There is no unique constraint that catches this:
  -- the pair lives in a different table from the participant row, so the insert
  -- below succeeds and the member is in the event twice. This is the question
  -- the advisory lock above exists to make answerable — add_tournament_pair
  -- holds the same lock while it decides that neither player is spoken for, so
  -- the two orderings are the only two possible.
  --
  -- Withdrawn and disqualified pairs do not count, consistently with every
  -- other count in this function. The player app's own check is broader (it
  -- refuses on ANY pair row) and still fires first; that difference is its
  -- product decision to keep or change, not something this fence should
  -- silently adopt.
  SELECT EXISTS (
    SELECT 1 FROM tournament_pairs pr
     WHERE pr.event_id = p_event_id
       AND (pr.player1_id = p_player_id OR pr.player2_id = p_player_id)
       AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
  ) INTO v_in_pair;
  IF v_in_pair THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_in_pair');
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

DO $verify$
DECLARE
  v_bad TEXT[] := ARRAY[]::TEXT[];
  v_oid oid;
  v_src TEXT;
BEGIN
  v_oid := to_regprocedure('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)');
  IF v_oid IS NULL THEN
    v_bad := array_append(v_bad, 'enter_tournament_event(uuid,uuid,integer,boolean,text,text) missing');
  ELSE
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'anon can execute');
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'authenticated can execute');
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'service_role CANNOT execute');
    END IF;

    -- The point of this migration is WHERE the reads happen, and a signature
    -- check cannot see that. These assert the body actually contains the five
    -- gates and the lock, so a later CREATE OR REPLACE that drops one of them
    -- fails here rather than silently reopening the race.
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
    IF v_src NOT LIKE '%tournament_event_field%' THEN
      v_bad := array_append(v_bad, 'the field advisory lock is not taken');
    END IF;
    IF v_src NOT LIKE '%tournament_suspended%'
       OR v_src NOT LIKE '%tournament_closed%'
       OR v_src NOT LIKE '%membership_not_allowed%'
       OR v_src NOT LIKE '%player_suspended%'
       OR v_src NOT LIKE '%already_in_pair%' THEN
      v_bad := array_append(v_bad, 'one of the five eligibility gates is missing from the body');
    END IF;
  END IF;

  -- 00193's ordering argument depends on this function owning the only
  -- FOR UPDATE on tournaments. If something else starts taking it, the total
  -- order asserted in the header stops being one.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname <> 'enter_tournament_event'
      AND p.prosrc ~* 'FROM\s+tournaments\s+\w*\s*WHERE[^;]*FOR\s+UPDATE'
  ) THEN
    v_bad := array_append(v_bad, 'another function now locks tournaments FOR UPDATE — recheck the lock order');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00196 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00196: entry eligibility is decided under the same locks the entry is.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
