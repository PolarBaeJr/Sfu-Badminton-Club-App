-- ===========================================================================
-- 00201 — ONE FENCE FOR THE EVENT FIELD
-- ===========================================================================
--
-- Round 9 ruled F-004 and F-005 NOT RESOLVED. The two sequences it gave are
-- real, but the census behind this migration found the cause is bigger than
-- either: THERE WERE TWO FENCES, and the writers were split across them.
--
--   fenced on the event ROW only ...... publish_event_draw
--                                       withdraw_from_tournament_event
--   fenced on the ADVISORY KEY only ... delete_phase_matches
--                                       pair_tournament_entrants
--                                       promote_pool_qualifier
--                                       swap_tournament_pair_member
--                                       unpair_tournament_pair
--   fenced on BOTH .................... enter_tournament_event
--                                       add_participants_under_field_lock
--   fenced on NEITHER ................. nine PostgREST writes in the two apps
--
-- Two groups that never take the same lock are not serialised, and neither
-- group is wrong on its own terms. That is why four review rounds of adding
-- checks to individual functions did not close this: the checks were correct
-- and the exclusion protocol they relied on did not exist.
--
-- A LOCK ONLY SOME WRITERS TAKE IS NOT A LOCK. Recorded in 00199 about one
-- function; it generalises to the whole field.
--
-- All eight advisory takers were verified to hash the IDENTICAL value —
-- (hashtext('tournament_event_field'), hashtext(<event id>::text)) — so the key
-- is a genuine shared fence and not eight coincidentally-similar ones. That is
-- what makes the fix small: the key becomes THE fence, and the two row-only
-- functions join it.
--
--
-- WHAT LOCKING THE EVENT ROW DOES NOT DO
-- --------------------------------------
-- Locking a PARENT row does not freeze its CHILD rows. publish_event_draw held
-- the tournament_events row while its entrant-left query, its match query and
-- its status update ran as three separate statements — and tournament_participants
-- / tournament_pairs statuses could still be rewritten between them by anything
-- that did not touch that row. Every app-side write is exactly that.
--
--
-- RE-ACQUISITION IS SAFE, AND THAT WAS MEASURED, NOT ASSUMED
-- ----------------------------------------------------------
-- Functions below take the key that their caller may already hold. Probed on
-- staging: the same key taken three times in one transaction succeeds, pg_locks
-- reports ONE advisory lock held, and it is released at commit. So adding the
-- key to a function that already locks the event row costs nothing and cannot
-- self-deadlock. (00198's header claimed the opposite about re-acquired locks.
-- That claim is false and 00199 already superseded it; this note is here so the
-- next reader does not rediscover it the hard way.)
--
--
-- LOCK ORDER
-- ----------
-- advisory -> tournaments -> players -> tournament_events, read off the real
-- body of merge_players and of add_participants_under_field_lock (00199), not
-- guessed. Every function below acquires a prefix of that order, so no new edge
-- is introduced. The known residual cycle against merge_players via
-- tournaments.created_by / players.banned_by is unchanged by this migration;
-- codex agreed it is an availability/retry concern, not an integrity one,
-- because PostgreSQL aborts one side and no bad row commits.
--
--
-- "IN THE FIELD" MEANS TWO DIFFERENT THINGS, DELIBERATELY
-- -------------------------------------------------------
-- The capacity counters (00199, and the new one below) exclude only
-- ('withdrawn','disqualified'), so a no_show still occupies a slot.
-- publish_event_draw's entrant_left check counts only ('registered','checked_in'),
-- so a no_show is gone. Those two disagree and the disagreement is CORRECT:
-- capacity asks "how many entries exist against this event's cap" — a no-show
-- entered, paid and holds one of their allowed entries — while entrant_left asks
-- "is this entrant still available to play the draw I just built", which a
-- no-show is not. Stated here because 00201 adds the first RPC that WRITES
-- no_show, so the divergence is now reachable by a new path and a later reader
-- will otherwise read one of the two counters as a bug.
--
--
-- WHAT THIS MIGRATION DOES NOT DO
-- -------------------------------
-- It drops NO function. Every change below is CREATE OR REPLACE with an
-- unchanged signature, and every new refusal is expressed in the idiom the
-- function already uses — RAISE ... USING ERRCODE where the return type is
-- uuid/void/uuid[], reason codes where it is jsonb. That is deliberate: 00200
-- dropped publish_event_draw's old signature, which made applying the migration
-- before deploying the code destructive. This one is safe in either order.
--
-- It also does not give promote_pool_qualifier a published-status refusal. That
-- function IS the promotion path and runs precisely while an event transitions
-- out of the pool; refusing on the new status would break the operation this
-- migration is supposed to protect. It already recounts its conflicts under the
-- key, which is the property that matters.
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- TIER A — the two row-only functions join the shared key
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.publish_event_draw(p_event_id uuid, p_new_status text, p_doubles boolean, p_entrants uuid[], p_whole_field boolean, p_phase text, p_generation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status     TEXT;
  v_generation UUID;
  v_now        INTEGER;
  v_expected   INTEGER;
  v_left       INTEGER;
  v_extra      INTEGER;
  v_matches    INTEGER;
  v_foreign    INTEGER;
BEGIN
  -- statusAfterDraw's four possible outcomes. An unconstrained status argument
  -- on a SECURITY DEFINER function reachable with the service key is a way to
  -- put an event into any state at all, including completed.
  IF p_new_status NOT IN ('bracket_generated', 'live', 'pool_generated', 'pool_live') THEN
    RAISE EXCEPTION 'publish_event_draw: % is not a draw-publication status', p_new_status;
  END IF;

  IF p_generation IS NULL THEN
    RAISE EXCEPTION 'publish_event_draw: p_generation may not be null';
  END IF;

  -- RAISED, NOT REFUSED. p_expected was nullable and null meant "do not check",
  -- which is exactly how the pool-seeded path came to assert nothing. There is
  -- no draw with no entrants, so an empty array is a caller fault and must not
  -- be able to degrade silently into an unchecked publication.
  IF p_entrants IS NULL OR array_length(p_entrants, 1) IS NULL THEN
    RAISE EXCEPTION 'publish_event_draw: p_entrants may not be null or empty';
  END IF;
  IF p_whole_field IS NULL THEN
    RAISE EXCEPTION 'publish_event_draw: p_whole_field may not be null';
  END IF;

  -- THE FIELD KEY, TAKEN FIRST. Added by 00201.
  --
  -- Until 00201 this function fenced on the event ROW alone. That is a real
  -- fence against anything else that locks the same row, but the other half of
  -- the field writers serialise on the advisory key instead and never touch
  -- this row -- so two whole groups of writers were mutually concurrent and
  -- neither was wrong on its own terms. Locking a PARENT row does not freeze
  -- its child rows: tournament_participants and tournament_pairs statuses could
  -- still move between this function's separate statements.
  --
  -- Order is advisory -> (tournaments) -> tournament_events, matching
  -- add_participants_under_field_lock (00199) and enter_tournament_event, so
  -- this introduces no new lock-order edge.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.draw_generation_id
    INTO v_status, v_generation
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- SOMEBODY ELSE REBUILT THIS DRAW while this one was being generated. Their
  -- rows are the ones in the table; publishing would put this generation's
  -- status on their bracket, and this generation's own late INSERTs were already
  -- refused by the trigger, so what is here is a mix of nothing and theirs.
  IF v_generation IS DISTINCT FROM p_generation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'superseded');
  END IF;

  v_expected := array_length(p_entrants, 1);

  -- ---- the drawn set, under the lock (00200) ---------------------------
  --
  -- assertFieldDidNotGrow made the same comparison earlier and cheaply; it is
  -- not redundant, it just is not the one that cannot be overtaken. This is.
  --
  -- WHO IS IN THE DRAW BUT NOT IN THE EVENT — checked first, and checked on
  -- BOTH paths including pool-seeded, because a fixture for somebody who has
  -- left is wrong whether or not the field was drawn from a pool.
  IF p_doubles THEN
    SELECT COUNT(*) INTO v_left
      FROM unnest(p_entrants) AS e(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM tournament_pairs pr
        WHERE pr.id = e.id AND pr.event_id = p_event_id
          AND pr.status::TEXT IN ('registered', 'checked_in'));
  ELSE
    SELECT COUNT(*) INTO v_left
      FROM unnest(p_entrants) AS e(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM tournament_participants tp
        WHERE tp.id = e.id AND tp.event_id = p_event_id
          AND tp.status::TEXT IN ('registered', 'checked_in'));
  END IF;

  IF v_left > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entrant_left', 'count', v_left);
  END IF;

  -- WHO IS IN THE EVENT BUT NOT IN THE DRAW. Only meaningful when the draw was
  -- supposed to be the whole field: a pool-seeded draw is a subset by
  -- construction and the members who did not qualify are still registered.
  IF p_whole_field THEN
    IF p_doubles THEN
      SELECT COUNT(*) INTO v_now FROM tournament_pairs
       WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in');
      SELECT COUNT(*) INTO v_extra FROM tournament_pairs
       WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in')
         AND NOT (id = ANY (p_entrants));
    ELSE
      SELECT COUNT(*) INTO v_now FROM tournament_participants
       WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in');
      SELECT COUNT(*) INTO v_extra FROM tournament_participants
       WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in')
         AND NOT (id = ANY (p_entrants));
    END IF;

    -- 'expected' and 'now' keep the shape the exec-facing sentence is built
    -- from. Nobody has left by this point — that branch returned above — so
    -- now - expected really is the number who arrived.
    IF v_extra > 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'field_grew',
                                'expected', v_expected, 'now', v_now);
    END IF;
  END IF;

  -- WHAT WAS ACTUALLY BUILT (00197). Publication used to assert nothing at all
  -- about the matches — only about the field they were built from.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE m.draw_generation_id IS DISTINCT FROM p_generation)
    INTO v_matches, v_foreign
    FROM tournament_matches m
   WHERE m.event_id = p_event_id
     AND (p_phase IS NULL OR m.phase = p_phase);

  -- A NULL STAMP COUNTS AS FOREIGN HERE, and deliberately does NOT match the
  -- judgement the 00197 trigger makes. During a rolling deploy "unstamped"
  -- means "written by the OLD generator", which is exactly the contamination
  -- this check exists to catch. See 00197's header for the full argument and
  -- for why a refusal here does not block the phase: pressing Generate again
  -- tears the phase down, unstamped rows included, and rebuilds it stamped.
  IF v_foreign > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'foreign_matches', 'count', v_foreign);
  END IF;

  -- No legitimate draw is empty: both generators refuse fewer than two
  -- entrants, so every real one has at least one match. An empty phase here
  -- means the inserts failed and the failure was swallowed.
  IF v_matches = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_matches');
  END IF;

  UPDATE tournament_events
     SET status = p_new_status, updated_at = NOW()
   WHERE id = p_event_id;

  RETURN jsonb_build_object('ok', TRUE, 'matches', v_matches);
END;
$function$;

CREATE OR REPLACE FUNCTION public.withdraw_from_tournament_event(p_event_id uuid, p_player_id uuid)
 RETURNS jsonb
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

  -- THE FIELD KEY, TAKEN FIRST. Added by 00201.
  --
  -- The old comment here read "the event row is the fence". It was the only
  -- fence this function took, and that is exactly the defect 00201 closes: the
  -- other half of the field writers serialise on the advisory key and never
  -- touch this row, so two whole groups of writers were mutually concurrent and
  -- neither was wrong on its own terms.
  --
  -- Order is advisory -> tournament_events, matching
  -- add_participants_under_field_lock (00199) and enter_tournament_event, so
  -- this introduces no new lock-order edge.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- The event row lock is KEPT, not replaced. publish_event_draw and the
  -- 00199/00200 entry paths take it too, and dropping it here would re-open the
  -- split from the other side. A draw published concurrently either commits
  -- before these locks are taken -- in which case the status read below sees it
  -- and refuses -- or waits behind them, in which case the withdrawal is already
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

-- ===========================================================================
-- TIER B — decide UNDER the lock, not before it
-- ===========================================================================
--
-- pair_tournament_entrants is the F-004 gap codex named, though not quite for
-- the reason it gave: the function DOES take the advisory key (00102). What it
-- did not do is decide anything under it. Event capacity and the per-member
-- entry cap were both computed in the application — participants.ts around the
-- capacity and cap checks — and never recounted here, so two desks could each
-- read the same last free slot and the key would faithfully serialise both
-- inserts. A decision made before acquiring the lock is not made under the lock.
--
-- It also read the event row WITHOUT a lock and never refused on event status,
-- so an admin pair could be added to an event whose draw had just been
-- published: the caller read 'checkin', paused, publication happened, and the
-- RPC inserted against a status it had no opinion about.
--
-- The three new refusals are RAISEd as check_violation (23514). That SQLSTATE
-- is already mapped by the caller to a pass-through ExpectedError, so the
-- messages reach the exec unchanged and NO APPLICATION CHANGE IS REQUIRED for
-- this function's refusals to be reported properly.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.pair_tournament_entrants(
  p_event_id uuid, p_player1_id uuid, p_player2_id uuid,
  p_pair_name text, p_combined_elo integer, p_added_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event       RECORD;
  v_tournament  uuid;
  v_t_status    text;
  v_suspended   timestamptz;
  v_suspend_why text;
  v_cap         integer;
  v_out_count   integer;
  v_pair_id     uuid;
  v_promoted    integer;
  v_pairs       integer;
  v_unpaired    integer;
  v_before      integer;
  v_after       integer;
  v_entries     integer;
  v_half        uuid;
BEGIN
  IF p_player1_id = p_player2_id THEN
    RAISE EXCEPTION 'A pair needs two different players.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The tournament id is needed to take the tournaments lock in the right
  -- order, and reading it costs nothing before any lock is held.
  SELECT e.tournament_id INTO v_tournament
    FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Everything below reads the event's field and then writes it. Serialise the
  -- whole operation on the event so two desks cannot both decide that neither
  -- player is spoken for. Released at commit, whether that is a COMMIT or a
  -- ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- THE TOURNAMENT ROW, LOCKED — because the per-member entry cap below is a
  -- cross-event count and the event key alone does not serialise two entries
  -- into two DIFFERENT events of the same tournament. Same order and same
  -- reason as add_participants_under_field_lock (00199).
  SELECT t.max_events_per_player, t.status::TEXT, t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), '')
    INTO v_cap, v_t_status, v_suspended, v_suspend_why
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  IF v_suspended IS NOT NULL THEN
    RAISE EXCEPTION 'This tournament is currently suspended%',
      COALESCE(': ' || v_suspend_why, '') USING ERRCODE = 'check_violation';
  END IF;
  IF v_t_status IN ('completed', 'archived') THEN
    RAISE EXCEPTION 'This tournament is closed.' USING ERRCODE = 'check_violation';
  END IF;

  -- FOR UPDATE added by 00201. The unlocked read was the other half of the
  -- "decided before the lock" defect: the status this function refuses on could
  -- move after it was read.
  SELECT id, event_type, status, draw_locked, max_participants
    INTO v_event
    FROM tournament_events
   WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- A pair only means anything in a doubles event. The application checks this
  -- too; it is repeated here because this function is the ONLY writer of a pair
  -- row and an invariant guarded in one place cannot be got wrong in another.
  -- All four, transcribed from isDoublesEvent() in packages/shared/src/utils/
  -- constants.ts. open_doubles is easy to miss and is a real event type.
  IF v_event.event_type NOT IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles') THEN
    RAISE EXCEPTION 'This is not a doubles event, so it has no pairs.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE EVENT STATUS, ASKED UNDER THE LOCK — 00201. The caller asks this too,
  -- hundreds of milliseconds earlier; this is the ask that the insert actually
  -- lands against. The two statuses are the admin path's, not the player
  -- path's one: an exec adds a walk-up during check-in, which is the whole
  -- reason that door exists.
  IF v_event.status NOT IN ('registration', 'checkin') THEN
    RAISE EXCEPTION 'The draw for this event has already been generated, so pairs can no longer be added. Regenerate the draw if this team should be in it.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Already on a team in this event. Not covered by the unique index (see the
  -- header of 00102), and the one that actually matters: A in two pairs is A in
  -- the draw twice, and two of everyone's entry-cap slots spent on one person.
  --
  -- Entries that have LEFT the event are ignored, exactly as the entry cap
  -- ignores them (ENTRY_CAP_RELEASING_STATUSES in packages/shared): somebody
  -- whose team withdrew is free to be entered again.
  IF EXISTS (
    SELECT 1 FROM tournament_pairs
     WHERE event_id = p_event_id
       AND status NOT IN ('withdrawn', 'disqualified')
       AND (player1_id IN (p_player1_id, p_player2_id)
         OR player2_id IN (p_player1_id, p_player2_id))
  ) THEN
    RAISE EXCEPTION 'One of these players is already in a pair in this event.'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- A pool entrant who has WITHDRAWN is not raw material for a team. Deleting
  -- their row to make the pair would erase the withdrawal and put them back in
  -- the event without anybody deciding to.
  SELECT count(*) INTO v_out_count
    FROM tournament_participants
   WHERE event_id = p_event_id
     AND player_id IN (p_player1_id, p_player2_id)
     AND status IN ('withdrawn', 'disqualified');
  IF v_out_count > 0 THEN
    RAISE EXCEPTION 'One of these players has already withdrawn from this event. Remove their withdrawn entry from the waiting list first, then add them again.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- HOW MANY OF THE TWO ARE ALREADY IN THE POOL. A promotion — pairing up two
  -- people who each entered alone — is slot-neutral and cap-neutral by
  -- construction: their loose rows were already worth one prospective team and
  -- already spent one entry each. Counted here, under the lock, rather than
  -- taken from the caller.
  SELECT count(*) INTO v_promoted
    FROM tournament_participants
   WHERE event_id = p_event_id
     AND player_id IN (p_player1_id, p_player2_id)
     AND status NOT IN ('withdrawn', 'disqualified');

  -- ---- CAPACITY, RECOUNTED UNDER THE LOCK — 00201 ----------------------
  -- Draw slots, not head count: two loose entrants are worth one prospective
  -- team. Expression transcribed from add_participants_under_field_lock (00199)
  -- so there is one definition of a doubles draw slot, not two.
  --
  -- The `v_after > v_before` conjunct is load-bearing and is 00199's: an
  -- operation that does not make an over-full event worse is not refused,
  -- which is what lets an exactly-full event still pair up.
  IF v_event.max_participants IS NOT NULL AND v_event.max_participants > 0 THEN
    SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
     WHERE event_id = p_event_id
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
    SELECT COUNT(*) INTO v_unpaired FROM tournament_participants
     WHERE event_id = p_event_id
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');

    v_before := v_pairs + CEIL(v_unpaired / 2.0);
    v_after  := (v_pairs + 1) + CEIL((v_unpaired - v_promoted) / 2.0);

    IF v_after > v_event.max_participants AND v_after > v_before THEN
      RAISE EXCEPTION 'Event is full.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ---- THE PER-MEMBER CAP, RECOUNTED UNDER BOTH LOCKS — 00201 ----------
  -- Both halves, because a pair row spends one of each player's allowance and
  -- there is no half-entry to fall back to. The promotion is discounted for the
  -- same reason as above: this pair CONSUMES the loose row rather than adding
  -- to it, so without the subtraction, pairing two people who each entered
  -- alone at a one-event-cap tournament would be refused for being at a limit
  -- the operation does not move.
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    FOREACH v_half IN ARRAY ARRAY[p_player1_id, p_player2_id] LOOP
      SELECT (
        (SELECT COUNT(*) FROM tournament_participants tp
           JOIN tournament_events te ON te.id = tp.event_id
          WHERE te.tournament_id = v_tournament AND tp.player_id = v_half
            AND COALESCE(tp.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
        +
        (SELECT COUNT(*) FROM tournament_pairs pr
           JOIN tournament_events te ON te.id = pr.event_id
          WHERE te.tournament_id = v_tournament
            AND (pr.player1_id = v_half OR pr.player2_id = v_half)
            AND COALESCE(pr.status::TEXT, '') NOT IN ('withdrawn', 'disqualified'))
      ) INTO v_entries;

      -- The loose row in THIS event is about to become the pair row, so it is
      -- not a second entry.
      IF EXISTS (
        SELECT 1 FROM tournament_participants
         WHERE event_id = p_event_id AND player_id = v_half
           AND status NOT IN ('withdrawn', 'disqualified')
      ) THEN
        v_entries := v_entries - 1;
      END IF;

      IF v_entries >= v_cap THEN
        RAISE EXCEPTION 'That player is already entered in % event(s) at this tournament, which is the limit.', v_cap
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;

  -- THE PROMOTION. Matches two rows when both were loose in the pool, one when
  -- only one was, none when an exec is adding a pair of people who had not
  -- entered separately. All three are ordinary.
  --
  -- Deliberately BEFORE the insert: the unique index on
  -- (event_id, player1_id, player2_id) can still refuse the insert, and if it
  -- does the whole statement — this delete included — rolls back.
  DELETE FROM tournament_participants
   WHERE event_id = p_event_id
     AND player_id IN (p_player1_id, p_player2_id);

  -- 'registered', never 'checked_in', even when both halves had been checked in
  -- individually. Check-in is the gate that refuses an entrant with no current
  -- event-waiver acceptance, and it is asked of the thing that takes the court.
  -- A pair that inherited two check-ins would have passed that gate as two
  -- individuals and never as a team — and if the waiver text moved in between,
  -- it would be a checked-in team nobody has a current signature for.
  INSERT INTO tournament_pairs (
    event_id, player1_id, player2_id, pair_name, combined_elo, added_by, status
  ) VALUES (
    p_event_id, p_player1_id, p_player2_id, p_pair_name, p_combined_elo, p_added_by, 'registered'
  )
  RETURNING id INTO v_pair_id;

  RETURN v_pair_id;
END;
$function$;
CREATE OR REPLACE FUNCTION public.swap_tournament_pair_member(p_pair_id uuid, p_outgoing_player_id uuid, p_incoming_player_id uuid, p_pair_name text, p_combined_elo integer, p_added_by uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pair    RECORD;
  v_event   RECORD;
  v_partner uuid;
  v_pooled  integer;
  v_out     integer;
BEGIN
  IF p_outgoing_player_id = p_incoming_player_id THEN
    RAISE EXCEPTION 'That player is already in this pair.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, event_id, player1_id, player2_id, status
    INTO v_pair
    FROM tournament_pairs
   WHERE id = p_pair_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pair not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Serialise on the event, exactly as pairing does and for the same reason:
  -- "is the incoming player already on a team" is a read, and a read needs
  -- something to stop two desks from both passing it.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_pair.event_id::text));

  IF p_outgoing_player_id NOT IN (v_pair.player1_id, v_pair.player2_id) THEN
    RAISE EXCEPTION 'That player is not in this pair.' USING ERRCODE = 'check_violation';
  END IF;

  v_partner := CASE WHEN v_pair.player1_id = p_outgoing_player_id
                    THEN v_pair.player2_id ELSE v_pair.player1_id END;
  IF p_incoming_player_id = v_partner THEN
    RAISE EXCEPTION 'A pair needs two different players.' USING ERRCODE = 'check_violation';
  END IF;

  IF v_pair.status IN ('withdrawn', 'disqualified') THEN
    RAISE EXCEPTION 'This pair has already left the event.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, draw_locked INTO v_event
    FROM tournament_events WHERE id = v_pair.event_id FOR UPDATE;  -- FOR UPDATE: 00201
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE EVENT STATUS, ASKED UNDER THE LOCK — 00201. The caller already refuses
  -- on exactly these two statuses before calling; this is the ask that the
  -- write actually lands against, which the caller's cannot be.
  --
  -- The in-any-match check below is NOT a substitute. It is the check that
  -- protects recorded results, and it only fires once match rows exist —
  -- leaving the window between a draw being published and its matches being
  -- written, which is precisely the window this migration exists to close.
  --
  -- AND A COUNT CANNOT SEE A SWAP: publish_event_draw's entrant_left check asks
  -- whether the pair ids it drew are still active, and a swap leaves the pair id
  -- alone. So the fence alone would serialise this against publication without
  -- publication noticing anything had changed. The status refusal is what
  -- actually closes it.
  IF v_event.status NOT IN ('registration', 'checkin') THEN
    RAISE EXCEPTION 'The draw for this event has already been generated, so its teams can no longer be changed. Regenerate the draw, or withdraw the pair.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE CHECK NO FOREIGN KEY WILL MAKE FOR US. See the header: this is an
  -- UPDATE, so nothing in the schema stops it rewriting a seeded team.
  IF EXISTS (
    SELECT 1 FROM tournament_matches
     WHERE pair_a_id = p_pair_id OR pair_b_id = p_pair_id
        OR winner_pair_id = p_pair_id OR loser_pair_id = p_pair_id
  ) THEN
    RAISE EXCEPTION 'This pair is already in the draw, so its players cannot be changed — their matches and ratings are recorded against the team as it stands. Regenerate the bracket, or withdraw the pair.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Already on another team in this event. Same rule pairing applies, and not
  -- expressible as an index: UNIQUE(event_id, player1_id, player2_id) is on the
  -- ordered triple.
  IF EXISTS (
    SELECT 1 FROM tournament_pairs
     WHERE event_id = v_pair.event_id
       AND id <> p_pair_id
       AND status NOT IN ('withdrawn', 'disqualified')
       AND (player1_id = p_incoming_player_id OR player2_id = p_incoming_player_id)
  ) THEN
    RAISE EXCEPTION 'That player is already in another pair in this event.'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- THE INCOMING PLAYER'S POOL ROW. Required, and its absence is the refusal
  -- that keeps this function out of the entry business — see the header. The
  -- message names the step that makes it work.
  SELECT count(*) INTO v_pooled
    FROM tournament_participants
   WHERE event_id = v_pair.event_id
     AND player_id = p_incoming_player_id
     AND status NOT IN ('withdrawn', 'disqualified');
  IF v_pooled = 0 THEN
    SELECT count(*) INTO v_out
      FROM tournament_participants
     WHERE event_id = v_pair.event_id
       AND player_id = p_incoming_player_id;
    IF v_out > 0 THEN
      RAISE EXCEPTION 'That player has already left this event. Remove their withdrawn entry from the waiting list, add them again, then swap them in.'
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'That player has not entered this event. Add them to the waiting list first, then swap them in — that is what charges them and asks for the event waiver.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- From here on, the two writes that have to happen together ----

  -- 1. The incoming player leaves the pool.
  DELETE FROM tournament_participants
   WHERE event_id = v_pair.event_id
     AND player_id = p_incoming_player_id;

  -- 2. The team changes hands. pair_name and combined_elo are RECOMPUTED by the
  --    caller and passed in — a swap that kept the old combined_elo would seed
  --    the draw off a player who is no longer in the team, and one that kept the
  --    old pair_name would put the wrong person's name on the bracket. Both are
  --    calculateTeamRating's and the caller's job for the reason 00070 gives.
  --
  --    The column written is chosen from which half is leaving, so the pair
  --    keeps its id, its seed_number and its created_at, and only its
  --    membership moves. seed_number is the identity that actually earns
  --    preservation: the exec seeded this team's position and swapping a player
  --    is not a reason to renumber the draw.
  --
  --    THE CHECK-IN IS RESET, and that is not incidental. 00102 creates a pair
  --    as 'registered' even when both halves had been checked in individually,
  --    because check-in is the gate that refuses an entrant with no current
  --    event-waiver acceptance and it is asked of the thing that takes the
  --    court. A swap on a CHECKED-IN pair carries that same hazard in its worst
  --    form: the team was screened with Priya in it, and keeping the status
  --    would leave Sam checked in — recorded as present at a desk he never
  --    visited, past a gate he never passed. The desk checks the new team in.
  UPDATE tournament_pairs
     SET player1_id = CASE WHEN player1_id = p_outgoing_player_id
                           THEN p_incoming_player_id ELSE player1_id END,
         player2_id = CASE WHEN player2_id = p_outgoing_player_id
                           THEN p_incoming_player_id ELSE player2_id END,
         pair_name = p_pair_name,
         combined_elo = p_combined_elo,
         status = 'registered',
         checked_in_at = NULL,
         checked_in_by = NULL
   WHERE id = p_pair_id;

  -- 3. The outgoing player goes back to the pool — NOT out of the event. They
  --    entered, they paid, they signed and they hold one of their allowed
  --    entries; losing all three because somebody else took their place would
  --    punish them for an exec's decision. Same reasoning, and the same landing
  --    place, as the half-withdrawal in 00102. An exec who also wants them out
  --    withdraws them from the waiting list, visibly, as a second decision.
  INSERT INTO tournament_participants (event_id, player_id, status, elo_before, added_by)
  VALUES (
    v_pair.event_id,
    p_outgoing_player_id,
    'registered',
    COALESCE((SELECT r.doubles_elo FROM ratings r WHERE r.player_id = p_outgoing_player_id), 400),
    p_added_by
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.unpair_tournament_pair(p_pair_id uuid, p_withdrawn_player_id uuid, p_reason text, p_added_by uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pair   RECORD;
  v_event  RECORD;
  v_ids    uuid[];
BEGIN
  SELECT id, event_id, player1_id, player2_id, status
    INTO v_pair
    FROM tournament_pairs
   WHERE id = p_pair_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pair not found.' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_pair.event_id::text));

  IF p_withdrawn_player_id IS NOT NULL
     AND p_withdrawn_player_id NOT IN (v_pair.player1_id, v_pair.player2_id) THEN
    RAISE EXCEPTION 'That player is not in this pair.' USING ERRCODE = 'check_violation';
  END IF;

  -- A pair that has already left the event is not raw material for a pool
  -- entry: putting both halves back as 'registered' would quietly reverse a
  -- withdrawal that an exec, or a forfeit cascade, decided on.
  IF v_pair.status IN ('withdrawn', 'disqualified') THEN
    RAISE EXCEPTION 'This pair has already left the event.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, draw_locked INTO v_event
    FROM tournament_events WHERE id = v_pair.event_id FOR UPDATE;  -- FOR UPDATE: 00201
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE EVENT STATUS, ASKED UNDER THE LOCK — 00201. The caller already refuses
  -- on exactly these two statuses before calling; this is the ask that the
  -- write actually lands against, which the caller's cannot be.
  --
  -- The in-any-match check below is NOT a substitute. It is the check that
  -- protects recorded results, and it only fires once match rows exist —
  -- leaving the window between a draw being published and its matches being
  -- written, which is precisely the window this migration exists to close.
  --
  -- AND A COUNT CANNOT SEE A SWAP: publish_event_draw's entrant_left check asks
  -- whether the pair ids it drew are still active, and an unpair leaves the pair id
  -- alone. So the fence alone would serialise this against publication without
  -- publication noticing anything had changed. The status refusal is what
  -- actually closes it.
  IF v_event.status NOT IN ('registration', 'checkin') THEN
    RAISE EXCEPTION 'The draw for this event has already been generated, so its teams can no longer be changed. Regenerate the draw, or withdraw the pair.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The draw, checked as "is this pair in a match" rather than as an event
  -- status, because that is the thing the foreign keys actually protect.
  IF EXISTS (
    SELECT 1 FROM tournament_matches
     WHERE pair_a_id = p_pair_id OR pair_b_id = p_pair_id
        OR winner_pair_id = p_pair_id OR loser_pair_id = p_pair_id
  ) THEN
    RAISE EXCEPTION 'This pair is already in the draw, so it cannot be split up. Withdraw the pair instead, or regenerate the bracket.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  DELETE FROM tournament_pairs WHERE id = p_pair_id;

  -- One statement for both halves. The status expression is what makes this
  -- function serve the withdrawal case as well as the plain unpair.
  --
  -- `notes` IS NO LONGER IN THIS COLUMN LIST — 00125. The withdrawal reason
  -- used to be written here, into a column of a table published by 00113, which
  -- put the exec's sentence on the wire to every bracket subscriber. It goes
  -- into tournament_participant_notes below instead.
  INSERT INTO tournament_participants (event_id, player_id, status, elo_before, added_by)
  SELECT
    v_pair.event_id,
    h.player_id,
    CASE WHEN h.player_id = p_withdrawn_player_id THEN 'withdrawn' ELSE 'registered' END,
    COALESCE((SELECT r.doubles_elo FROM ratings r WHERE r.player_id = h.player_id), 400),
    p_added_by
  FROM unnest(ARRAY[v_pair.player1_id, v_pair.player2_id]) AS h(player_id);

  -- Read back rather than RETURNING ... INTO, which keeps only the last row of
  -- a multi-row insert.
  SELECT array_agg(id) INTO v_ids
    FROM tournament_participants
   WHERE event_id = v_pair.event_id
     AND player_id IN (v_pair.player1_id, v_pair.player2_id);

  -- THE REASON, SOMEWHERE ONLY THE CONSOLE CAN READ IT — 00125.
  -- tournament_participant_notes holds no grant for anon or authenticated, has
  -- RLS on with no policy, and is not published; this function is SECURITY
  -- DEFINER and runs as the owner, so it can write there and nobody it writes
  -- about can read it back. Atomic with the withdrawal, which is better than
  -- the app-side note writes elsewhere: there is no state in which the entry is
  -- withdrawn and the reason went missing.
  --
  -- Only when there IS a reason: unpairEntry passes NULL and `note` is NOT NULL.
  IF p_withdrawn_player_id IS NOT NULL
     AND p_reason IS NOT NULL
     AND btrim(p_reason) <> '' THEN
    INSERT INTO tournament_participant_notes (participant_id, note, author_id)
    SELECT tp.id, p_reason, p_added_by
      FROM tournament_participants tp
     WHERE tp.event_id  = v_pair.event_id
       AND tp.player_id = p_withdrawn_player_id
    ON CONFLICT (participant_id) DO UPDATE
      SET note      = EXCLUDED.note,
          author_id = EXCLUDED.author_id;
  END IF;

  RETURN v_ids;
END;
$function$;

-- ===========================================================================
-- TIER C — the nine writes that took no fence at all
-- ===========================================================================
--
-- Every function above fences. None of that helped, because the field was also
-- written directly over PostgREST from both apps, and those writes take no lock
-- of any kind:
--
--   apps/admin  participants.ts  removeParticipantFromEvent   DELETE
--   apps/admin  participants.ts  checkInParticipant           UPDATE
--   apps/admin  participants.ts  markParticipantNoShow        UPDATE
--   apps/admin  participants.ts  exitDrawImpl                 UPDATE
--   apps/admin  participants.ts  removePairFromEvent          DELETE
--   apps/admin  participants.ts  checkInPair                  UPDATE
--   apps/admin  participants.ts  markPairNoShow               UPDATE
--   apps/admin  participants.ts  bulkCheckIn                  UPDATE
--   apps/player tournament-actions.ts  self check-in          UPDATE
--
-- exitDrawImpl is the one in codex's round-9 sequence, and it is worth saying
-- why it survived four rounds of review: IT WRITES THROUGH A VARIABLE.
--   const table = isPair ? 'tournament_pairs' : 'tournament_participants';
--   await adminClient.from(table).update({ status })
-- Every literal-name grep for the two field tables misses it. The census that
-- found it enumerated pg_proc and the app's .from() calls including the
-- variable form; the guard test added alongside this migration does the same.
--
--
-- THE CASCADE, AND WHY IT DOES NOT MOVE INTO THE FENCE
-- ---------------------------------------------------
-- exitDrawImpl writes the status and then, only if the event is live, forfeits
-- the entry's open matches — which writes Elo across many matches. Moving that
-- cascade inside the fence would hold the field lock for its whole duration,
-- and holding a field-wide lock across a rating cascade is a worse problem than
-- the one being fixed.
--
-- The defect was never the cascade's position. It was that the caller decided
-- whether to run it from a status it had read BEFORE the write, which
-- publication could have moved in between — codex's step 5, where a stale
-- 'checkin' snapshot suppressed a cascade that a fresh read would have run.
--
-- So set_field_entry_status RETURNS THE EVENT STATUS IT READ UNDER THE LOCK,
-- and the caller branches on that instead of on its own stale snapshot. The
-- decision is then made from state that could not have moved between the read
-- and the write, which is the property that was missing.
--
--
-- THE STATUS GUARDS BELOW ARE DELIBERATELY NARROW
-- -----------------------------------------------
-- markParticipantNoShow and markPairNoShow had NO event-status guard at all,
-- and neither check-in path had one either. The owner asked for that fixed
-- regardless of the locking work, so it is fixed here — but narrowly, and the
-- narrowness is a decision rather than an oversight.
--
-- THE FENCE IS WHAT CLOSES THE RACES. These guards are defence in depth, and a
-- guard invented from a guess about how the club runs its desk would break a
-- real workflow to protect against nothing. So each refuses only the cases that
-- are meaningless or self-contradictory on their own terms:
--
--   check-in   refused at 'registration' (check-in has not opened, so nobody
--              can be checked in) and at 'completed' (the results are settled).
--              ALLOWED once a draw exists: a late arrival at the desk after the
--              bracket is up is an ordinary evening at a badminton club, and
--              refusing it would be this migration inventing a rule.
--   no_show    refused at the same two, for the same two reasons.
--   withdraw/  refused at 'completed' only, which is the guard exitDrawImpl
--   disqualify already had, now applied under the lock instead of before it.
--
-- Removal keeps the caller's existing ('registration','checkin') rule, which is
-- an established product decision (see removeParticipantFromEvent's comment on
-- why check-in counts as open), not a new one.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.set_field_entry_status(
  p_entry_id uuid, p_is_pair boolean, p_new_status text, p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
  v_before     text;
  v_already    boolean;
BEGIN
  -- RAISED, NOT REFUSED — the same distinction publish_event_draw draws. A
  -- status outside this set is a programming error in the caller, not a state
  -- the desk can reach, and returning a reason code for it would let a typo
  -- read as an ordinary refusal.
  IF p_new_status NOT IN ('checked_in', 'no_show', 'withdrawn', 'disqualified') THEN
    RAISE EXCEPTION 'set_field_entry_status: % is not a settable entry status', p_new_status;
  END IF;
  IF p_entry_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'set_field_entry_status: p_entry_id and p_is_pair may not be null';
  END IF;

  -- Unfenced, and only to learn which event to fence ON. Nothing is decided
  -- from this read; every value it produces is re-read below under the lock.
  IF p_is_pair THEN
    SELECT event_id INTO v_event FROM tournament_pairs WHERE id = p_entry_id;
  ELSE
    SELECT event_id INTO v_event FROM tournament_participants WHERE id = p_entry_id;
  END IF;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked
    INTO v_status, v_tournament, v_locked
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- THE ENTRY, RE-READ UNDER THE LOCK. The row could have moved between the
  -- read above and this point; this is the value the write lands against.
  IF p_is_pair THEN
    SELECT status::TEXT INTO v_before FROM tournament_pairs
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  ELSE
    SELECT status::TEXT INTO v_before FROM tournament_participants
     WHERE id = p_entry_id AND event_id = v_event FOR UPDATE;
  END IF;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  -- ---- the narrow status guards, per target status ----------------------
  IF p_new_status IN ('checked_in', 'no_show') THEN
    IF v_status = 'registration' THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                                'event_status', v_status);
    END IF;
  END IF;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed',
                              'event_status', v_status);
  END IF;

  -- Check-in is the only one of the four that moves a row FORWARD into play, so
  -- it is the only one that cares what the row was: checking in somebody who
  -- has withdrawn would put them back in the field without anybody deciding to.
  IF p_new_status = 'checked_in' AND v_before NOT IN ('registered', 'checked_in') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_status',
                              'entry_status', v_before, 'event_status', v_status);
  END IF;

  v_already := (v_before = p_new_status);

  -- A REPEAT PRESS WRITES NOTHING BUT IS NOT AN ERROR HERE. exitDrawImpl needs
  -- to distinguish "already withdrawn, nothing to do" from "already withdrawn,
  -- but the forfeit cascade stopped partway and this retry is what finishes
  -- it" — and only the caller knows which, because only it runs the cascade.
  -- So the fact is reported and the judgement is left where it was.
  IF NOT v_already THEN
    IF p_is_pair THEN
      UPDATE tournament_pairs
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW() ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor ELSE checked_in_by END
       WHERE id = p_entry_id;
    ELSE
      UPDATE tournament_participants
         SET status        = p_new_status,
             checked_in_at = CASE WHEN p_new_status = 'checked_in' THEN NOW() ELSE checked_in_at END,
             checked_in_by = CASE WHEN p_new_status = 'checked_in' THEN p_actor ELSE checked_in_by END
       WHERE id = p_entry_id;
    END IF;
  END IF;

  -- event_status IS THE POINT OF THIS RETURN VALUE. The caller branches its
  -- forfeit cascade on it, and it is the status read under the lock this write
  -- happened under — so it cannot have moved between the decision and the write
  -- the way the caller's own earlier read could.
  RETURN jsonb_build_object(
    'ok', TRUE,
    'already', v_already,
    'entry_status_before', v_before,
    'event_status', v_status,
    'event_id', v_event,
    'tournament_id', v_tournament,
    'draw_locked', COALESCE(v_locked, FALSE)
  );
END;
$function$;


CREATE OR REPLACE FUNCTION public.remove_field_entry(
  p_entry_id uuid, p_is_pair boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
BEGIN
  IF p_entry_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'remove_field_entry: p_entry_id and p_is_pair may not be null';
  END IF;

  IF p_is_pair THEN
    SELECT event_id INTO v_event FROM tournament_pairs WHERE id = p_entry_id;
  ELSE
    SELECT event_id INTO v_event FROM tournament_participants WHERE id = p_entry_id;
  END IF;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked
    INTO v_status, v_tournament, v_locked
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;

  -- The caller's existing rule, moved under the lock rather than rewritten.
  -- Check-in counts as open deliberately — see removeParticipantFromEvent.
  IF v_status NOT IN ('registration', 'checkin') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;
  IF COALESCE(v_locked, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_locked');
  END IF;

  IF p_is_pair THEN
    DELETE FROM tournament_pairs WHERE id = p_entry_id AND event_id = v_event;
  ELSE
    DELETE FROM tournament_participants WHERE id = p_entry_id AND event_id = v_event;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'event_id', v_event,
                            'tournament_id', v_tournament, 'event_status', v_status);
END;
$function$;


CREATE OR REPLACE FUNCTION public.bulk_check_in_field(
  p_event_id uuid, p_is_pair boolean, p_ids uuid[], p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_status     text;
  v_ids        uuid[];
BEGIN
  IF p_event_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'bulk_check_in_field: p_event_id and p_is_pair may not be null';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.tournament_id
    INTO v_status, v_tournament
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status = 'registration' OR v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  -- status = 'registered' IS LOAD-BEARING AND IS THE CALLER'S OWN PREDICATE.
  -- The waiver screening that produces p_ids runs in the application, outside
  -- this fence, over a list read before it — so this predicate is the only
  -- thing standing between "check in everyone still waiting" and "overwrite
  -- whatever these rows now say", withdrawals included. It is repeated here
  -- rather than trusted from the id list for exactly that reason.
  --
  -- p_ids NULL means the whole waiting field: the caller passes a list only
  -- when a waiver applies and some entrants were screened out.
  IF p_is_pair THEN
    WITH done AS (
      UPDATE tournament_pairs
         SET status = 'checked_in', checked_in_at = NOW(), checked_in_by = p_actor
       WHERE event_id = p_event_id
         AND status = 'registered'
         AND (p_ids IS NULL OR id = ANY(p_ids))
      RETURNING id
    )
    SELECT array_agg(id) INTO v_ids FROM done;
  ELSE
    WITH done AS (
      UPDATE tournament_participants
         SET status = 'checked_in', checked_in_at = NOW(), checked_in_by = p_actor
       WHERE event_id = p_event_id
         AND status = 'registered'
         AND (p_ids IS NULL OR id = ANY(p_ids))
      RETURNING id
    )
    SELECT array_agg(id) INTO v_ids FROM done;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'checked_in', COALESCE(array_length(v_ids, 1), 0),
    'ids', COALESCE(to_jsonb(v_ids), '[]'::jsonb),
    'event_status', v_status,
    'tournament_id', v_tournament
  );
END;
$function$;


-- ---------------------------------------------------------------------------
-- The double no-show, which marks TWO entries and must keep doing so atomically
-- ---------------------------------------------------------------------------
-- Found by the repo-wide census, not by the per-file review that produced the
-- rest of Tier C: results.ts marks both sides of a double-no-show match absent
-- in ONE statement, `.in('id', [aId, bId])`. Calling the single-entry RPC twice
-- would be two transactions, so a failure between them would leave one side
-- marked and the other not — and check_noshow_threshold auto-flags at 3 and
-- auto-suspends at 5, so a half-applied pair is not a cosmetic difference.
--
-- Both ids must belong to the same event, which is what makes one key enough.
-- That is asserted rather than assumed: they come from the two sides of one
-- match, so a mismatch means the match row disagrees with the entries and this
-- should refuse rather than fence on an arbitrary one of the two.
--
-- No 'live' refusal here, deliberately: a double no-show is recorded ON a live
-- event. That is the case the narrow guard in set_field_entry_status was
-- written to keep working.
CREATE OR REPLACE FUNCTION public.mark_field_entries_no_show(
  p_entry_ids uuid[], p_is_pair boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_events     uuid[];
  v_event      uuid;
  v_tournament uuid;
  v_status     text;
  v_marked     integer;
BEGIN
  IF p_entry_ids IS NULL OR array_length(p_entry_ids, 1) IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'mark_field_entries_no_show: p_entry_ids may not be null or empty';
  END IF;

  IF p_is_pair THEN
    SELECT array_agg(DISTINCT event_id) INTO v_events
      FROM tournament_pairs WHERE id = ANY(p_entry_ids);
  ELSE
    SELECT array_agg(DISTINCT event_id) INTO v_events
      FROM tournament_participants WHERE id = ANY(p_entry_ids);
  END IF;

  IF v_events IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;
  IF array_length(v_events, 1) <> 1 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entries_span_events',
                              'events', array_length(v_events, 1));
  END IF;
  v_event := v_events[1];

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT e.status::TEXT, e.tournament_id
    INTO v_status, v_tournament
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status IN ('registration', 'completed') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  IF p_is_pair THEN
    WITH done AS (
      UPDATE tournament_pairs SET status = 'no_show'
       WHERE id = ANY(p_entry_ids) AND event_id = v_event
      RETURNING id
    ) SELECT count(*) INTO v_marked FROM done;
  ELSE
    WITH done AS (
      UPDATE tournament_participants SET status = 'no_show'
       WHERE id = ANY(p_entry_ids) AND event_id = v_event
      RETURNING id
    ) SELECT count(*) INTO v_marked FROM done;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'marked', v_marked,
                            'event_id', v_event, 'tournament_id', v_tournament,
                            'event_status', v_status);
END;
$function$;

-- ===========================================================================
-- GRANTS — the four new functions are service_role only
-- ===========================================================================
-- All four are SECURITY DEFINER and take an actor id as an argument rather
-- than deriving one, so any role that could execute them could act as anybody.
-- The apps call them from server actions behind requireCapability(), which is
-- a service_role client. anon and authenticated get nothing.
REVOKE ALL ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_field_entry(uuid, boolean)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bulk_check_in_field(uuid, boolean, uuid[], uuid)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_field_entry_status(uuid, boolean, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_field_entry(uuid, boolean)                 TO service_role;
GRANT EXECUTE ON FUNCTION public.bulk_check_in_field(uuid, boolean, uuid[], uuid)  TO service_role;
REVOKE ALL ON FUNCTION public.mark_field_entries_no_show(uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_field_entries_no_show(uuid[], boolean) TO service_role;

-- The five REPLACED functions get their grants restated too.
--
-- CREATE OR REPLACE PRESERVES EXISTING GRANTS, so none of these five needed a
-- grant statement to keep working, and every one of them was verified to be
-- service_role-only before this migration was written — these lines change
-- nothing today. They are here because "it changes nothing today" is exactly
-- how grant drift starts: the day one of these is replaced by a migration that
-- creates it fresh instead, Supabase's default EXECUTE-to-PUBLIC applies and
-- nothing in the file says otherwise. Stating the intent in the same file that
-- rewrites the body is what makes that impossible to get wrong silently.
--
-- REVOKE ... FROM PUBLIC alone does NOT remove Supabase's default anon grant;
-- anon and authenticated have to be named. See 00126 and 00187.
REVOKE ALL ON FUNCTION public.publish_event_draw(uuid, text, boolean, uuid[], boolean, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.withdraw_from_tournament_event(uuid, uuid)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid)                        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_event_draw(uuid, text, boolean, uuid[], boolean, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_from_tournament_event(uuid, uuid)                            TO service_role;
GRANT EXECUTE ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid)       TO service_role;
GRANT EXECUTE ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid)    TO service_role;
GRANT EXECUTE ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid)                        TO service_role;

-- ===========================================================================
-- VERIFICATION — A CENSUS, NOT A FRAGMENT GREP
-- ===========================================================================
--
-- Round 9 pre-rejected the obvious shape of this block, and the sentence is
-- worth quoting because it is the standard the block below has to meet:
--
--   "The verification block proves that particular source fragments exist; it
--    cannot prove that concurrent field writers participate in the same
--    exclusion protocol."
--
-- That is exactly right, and it is why this does NOT check that the five
-- functions 00201 touched contain the key. Checking the things you just wrote
-- proves you wrote them. Instead it enumerates EVERY function in the schema
-- that writes the field tables, subtracts a named allowlist, and asserts that
-- nothing is left over without the key. The claim it establishes is the one
-- codex asked for — no unfenced writer exists — and unlike a fragment grep it
-- keeps holding for functions nobody has written yet.
--
-- THE ALLOWLIST IS VERIFIED, NOT ASSERTED. Each entry was checked against its
-- live body for what it actually writes:
--
--   apply_tournament_match_rating       elo_after, elo_change
--   reverse_tournament_match_rating     elo_after, elo_change
--   credit_participant_placement_bonus  elo_after, elo_change
--     -> rating columns of a row whose membership and status they never touch.
--        The field is not what they write, so the field key is not their fence;
--        theirs is the match row.
--
--   merge_players                       added_by, checked_in_by, player_id
--     -> identity re-pointing when two accounts turn out to be one person. It
--        does not add, remove, or change the status of an entry. It fences on
--        tournaments and players, and it is the documented counterparty of this
--        migration's lock order — giving it the field key would create the
--        cycle the header says 00201 does not introduce.
--
-- The block below re-checks that claim rather than trusting this comment: an
-- allowlisted function that starts writing a status column fails the migration.
--
-- KNOWN FALSE NEGATIVE, stated so it is not mistaken for coverage: a body that
-- writes through dynamic SQL — EXECUTE format('UPDATE %I', ...) — is invisible
-- to a prosrc scan. No function does that today; the census cannot promise none
-- ever will. The application side has the same shape of hole (exitDrawImpl
-- wrote through a variable table name for four review rounds) and is covered by
-- a source guard in packages/shared, which is where that check can run because
-- there is no database there.
-- ===========================================================================
DO $verify$
DECLARE
  r      RECORD;
  v_bad  text[] := ARRAY[]::text[];
  v_seen integer := 0;

  -- Writes a field table by any of the three verbs. The trailing class stops
  -- tournament_participant_notes matching tournament_participants.
  c_writes  CONSTANT text :=
    '(INSERT[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM)[[:space:]]+(public\.)?tournament_(participants|pairs)([^_a-zA-Z]|$)';
  -- MENTIONS a status column at all -- deliberately broader than "assigns to
  -- one". An earlier draft of this block matched only `status =`, which is the
  -- UPDATE ... SET form; it could not see a status written through an INSERT
  -- column list, which is how pair_tournament_entrants writes one. Mutation
  -- testing caught that: the allowlist branch passed when it should have
  -- failed. All four allowlisted bodies were checked and none mentions status
  -- at any point, so the stricter rule costs nothing and closes the form the
  -- narrower one missed.
  c_status  CONSTANT text := '(^|[^_a-zA-Z])status([^_a-zA-Z]|$)';

  c_allow   CONSTANT text[] := ARRAY[
    'apply_tournament_match_rating',
    'reverse_tournament_match_rating',
    'credit_participant_placement_bonus',
    'merge_players'
  ];
BEGIN
  FOR r IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           p.prosrc
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prokind = 'f'
       AND p.prosrc ~* c_writes
  LOOP
    v_seen := v_seen + 1;

    IF r.proname = ANY(c_allow) THEN
      -- The allowlist is a claim about what these functions write. If one of
      -- them starts writing a status, the claim is stale and the exemption is
      -- no longer earned — so this fails rather than silently widening.
      IF r.prosrc ~* c_status THEN
        v_bad := array_append(v_bad,
          r.proname || '(' || r.args || '): allowlisted as a non-status writer, but its body now mentions a status column. Re-check it: either it needs the field key, or the allowlist comment needs correcting.');
      END IF;
      CONTINUE;
    END IF;

    IF r.prosrc NOT LIKE '%tournament_event_field%' THEN
      v_bad := array_append(v_bad,
        r.proname || '(' || r.args || '): writes the event field but never takes pg_advisory_xact_lock(hashtext(''tournament_event_field''), ...). Every field writer must take the same key — see the header of 00201.');
    END IF;
  END LOOP;

  -- A census that matched nothing would pass vacuously and prove the opposite
  -- of what it claims. The floor is the eight fenced writers 00201 leaves
  -- behind plus the four allowlisted ones.
  IF v_seen < 13 THEN
    v_bad := array_append(v_bad,
      'the census matched only ' || v_seen || ' field writers, which is fewer than the 13 known to exist. The pattern has stopped matching and this block is no longer checking anything.');
  END IF;

  -- The two functions Tier A joined to the key: named here NOT as the proof —
  -- the census above is the proof — but because a silent no-op replacement of
  -- either is the specific regression that would put this migration back to
  -- where 00200 was.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = 'publish_event_draw') NOT LIKE '%tournament_event_field%' THEN
    v_bad := array_append(v_bad, 'publish_event_draw did not take the field key after 00201');
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = 'withdraw_from_tournament_event') NOT LIKE '%tournament_event_field%' THEN
    v_bad := array_append(v_bad, 'withdraw_from_tournament_event did not take the field key after 00201');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00201 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;

  RAISE NOTICE '00201: % field writers censused, all fenced or allowlisted.', v_seen;
END;
$verify$;

-- Four new functions are exposed through PostgREST. Without this the API keeps
-- serving its cached schema and every call 404s until it happens to refresh.
NOTIFY pgrst, 'reload schema';

COMMIT;
