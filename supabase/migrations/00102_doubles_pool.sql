-- ============================================================
-- 00102 — a doubles event is a POOL: some entrants arrive paired, some alone
--
-- "there can be doubles people joining the event as a group, and as a single
-- person — if they are paired then they keep their pair, if they are not
-- assigned then they get assigned" — the club owner.
--
-- The shape chosen for that, and the one this migration serves:
--
--     tournament_participants  = a PERSON in the event's pool
--     tournament_pairs         = a TEAM that has been formed
--
-- and pairing PROMOTES two pool rows into one pair row. Each table keeps
-- exactly one meaning, so nothing that already reads pairs has to learn a new
-- case. In particular player2_id stays NOT NULL: "a pair always has two
-- players" is load-bearing in seeding (combined_elo), in the bracket (two
-- names), at check-in (two people) and in the event-waiver screen (both
-- halves), and a half-empty pair would break all four silently at draw time.
--
-- ------------------------------------------------------------
-- WHY THIS IS SQL AND NOT TYPESCRIPT
-- ------------------------------------------------------------
-- Promotion is two writes that must both happen or neither:
--
--     DELETE the two tournament_participants rows
--     INSERT one tournament_pairs row
--
-- PostgREST has no transactions, so from the application those are two round
-- trips. Crash between them and the club gets one of exactly two corruptions:
--
--   * pair written, participants left behind — both halves are now counted
--     TWICE by countEventEntriesPerPlayer (packages/shared, the per-member
--     entry cap), and they appear both in the draw and in the pool; or
--   * participants deleted, pair not written — two members have silently lost
--     an entry they paid for.
--
-- A plpgsql function runs in ONE transaction, so neither is reachable. This is
-- the same reasoning 00070 gives for apply_tournament_match_rating, and the
-- same division of labour: arithmetic that reads platform settings or shared
-- constants (combined_elo, via calculateTeamRating) stays in TypeScript and is
-- passed IN; only the writes that have to be atomic live here.
--
-- ------------------------------------------------------------
-- WHY IT IS KEYED ON PLAYER IDS, NOT ON PARTICIPANT ROW IDS
-- ------------------------------------------------------------
-- The double-count hole is not the promotion path — it is addPairToEvent being
-- called on two people who happen to ALREADY be loose in the pool. Keyed on
-- player ids, one function serves both: "form a pair from these two people, and
-- take them out of the pool if they are in it". The delete simply matches two
-- rows, or one, or none. There is then no way to create a pair that leaves a
-- pool row behind, on any path, ever.
--
-- ------------------------------------------------------------
-- WHY THE ADVISORY LOCK
-- ------------------------------------------------------------
-- UNIQUE(event_id, player1_id, player2_id) is on the ORDERED TRIPLE. It stops
-- (A,B) twice; it does not stop (B,A), and it does not stop A being in two
-- different pairs. "This player is already in a pair here" therefore has to be
-- a read, and a read needs something to stop two concurrent pairings from both
-- passing it. Serialising on the EVENT is the smallest thing that works — two
-- desks pairing people in different events never wait on each other, and the
-- lock is released at commit whatever happens.
--
-- Re-runnable: CREATE OR REPLACE plus idempotent GRANT/REVOKE and COMMENT.
-- NO TABLE IS ALTERED. Nothing about existing rows changes, and a doubles
-- event with no pool entrants behaves exactly as it does today.
-- ============================================================


-- ------------------------------------------------------------
-- pair_tournament_entrants — form a team, atomically
-- ------------------------------------------------------------
-- Returns the new tournament_pairs.id.
--
-- pair_name and combined_elo are computed by the caller: the name is two
-- players' full_name joined the way addPairToEvent has always joined them, and
-- combined_elo comes from calculateTeamRating in @badminton/shared. Neither is
-- re-implemented here, for the reason 00070's header gives about the rating
-- arithmetic — a second implementation is a second answer.
CREATE OR REPLACE FUNCTION public.pair_tournament_entrants(
  p_event_id uuid,
  p_player1_id uuid,
  p_player2_id uuid,
  p_pair_name text,
  p_combined_elo integer,
  p_added_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      RECORD;
  v_out_count  integer;
  v_pair_id    uuid;
BEGIN
  IF p_player1_id = p_player2_id THEN
    RAISE EXCEPTION 'A pair needs two different players.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Everything below reads the event's field and then writes it. Serialise the
  -- whole operation on the event so two desks cannot both decide that neither
  -- player is spoken for. Released at commit, whether that is a COMMIT or a
  -- ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT id, event_type, status, draw_locked
    INTO v_event
    FROM tournament_events
   WHERE id = p_event_id;
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

  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Already on a team in this event. Not covered by the unique index (see the
  -- header), and the one that actually matters: A in two pairs is A in the draw
  -- twice, and two of everyone's entry-cap slots spent on one person.
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
    RAISE EXCEPTION 'One of these players has already left this event. Add them again before pairing them.'
      USING ERRCODE = 'check_violation';
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

COMMENT ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid) IS
  'Form a doubles pair from two players, removing either of them from the event''s unpaired pool in the SAME transaction. The only writer of tournament_pairs. PostgREST has no transactions, so an application-side delete-then-insert could leave a player counted twice by the entry cap (pair written, pool rows left) or strip two paid entries (pool rows deleted, pair not written). Serialises on the event with an advisory lock because "already in a pair" cannot be expressed as an index — UNIQUE(event_id, player1_id, player2_id) is on the ordered triple. pair_name/combined_elo are computed by the caller (calculateTeamRating), per 00070.';


-- ------------------------------------------------------------
-- unpair_tournament_pair — dissolve a team back into the pool
-- ------------------------------------------------------------
-- Returns the ids of the two tournament_participants rows it created.
--
-- TWO OPERATIONS IN ONE FUNCTION, because they are the same writes:
--
--   p_withdrawn_player_id NULL  → a plain unpair. Execs will pair the wrong two
--     people, and the only alternative to an undo is deleting the pair and
--     re-entering both, which loses the fee row's timing and the audit trail.
--
--   p_withdrawn_player_id set   → ONE HALF PULLED OUT. The club owner has ruled
--     that withdrawing does not refund, so the partner who is left has already
--     paid, has already signed the event waiver, and already holds one of their
--     allowed entries at this tournament. Deleting their entry because somebody
--     else bailed would punish the wrong person. They drop back into the pool as
--     an unpaired entrant, keeping all three, and can be paired with somebody
--     else. The leaver keeps a 'withdrawn' row rather than vanishing — that is
--     what makes "no refund" legible on the fee page, and it releases their own
--     entry-cap slot exactly as any other withdrawal does.
--
-- REFUSES ONCE A DRAW EXISTS, and the database would refuse anyway:
-- tournament_matches.pair_a_id / pair_b_id / winner_pair_id / loser_pair_id all
-- REFERENCE tournament_pairs(id) with no ON DELETE action, so deleting a seeded
-- pair raises a foreign-key violation. The explicit check is here to turn that
-- into a sentence an exec can act on. After the draw the coherent exit is
-- withdrawing the WHOLE pair, which forfeits its matches to its opponents.
--
-- elo_before on the two new rows is doubles_elo, not singles_elo: these are
-- entrants in a doubles event and it is the number the pool's Elo column shows
-- and the number a pair formed from them would be rated on.
CREATE OR REPLACE FUNCTION public.unpair_tournament_pair(
  p_pair_id uuid,
  p_withdrawn_player_id uuid,
  p_reason text,
  p_added_by uuid
)
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
    FROM tournament_events WHERE id = v_pair.event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
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
  INSERT INTO tournament_participants (event_id, player_id, status, elo_before, added_by, notes)
  SELECT
    v_pair.event_id,
    h.player_id,
    CASE WHEN h.player_id = p_withdrawn_player_id THEN 'withdrawn' ELSE 'registered' END,
    COALESCE((SELECT r.doubles_elo FROM ratings r WHERE r.player_id = h.player_id), 400),
    p_added_by,
    CASE WHEN h.player_id = p_withdrawn_player_id THEN p_reason ELSE NULL END
  FROM unnest(ARRAY[v_pair.player1_id, v_pair.player2_id]) AS h(player_id);

  -- Read back rather than RETURNING ... INTO, which keeps only the last row of
  -- a multi-row insert.
  SELECT array_agg(id) INTO v_ids
    FROM tournament_participants
   WHERE event_id = v_pair.event_id
     AND player_id IN (v_pair.player1_id, v_pair.player2_id);

  RETURN v_ids;
END;
$function$;

COMMENT ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid) IS
  'Dissolve a doubles pair back into the event''s unpaired pool, atomically. With p_withdrawn_player_id NULL it is a plain undo of a mis-pairing; with it set, that half is written back as ''withdrawn'' and the PARTNER returns to the pool as an ordinary entrant — keeping their fee (withdrawal does not refund), their event-waiver acceptance and their entry-cap slot, because losing an entry they paid for when somebody else bailed punishes the wrong person. Refuses once the pair appears in any tournament_matches row; the foreign keys would refuse the delete anyway, and this turns that into a sentence.';


-- ------------------------------------------------------------
-- Grants
-- ------------------------------------------------------------
-- service_role ONLY. Both functions are called by admin server actions through
-- the service-role client, behind requireCapability; neither is reachable from
-- a signed-in member's own client, and SECURITY DEFINER means a grant to
-- `authenticated` would hand every member the ability to rewrite any event's
-- field. PUBLIC is revoked explicitly because a freshly created function is
-- executable by PUBLIC by default.
REVOKE ALL ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pair_tournament_entrants(uuid, uuid, uuid, text, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unpair_tournament_pair(uuid, uuid, text, uuid) TO service_role;


-- ============================================================
-- What this migration does NOT do, and why
-- ============================================================
-- No column is added, dropped or made nullable. In particular player2_id stays
-- NOT NULL — see the header.
--
-- There is no cross-table constraint saying "a player is a pool entrant OR half
-- of a pair, never both". Postgres cannot express that as a CHECK or a unique
-- index (it spans two tables), and the alternatives are a pair of triggers,
-- which would have to fire on four statements and could still be bypassed by a
-- direct DELETE. Instead pair_tournament_entrants is made the ONLY way a pair
-- row is ever written, and it removes the pool rows itself. The invariant is
-- held by there being one door rather than by a guard on many.
--
-- To find any drift on production (expect zero rows):
--
--   SELECT e.id AS event_id, p.player_id
--     FROM tournament_participants p
--     JOIN tournament_events e ON e.id = p.event_id
--    WHERE e.event_type IN ('mens_doubles','womens_doubles','mixed_doubles')
--      AND p.status NOT IN ('withdrawn','disqualified')
--      AND EXISTS (
--            SELECT 1 FROM tournament_pairs tp
--             WHERE tp.event_id = p.event_id
--               AND tp.status NOT IN ('withdrawn','disqualified')
--               AND p.player_id IN (tp.player1_id, tp.player2_id));
--
--   SELECT event_id, player_id, count(*) FROM (
--     SELECT event_id, player1_id AS player_id FROM tournament_pairs
--      WHERE status NOT IN ('withdrawn','disqualified')
--     UNION ALL
--     SELECT event_id, player2_id FROM tournament_pairs
--      WHERE status NOT IN ('withdrawn','disqualified')
--   ) x GROUP BY 1, 2 HAVING count(*) > 1;
