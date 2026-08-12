-- ============================================================
-- 00103 — swap one half of a doubles pair, in one operation
--
-- "we should also be allowed to edit pairs." — the club owner.
--
-- The real case is "Priya is injured, Sam is taking her place". With only the
-- pair/unpair functions from 00102 that is three operations — unpair, then pair
-- Sam with the partner, then deal with Priya — and in the middle of it two
-- people who ARE still entered look like they are not on a team. Worse, the
-- middle state is durable: an exec interrupted between step one and step two
-- leaves a formed team dissolved for no reason anybody can reconstruct.
--
-- So: one function, one transaction.
--
-- ------------------------------------------------------------
-- WHY THIS IS NOT unpair-THEN-pair FROM TYPESCRIPT
-- ------------------------------------------------------------
-- The same reason 00102 gives, one step sharper. A swap that half-applies
-- leaves a pair with a stranger in it AND somebody loose who believes they are
-- playing — or the outgoing member erased from the event entirely with the pair
-- unchanged. Neither is repairable from the console without knowing what the
-- exec meant. Composed from two PostgREST round trips it is reachable on any
-- dropped connection; as one plpgsql body it is not reachable at all.
--
-- ------------------------------------------------------------
-- IT IS AN UPDATE, WHICH IS WHY THE DRAW CHECK IS LOAD-BEARING HERE
-- ------------------------------------------------------------
-- unpair_tournament_pair DELETEs the pair row, and the four foreign keys from
-- tournament_matches (pair_a_id, pair_b_id, winner_pair_id, loser_pair_id — all
-- confirmed NO ACTION) refuse that outright once the pair is seeded. The
-- database is a backstop there.
--
-- A SWAP IS AN UPDATE OF player1_id/player2_id, so NO foreign key is touched
-- and Postgres would let it through happily. That is strictly more dangerous
-- than the delete case: it would silently change who is in a seeded team,
-- rewriting the identity of an entry whose matches may already be played and
-- whose Elo deltas have already been applied to the OTHER person. The explicit
-- check below is the only thing standing in front of that, and it must not be
-- weakened into "the event status looks early enough".
--
-- ------------------------------------------------------------
-- THE INCOMING PLAYER MUST ALREADY BE IN THE POOL
-- ------------------------------------------------------------
-- Not a limitation — the alternative is worse. Letting an exec swap in somebody
-- who has not entered at all would mean this function also had to charge them,
-- push the event waiver at them and check them against the per-member entry
-- cap: a second implementation of addParticipantToEvent, inside the one place
-- whose whole job is to be atomic.
--
-- Requiring the pool entry instead makes the swap NEUTRAL in every one of those
-- currencies by construction — one member in, one member out, both already
-- entered, both already invoiced, both already asked to sign, both already
-- holding one entry-cap slot. And the exec's two-step is a pair of coherent
-- states rather than a broken one: add them to the waiting list (which invoices
-- them, pushes the waiver and checks the cap), then swap them in.
--
-- Re-runnable: CREATE OR REPLACE plus idempotent GRANT/REVOKE and COMMENT.
-- NO TABLE IS ALTERED.
-- ============================================================

CREATE OR REPLACE FUNCTION public.swap_tournament_pair_member(
  p_pair_id uuid,
  p_outgoing_player_id uuid,
  p_incoming_player_id uuid,
  p_pair_name text,
  p_combined_elo integer,
  p_added_by uuid
)
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
    FROM tournament_events WHERE id = v_pair.event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
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

COMMENT ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid) IS
  'Replace one half of a doubles pair with a member from the same event''s unpaired pool, atomically: the incoming player leaves the pool, the pair is updated in place (keeping its id and seed but RESET to ''registered'', because a check-in screened the old team), and the outgoing player lands back in the pool keeping their fee, event waiver and entry-cap slot. Neutral in all three currencies by construction, which is why the incoming player must already have entered. UNLIKE unpair_tournament_pair this is an UPDATE, so the tournament_matches foreign keys do NOT protect a seeded pair — the explicit draw check inside is the only thing that does, and removing it would let a played team change identity. pair_name/combined_elo are recomputed by the caller (calculateTeamRating), per 00070.';

-- service_role ONLY, as 00102. Called by an admin server action behind
-- requireCapability; SECURITY DEFINER means a grant to `authenticated` would
-- hand every member the ability to rewrite any team in any event.
REVOKE ALL ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.swap_tournament_pair_member(uuid, uuid, uuid, text, integer, uuid) TO service_role;
