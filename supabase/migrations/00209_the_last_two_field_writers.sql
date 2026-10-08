-- ===========================================================================
-- 00209 — THE LAST TWO FIELD WRITERS
-- ===========================================================================
--
-- 00201 made ONE advisory key the fence for the event field and moved every
-- writer onto it. A census run for this migration confirms it held: all eleven
-- field-mutating RPCs take
--
--   pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(<event>))
--
-- add_participants_under_field_lock, bulk_check_in_field, enter_tournament_event,
-- pair_tournament_entrants, promote_pool_qualifier, publish_event_draw,
-- remove_field_entry, set_field_entry_status, swap_tournament_pair_member,
-- unpair_tournament_pair, withdraw_from_tournament_event — eleven of eleven.
--
-- So this is NOT the Tier 2 redesign the register still describes. The
-- discipline exists. What the census found is that TWO writers never joined it,
-- and both were missed by the earlier sweeps for the same reason: neither looks
-- like a field mutator at the call site.
--
--
-- GAP 1 — SEEDS AND GROUPS (seeding.ts, six unfenced writes)
-- ----------------------------------------------------------
-- seeding.ts writes seed_number and group_number straight through PostgREST:
--
--   updateParticipantSeed   tournament_participants.seed_number   (one row)
--   updatePairSeed          tournament_pairs.seed_number          (one row)
--   autoSeedEventByElo      <table>.seed_number                   (N rows)
--   clearSeeds              <table>.seed_number = NULL            (whole event)
--   assignEventGroups       <table>.group_number                  (N rows)
--   updateEntryGroup        <table>.group_number                  (one row)
--
-- Four of the six go through a `table` variable chosen at runtime from the
-- event's discipline, which is why a grep for the table names did not surface
-- them.
--
-- SEEDS ARE THE DRAW'S INPUT, so this is the same defect class as the
-- withdrawal race, not a lesser one. publish_event_draw reads the field and
-- flips the status as separate statements inside its fence; a seed write that
-- commits between the generator building a bracket and publish_event_draw
-- accepting it produces a PUBLISHED bracket whose seeding no longer matches
-- the rows it was built from. Nothing downstream notices, because the bracket
-- is already fixtures by then and seed_number has become display metadata that
-- disagrees with it.
--
-- THE STATUS REFUSALS BELOW ARE NOT NEW RULES. They are the rules the console
-- already enforces, moved to where they cannot be overtaken:
--
--   participant-controls.ts:210  `open` = status 'registration' AND NOT locked
--                                 -> gates autoSeed, clearSeeds, editSeed
--   ParticipantsTab.tsx:336      groupsEditable = status IN (registration,
--                                 checkin) AND NOT locked AND no fixtures
--
-- The server actions themselves checked ONLY draw_locked — so the status half
-- of the console's own rule had no server-side enforcement at all. That is a
-- real gap being closed, not a tightening invented here.
--
--
-- GAP 2 — FINALISATION (finalize.ts, R1)
-- ---------------------------------------
-- finalizeEvent reads the event, computes every final position from the
-- matches, writes them, and then flips the event to completed with a
-- conditional UPDATE ... WHERE status = 'live'. That condition makes two
-- concurrent FINALISATIONS safe and it is kept. It does nothing about the
-- other order:
--
--   promote_pool_qualifier commits a new entrant into the field  (it holds the
--   field lock, correctly)                                        |
--   finalizeEvent has already computed positions without them     |
--   finalizeEvent's UPDATE still sees status = 'live' and commits <
--
-- The promoted entrant lands in a completed event with final_position NULL and
-- no tournament points, invisible to every results screen, and finalizeEvent
-- refuses to run again because the event is no longer live.
--
-- WHAT IS NOT DONE HERE, AND WHY. Making the lock span the read and the write
-- in the strict sense would mean moving assignPositionsAndPoints into plpgsql:
-- ~250 lines of bracket arithmetic, third-place-playoff handling, pool
-- standings and the slot-vs-result cross-check. That is not a fence, it is a
-- rewrite of the highest-risk function in the codebase, and it would be a
-- worse trade than the race it closes.
--
-- Instead finalisation joins the protocol the way publish_event_draw already
-- does: the caller passes the field it positioned, and the flip happens under
-- the lock only if that field is still the field. publish_event_draw's
-- p_entrants argument is the exact precedent — assertFieldDidNotGrow makes the
-- same comparison a round trip earlier and cheaply, and this is the one that
-- cannot be overtaken.
--
-- A DELTA CHECK, NOT AN INVARIANT CHECK, and that distinction is deliberate.
-- "every active entry has a final_position" is the tempting post-condition and
-- it measures clean on staging (0 violations across the completed events
-- there) — but that is n=2 and there are entry shapes it would refuse that
-- nobody has produced yet. Asking only "did the field GAIN a member since the
-- caller read it" is exactly R1 and nothing else, and it cannot refuse a
-- historical shape because it compares two reads of the same event minutes
-- apart rather than measuring an absolute property.
--
-- Shrinking is fine and is not refused: a withdrawal between the two reads
-- removes somebody who does not need a placing.
--
--
-- LOCK ORDER
-- ----------
-- advisory -> tournament_events, a prefix of the order 00201 established
-- (advisory -> tournaments -> players -> tournament_events). No new edge.
--
-- GRANTS
-- ------
-- REVOKE ... FROM PUBLIC alone does NOT remove Supabase's default anon grant,
-- so every function below names PUBLIC, anon and authenticated explicitly and
-- then grants service_role. Recorded in 00201 and re-proved in 00208.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Seeds — one entry
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_field_entry_seed(
  p_entry_id uuid, p_is_pair boolean, p_seed integer
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
    RAISE EXCEPTION 'set_field_entry_seed: p_entry_id and p_is_pair may not be null';
  END IF;
  -- RAISED, NOT REFUSED. A seed is a rank within the field; zero and negative
  -- ranks are caller faults, not states the desk can reach, and letting one
  -- through would put an unorderable value into the draw generator's input.
  IF p_seed IS NOT NULL AND p_seed < 1 THEN
    RAISE EXCEPTION 'set_field_entry_seed: seed % is not a rank', p_seed;
  END IF;

  -- Unfenced, and only to learn which event to fence ON. Every value it
  -- produces is re-read below under the lock.
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
  IF v_locked THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_locked');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  IF p_is_pair THEN
    UPDATE tournament_pairs SET seed_number = p_seed
     WHERE id = p_entry_id AND event_id = v_event;
  ELSE
    UPDATE tournament_participants SET seed_number = p_seed
     WHERE id = p_entry_id AND event_id = v_event;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'event_id', v_event,
                            'tournament_id', v_tournament, 'event_status', v_status);
END;
$function$;


-- ---------------------------------------------------------------------------
-- Seeds — the whole field, by rating
-- ---------------------------------------------------------------------------
-- THE ORDERING MOVED INTO THE FENCE, and that is the point rather than a
-- performance aside. autoSeedEventByElo read the entrants ordered by rating,
-- then issued one UPDATE per entrant from the application — so the read that
-- decided the order and the writes that recorded it were N+1 separate
-- transactions, and a withdrawal landing among them seeded a field that no
-- longer existed. One statement inside the lock cannot be interleaved at all,
-- and it also retires the settleWrites batch: there are no longer N writes to
-- half-apply.
--
-- The predicate is the caller's own: everyone not withdrawn or disqualified,
-- highest rating first, NULLs last. Pairs rank on combined_elo, singles on
-- elo_before, exactly as before.
CREATE OR REPLACE FUNCTION public.auto_seed_field_by_rating(
  p_event_id uuid, p_is_pair boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
  v_seeded     integer;
BEGIN
  IF p_event_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'auto_seed_field_by_rating: p_event_id and p_is_pair may not be null';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked
    INTO v_status, v_tournament, v_locked
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_locked THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_locked');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  IF p_is_pair THEN
    WITH ranked AS (
      SELECT id, row_number() OVER (ORDER BY combined_elo DESC NULLS LAST, id) AS rn
        FROM tournament_pairs
       WHERE event_id = p_event_id
         AND status::TEXT NOT IN ('withdrawn', 'disqualified')
    ), done AS (
      UPDATE tournament_pairs t SET seed_number = r.rn
        FROM ranked r WHERE t.id = r.id
      RETURNING t.id
    ) SELECT count(*) INTO v_seeded FROM done;
  ELSE
    WITH ranked AS (
      SELECT id, row_number() OVER (ORDER BY elo_before DESC NULLS LAST, id) AS rn
        FROM tournament_participants
       WHERE event_id = p_event_id
         AND status::TEXT NOT IN ('withdrawn', 'disqualified')
    ), done AS (
      UPDATE tournament_participants t SET seed_number = r.rn
        FROM ranked r WHERE t.id = r.id
      RETURNING t.id
    ) SELECT count(*) INTO v_seeded FROM done;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'seeded', COALESCE(v_seeded, 0),
                            'event_id', p_event_id, 'tournament_id', v_tournament,
                            'event_status', v_status);
END;
$function$;


-- ---------------------------------------------------------------------------
-- Seeds — cleared
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_field_seeds(
  p_event_id uuid, p_is_pair boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
  v_cleared    integer;
BEGIN
  IF p_event_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'clear_field_seeds: p_event_id and p_is_pair may not be null';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked
    INTO v_status, v_tournament, v_locked
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_locked THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_locked');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  -- The whole field, seeded or not: this is the button that means "there are
  -- no seeds in this event", so it must not leave a row behind because its
  -- seed was already NULL and the predicate skipped it.
  IF p_is_pair THEN
    WITH done AS (
      UPDATE tournament_pairs SET seed_number = NULL
       WHERE event_id = p_event_id RETURNING id
    ) SELECT count(*) INTO v_cleared FROM done;
  ELSE
    WITH done AS (
      UPDATE tournament_participants SET seed_number = NULL
       WHERE event_id = p_event_id RETURNING id
    ) SELECT count(*) INTO v_cleared FROM done;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'cleared', COALESCE(v_cleared, 0),
                            'event_id', p_event_id, 'tournament_id', v_tournament,
                            'event_status', v_status);
END;
$function$;


-- ---------------------------------------------------------------------------
-- Groups — the whole field
-- ---------------------------------------------------------------------------
-- THE PLAN STAYS IN THE APPLICATION AND THE FIELD IT WAS MADE FROM IS
-- VERIFIED HERE. planGroupAssignment is serpentine-by-seed with a
-- reassign-all switch and a tier walk; it is real logic with its own tests and
-- porting it to plpgsql to gain a fence would be trading a small race for a
-- second implementation of the thing that decides who plays whom.
--
-- So the shape is publish_event_draw's: the caller passes the entry ids its
-- plan covers, and this refuses if the eligible field under the lock is not
-- that set. Both directions matter — an arrival gets no group and would be
-- built fixtures for a group it was never dealt into, and a departure means
-- the plan balanced group sizes against somebody who has gone.
CREATE OR REPLACE FUNCTION public.set_field_groups(
  p_event_id uuid, p_is_pair boolean, p_assignments jsonb, p_expected uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_status     text;
  v_locked     boolean;
  v_groups     integer;
  v_matches    integer;
  v_now        uuid[];
  v_missing    integer;
  v_extra      integer;
  v_bad        integer;
  v_written    integer;
BEGIN
  IF p_event_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'set_field_groups: p_event_id and p_is_pair may not be null';
  END IF;
  IF p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'object' THEN
    RAISE EXCEPTION 'set_field_groups: p_assignments must be an object of entry id -> group number';
  END IF;
  IF p_expected IS NULL OR array_length(p_expected, 1) IS NULL THEN
    RAISE EXCEPTION 'set_field_groups: p_expected may not be null or empty';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked, COALESCE(e.group_count, 1)
    INTO v_status, v_tournament, v_locked, v_groups
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_locked THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_locked');
  END IF;
  IF v_status NOT IN ('registration', 'checkin') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;
  IF v_groups < 2 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_a_group_stage',
                              'group_count', v_groups);
  END IF;

  -- GROUPS ARE FIXED THE MOMENT THE FIXTURES EXIST, and this is the refusal
  -- loadGroupStage makes a round trip earlier — made here where a generation
  -- committing in between cannot get past it.
  SELECT count(*) INTO v_matches FROM tournament_matches WHERE event_id = p_event_id;
  IF v_matches > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'fixtures_exist',
                              'matches', v_matches);
  END IF;

  IF p_is_pair THEN
    SELECT array_agg(id) INTO v_now FROM tournament_pairs
     WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in');
  ELSE
    SELECT array_agg(id) INTO v_now FROM tournament_participants
     WHERE event_id = p_event_id AND status::TEXT IN ('registered', 'checked_in');
  END IF;
  v_now := COALESCE(v_now, ARRAY[]::uuid[]);

  SELECT count(*) INTO v_missing FROM unnest(v_now) AS n(id)
   WHERE NOT (n.id = ANY (p_expected));
  SELECT count(*) INTO v_extra FROM unnest(p_expected) AS x(id)
   WHERE NOT (x.id = ANY (v_now));
  IF v_missing > 0 OR v_extra > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'field_changed',
                              'arrived', v_missing, 'left', v_extra);
  END IF;

  -- A group number outside 1..group_count would partition the field into a
  -- group the round robin generator will never build fixtures for. Refused as
  -- a set rather than per row: a plan that produced one bad number is not a
  -- plan to apply the rest of.
  SELECT count(*) INTO v_bad
    FROM jsonb_each_text(p_assignments) AS a(k, v)
   WHERE (v)::integer < 1 OR (v)::integer > v_groups;
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'group_out_of_range',
                              'group_count', v_groups, 'bad', v_bad);
  END IF;

  IF p_is_pair THEN
    WITH done AS (
      UPDATE tournament_pairs t SET group_number = (a.v)::integer
        FROM jsonb_each_text(p_assignments) AS a(k, v)
       WHERE t.id = (a.k)::uuid AND t.event_id = p_event_id
      RETURNING t.id
    ) SELECT count(*) INTO v_written FROM done;
  ELSE
    WITH done AS (
      UPDATE tournament_participants t SET group_number = (a.v)::integer
        FROM jsonb_each_text(p_assignments) AS a(k, v)
       WHERE t.id = (a.k)::uuid AND t.event_id = p_event_id
      RETURNING t.id
    ) SELECT count(*) INTO v_written FROM done;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'assigned', COALESCE(v_written, 0),
                            'group_count', v_groups, 'event_id', p_event_id,
                            'tournament_id', v_tournament, 'event_status', v_status);
END;
$function$;


-- ---------------------------------------------------------------------------
-- Groups — one entry
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_field_entry_group(
  p_entry_id uuid, p_is_pair boolean, p_group integer
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
  v_groups     integer;
  v_matches    integer;
BEGIN
  IF p_entry_id IS NULL OR p_is_pair IS NULL OR p_group IS NULL THEN
    RAISE EXCEPTION 'set_field_entry_group: p_entry_id, p_is_pair and p_group may not be null';
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

  SELECT e.status::TEXT, e.tournament_id, e.draw_locked, COALESCE(e.group_count, 1)
    INTO v_status, v_tournament, v_locked, v_groups
    FROM tournament_events e WHERE e.id = v_event FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_locked THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'draw_locked');
  END IF;
  IF v_status NOT IN ('registration', 'checkin') THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;
  IF v_groups < 2 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_a_group_stage',
                              'group_count', v_groups);
  END IF;
  IF p_group < 1 OR p_group > v_groups THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'group_out_of_range',
                              'group_count', v_groups);
  END IF;

  SELECT count(*) INTO v_matches FROM tournament_matches WHERE event_id = v_event;
  IF v_matches > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'fixtures_exist',
                              'matches', v_matches);
  END IF;

  IF p_is_pair THEN
    UPDATE tournament_pairs SET group_number = p_group
     WHERE id = p_entry_id AND event_id = v_event;
  ELSE
    UPDATE tournament_participants SET group_number = p_group
     WHERE id = p_entry_id AND event_id = v_event;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'entry_not_found');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'event_id', v_event,
                            'tournament_id', v_tournament, 'event_status', v_status);
END;
$function$;


-- ---------------------------------------------------------------------------
-- Finalisation — the flip, under the fence (R1)
-- ---------------------------------------------------------------------------
-- p_field is the set of ACTIVE entries the caller positioned against. Growth
-- is refused; shrinkage is not (see the header). The incomplete-match count is
-- re-taken here for the same reason the field is: finalizeEvent's own check is
-- a read from before the positions were written, and a match reopened in
-- between would otherwise be finalised over.
--
-- status = 'live' is asserted under the lock rather than as a WHERE clause, so
-- the loser of a finalisation race gets 'event_status' with the status it lost
-- to, instead of a zero row count it has to interpret.
CREATE OR REPLACE FUNCTION public.complete_event_under_field_lock(
  p_event_id uuid, p_is_pair boolean, p_field uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament uuid;
  v_status     text;
  v_arrived    integer;
  v_open       integer;
BEGIN
  IF p_event_id IS NULL OR p_is_pair IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_event_id and p_is_pair may not be null';
  END IF;
  -- NULL is a caller that did not read its field; an empty array is a caller
  -- that read an empty field. Only the first is a fault, and it must not be
  -- able to degrade into an unchecked completion.
  IF p_field IS NULL THEN
    RAISE EXCEPTION 'complete_event_under_field_lock: p_field may not be null';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.tournament_id
    INTO v_status, v_tournament
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status <> 'live' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_status',
                              'event_status', v_status);
  END IF;

  IF p_is_pair THEN
    SELECT count(*) INTO v_arrived FROM tournament_pairs
     WHERE event_id = p_event_id
       AND status::TEXT NOT IN ('withdrawn', 'disqualified')
       AND NOT (id = ANY (p_field));
  ELSE
    SELECT count(*) INTO v_arrived FROM tournament_participants
     WHERE event_id = p_event_id
       AND status::TEXT NOT IN ('withdrawn', 'disqualified')
       AND NOT (id = ANY (p_field));
  END IF;
  IF v_arrived > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'field_changed',
                              'arrived', v_arrived);
  END IF;

  SELECT count(*) INTO v_open FROM tournament_matches
   WHERE event_id = p_event_id
     AND status::TEXT NOT IN ('completed', 'walkover', 'voided', 'bye')
     AND COALESCE(is_bye, FALSE) = FALSE;
  IF v_open > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'matches_incomplete',
                              'incomplete', v_open);
  END IF;

  UPDATE tournament_events
     SET status = 'completed', updated_at = NOW()
   WHERE id = p_event_id;

  RETURN jsonb_build_object('ok', TRUE, 'event_id', p_event_id,
                            'tournament_id', v_tournament);
END;
$function$;


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.set_field_entry_seed(uuid, boolean, integer)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auto_seed_field_by_rating(uuid, boolean)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_field_seeds(uuid, boolean)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_field_groups(uuid, boolean, jsonb, uuid[])            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_field_entry_group(uuid, boolean, integer)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[])    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_field_entry_seed(uuid, boolean, integer)           TO service_role;
GRANT EXECUTE ON FUNCTION public.auto_seed_field_by_rating(uuid, boolean)               TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_field_seeds(uuid, boolean)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.set_field_groups(uuid, boolean, jsonb, uuid[])         TO service_role;
GRANT EXECUTE ON FUNCTION public.set_field_entry_group(uuid, boolean, integer)          TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[]) TO service_role;

COMMENT ON FUNCTION public.complete_event_under_field_lock(uuid, boolean, uuid[]) IS
  'Flips a live event to completed under the tournament_event_field advisory key. p_field is the active entry set the caller assigned positions to; growth since then is refused as field_changed (R1: a pool qualifier promoted mid-finalisation would otherwise land with no placing and no points in an event that can never be finalised again).';



-- ===========================================================================
-- VERIFY
-- ===========================================================================
-- Behavioural, not structural, wherever a behaviour is what matters. Check 2
-- is the one static assertion and it exists because the whole migration is
-- about one line being present in six bodies: a function that quietly loses
-- its PERFORM pg_advisory_xact_lock still passes every functional probe below,
-- because the probes run alone.
DO $verify$
DECLARE
  v_fn        TEXT;
  v_missing   TEXT;
  v_t         UUID;
  v_e         UUID;
  v_p1        UUID;
  v_p2        UUID;
  v_p3        UUID;
  v_e1        UUID;
  v_e2        UUID;
  v_e3        UUID;
  v_res       JSONB;
  v_seeds     INT[];
  v_ok_seed   BOOLEAN := FALSE;
  v_refused   TEXT;
  v_grp_ref   TEXT;
  v_fin_ok    BOOLEAN := FALSE;
  v_fin_ref   TEXT;
  v_status    TEXT;
BEGIN
  -- 1. None of the six is reachable by anon. has_function_privilege, never a
  --    hand-read of proacl: these functions carry a PUBLIC grant as well as a
  --    named one and PUBLIC includes anon, so reading either grant alone gives
  --    the wrong answer (proved on staging for 00208).
  FOR v_fn IN
    SELECT unnest(ARRAY[
      'public.set_field_entry_seed(uuid,boolean,integer)',
      'public.auto_seed_field_by_rating(uuid,boolean)',
      'public.clear_field_seeds(uuid,boolean)',
      'public.set_field_groups(uuid,boolean,jsonb,uuid[])',
      'public.set_field_entry_group(uuid,boolean,integer)',
      'public.complete_event_under_field_lock(uuid,boolean,uuid[])'])
  LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00209: anon can execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00209: service_role cannot execute %, so the application cannot call it', v_fn;
    END IF;
  END LOOP;

  -- 2. All six take THE field key. The whole point of this migration is that
  --    these writers join the one fence 00201 established, and a body that
  --    dropped the line would pass every other check here.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_missing
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('set_field_entry_seed', 'auto_seed_field_by_rating',
                       'clear_field_seeds', 'set_field_groups',
                       'set_field_entry_group', 'complete_event_under_field_lock')
     AND position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' IN p.prosrc) = 0;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '00209: these do not take the field key: %', v_missing;
  END IF;

  -- 3. Auto-seed orders by rating under the lock, and refuses once the event
  --    has left registration -- which is the console's own rule
  --    (participant-controls.ts `open`) and had no server-side enforcement
  --    at all before this migration.
  BEGIN
    INSERT INTO players (email, first_name) VALUES ('_f209a@invalid.test','FieldA') RETURNING id INTO v_p1;
    INSERT INTO players (email, first_name) VALUES ('_f209b@invalid.test','FieldB') RETURNING id INTO v_p2;
    INSERT INTO players (email, first_name) VALUES ('_f209c@invalid.test','FieldC') RETURNING id INTO v_p3;
    INSERT INTO tournaments (name, start_date) VALUES ('_f209 probe', CURRENT_DATE) RETURNING id INTO v_t;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'registration') RETURNING id INTO v_e;
    -- Deliberately inserted worst-rated first, so a function that seeded in
    -- insertion order rather than rating order fails this.
    INSERT INTO tournament_participants (event_id, player_id, elo_before) VALUES (v_e, v_p1, 900)  RETURNING id INTO v_e1;
    INSERT INTO tournament_participants (event_id, player_id, elo_before) VALUES (v_e, v_p2, 1500) RETURNING id INTO v_e2;
    INSERT INTO tournament_participants (event_id, player_id, elo_before) VALUES (v_e, v_p3, 1200) RETURNING id INTO v_e3;

    v_res := auto_seed_field_by_rating(v_e, FALSE);
    IF NOT (v_res->>'ok')::boolean THEN
      RAISE EXCEPTION '00209: auto_seed_field_by_rating refused a registration-status event: %', v_res;
    END IF;
    SELECT array_agg(seed_number ORDER BY id) INTO v_seeds
      FROM tournament_participants WHERE id IN (v_e1, v_e2, v_e3);
    SELECT (SELECT seed_number FROM tournament_participants WHERE id = v_e2) = 1
       AND (SELECT seed_number FROM tournament_participants WHERE id = v_e3) = 2
       AND (SELECT seed_number FROM tournament_participants WHERE id = v_e1) = 3
      INTO v_ok_seed;

    -- The same call once the draw exists.
    UPDATE tournament_events SET status = 'live' WHERE id = v_e;
    v_res := auto_seed_field_by_rating(v_e, FALSE);
    v_refused := v_res->>'reason';

    RAISE EXCEPTION 'rollback probe 3';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback probe 3' THEN RAISE; END IF;
  END;
  IF NOT v_ok_seed THEN
    RAISE EXCEPTION '00209: auto_seed_field_by_rating did not seed 1..3 by descending rating (got %)', v_seeds;
  END IF;
  IF v_refused IS DISTINCT FROM 'event_status' THEN
    RAISE EXCEPTION '00209: seeding a live event was not refused with event_status (reason %)', COALESCE(v_refused, 'none -- it succeeded');
  END IF;

  -- 4. A group plan built against a field that has since gained an entrant is
  --    refused rather than half-applied. This is the arrival that would
  --    otherwise be given fixtures for a group nobody dealt it into.
  BEGIN
    INSERT INTO players (email, first_name) VALUES ('_f209d@invalid.test','FieldD') RETURNING id INTO v_p1;
    INSERT INTO players (email, first_name) VALUES ('_f209e@invalid.test','FieldE') RETURNING id INTO v_p2;
    INSERT INTO players (email, first_name) VALUES ('_f209f@invalid.test','FieldF') RETURNING id INTO v_p3;
    INSERT INTO tournaments (name, start_date) VALUES ('_f209 probe 2', CURRENT_DATE) RETURNING id INTO v_t;
    INSERT INTO tournament_events (tournament_id, event_type, format, status, group_count)
      VALUES (v_t, 'open_singles', 'round_robin', 'registration', 2) RETURNING id INTO v_e;
    INSERT INTO tournament_participants (event_id, player_id) VALUES (v_e, v_p1) RETURNING id INTO v_e1;
    INSERT INTO tournament_participants (event_id, player_id) VALUES (v_e, v_p2) RETURNING id INTO v_e2;
    -- The plan covers two, and a third arrives before it is applied.
    INSERT INTO tournament_participants (event_id, player_id) VALUES (v_e, v_p3) RETURNING id INTO v_e3;

    v_res := set_field_groups(v_e, FALSE,
               jsonb_build_object(v_e1::text, 1, v_e2::text, 2),
               ARRAY[v_e1, v_e2]);
    v_grp_ref := v_res->>'reason';

    RAISE EXCEPTION 'rollback probe 4';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback probe 4' THEN RAISE; END IF;
  END;
  IF v_grp_ref IS DISTINCT FROM 'field_changed' THEN
    RAISE EXCEPTION '00209: a group plan applied over a field that had grown was not refused (reason %)', COALESCE(v_grp_ref, 'none -- it was applied');
  END IF;

  -- 5. R1 itself. A live event whose field is the field the caller positioned
  --    completes; the same event with one entrant promoted in since then does
  --    not, and stays live so it can be finalised properly.
  BEGIN
    INSERT INTO players (email, first_name) VALUES ('_f209g@invalid.test','FieldG') RETURNING id INTO v_p1;
    INSERT INTO players (email, first_name) VALUES ('_f209h@invalid.test','FieldH') RETURNING id INTO v_p2;
    INSERT INTO players (email, first_name) VALUES ('_f209i@invalid.test','FieldI') RETURNING id INTO v_p3;
    INSERT INTO tournaments (name, start_date) VALUES ('_f209 probe 3', CURRENT_DATE) RETURNING id INTO v_t;
    INSERT INTO tournament_events (tournament_id, event_type, format, status)
      VALUES (v_t, 'open_singles', 'single_elimination', 'live') RETURNING id INTO v_e;
    INSERT INTO tournament_participants (event_id, player_id) VALUES (v_e, v_p1) RETURNING id INTO v_e1;
    INSERT INTO tournament_participants (event_id, player_id) VALUES (v_e, v_p2) RETURNING id INTO v_e2;
    -- The qualifier who was promoted while the positions were being computed.
    INSERT INTO tournament_participants (event_id, player_id) VALUES (v_e, v_p3) RETURNING id INTO v_e3;

    v_res := complete_event_under_field_lock(v_e, FALSE, ARRAY[v_e1, v_e2]);
    v_fin_ref := v_res->>'reason';
    SELECT status INTO v_status FROM tournament_events WHERE id = v_e;

    -- The same call naming the field as it actually stands.
    v_res := complete_event_under_field_lock(v_e, FALSE, ARRAY[v_e1, v_e2, v_e3]);
    v_fin_ok := (v_res->>'ok')::boolean;

    RAISE EXCEPTION 'rollback probe 5';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback probe 5' THEN RAISE; END IF;
  END;
  IF v_fin_ref IS DISTINCT FROM 'field_changed' THEN
    RAISE EXCEPTION '00209: an event that gained an entrant mid-finalisation was completed anyway (reason %)', COALESCE(v_fin_ref, 'none -- it completed');
  END IF;
  IF v_status IS DISTINCT FROM 'live' THEN
    RAISE EXCEPTION '00209: a refused finalisation still moved the event to %', v_status;
  END IF;
  IF NOT v_fin_ok THEN
    RAISE EXCEPTION '00209: a finalisation naming the correct field was refused, so the fence refuses everything';
  END IF;

  RAISE NOTICE '00209 verified: six writers on the field key; auto-seed orders by rating and refuses past registration; a stale group plan and a mid-finalisation arrival are both refused';
END
$verify$;

NOTIFY pgrst, 'reload schema';
