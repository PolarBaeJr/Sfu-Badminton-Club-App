-- ============================================================
-- 00185 — the three checks that decide a tournament entry run in the
--         transaction that writes it
--
-- Audit F-004. registerForEvent reads the event, counts the field, counts the
-- member's other entries, and then inserts a tournament_participants row under
-- the SERVICE ROLE — so RLS is not in the picture and nothing holds any of it
-- still. Three races, in the order they bite:
--
--   CAPACITY. Two members entering a 16-slot event that has 15 entries both
--   count 15 and both insert. Doubles is worse, because the currency is draw
--   slots and the count spans two tables, so the window is wider.
--
--   THE DRAW. `event.status !== 'registration'` is read some hundreds of
--   milliseconds before the insert. An exec generating the draw in that window
--   gets a bracket built from a field that gained a member afterwards — the
--   entrant is in the event and in no match, which is the state the /draw page
--   has no way to render and the exec has no way to fix except by hand. Only
--   HALF of that one is closed here (an entry can no longer land after the
--   status has moved); the other half is a fence in the admin app, described
--   at the lock below.
--
--   THE PER-MEMBER CAP (00098). Same shape: counted, then written.
--
-- The duplicate-entry check is NOT one of these — tournament_participants has
-- UNIQUE (event_id, player_id), so that one has always been decided by the
-- index rather than by the read. It is caught here anyway so a retry produces a
-- sentence rather than a 500.
--
-- WHAT STAYS IN TYPESCRIPT, and why this is not the whole of registerForEvent:
-- the membership gate, the competition-category screen, the event-waiver text,
-- the solo-entry acknowledgement and the suspension check all read data that
-- either cannot change during a request or whose change is not a correctness
-- problem, and every one of them carries a carefully-worded refusal that would
-- be worse for being reassembled from an enum. Moving them here would mean a
-- second copy of rules that live in @badminton/shared and are enforced by the
-- console too. Only the three counts have to be inside the write, so only the
-- three counts moved.
--
-- THE ARITHMETIC BELOW IS A SECOND IMPLEMENTATION OF doublesDrawSlots and
-- wouldExceedCapacity (packages/shared/src/utils/doubles-pool.ts) and that is
-- the cost of this fix. It is kept deliberately literal — `pairs +
-- ceil(unpaired / 2)`, and "over the max AND worse than before" — so the two
-- can be read side by side. If the slot rule ever changes, both change.
--
-- Service role only. It takes the player id as a parameter, which is exactly
-- what 00126 warns about, so it must never be reachable with an `authenticated`
-- key. The one caller holds the service key server-side and has already run
-- requirePlayer().
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.enter_tournament_event(
  p_event_id    UUID,
  p_player_id   UUID,
  p_elo_before  INTEGER,
  p_doubles     BOOLEAN
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
  v_pairs         INTEGER;
  v_unpaired      INTEGER;
  v_before        INTEGER;
  v_after         INTEGER;
  v_singles       INTEGER;
  v_entries       INTEGER;
BEGIN
  -- 00126's shape: a SECURITY DEFINER function that accepts the player it should
  -- act as is an impersonation primitive the moment it is reachable with an
  -- `authenticated` key. The grant below says service_role only; this makes a
  -- future mis-grant harmless rather than catastrophic. The service role has no
  -- auth.uid(), so the real caller passes straight through.
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  IF p_elo_before IS NULL THEN
    -- The caller refuses this before it gets here; belt and braces, because a
    -- null Elo written into the snapshot column is the thing seeding, the pool
    -- display and the legacy undo path all read back as fact.
    RAISE EXCEPTION 'enter_tournament_event: p_elo_before may not be null';
  END IF;

  -- The event row is the lock for the whole entry, so the status check and the
  -- three counts below all see a state no other ENTRY can move.
  --
  -- IT DOES NOT FENCE THE DRAW, and nothing at this end could: draw generation
  -- is 40+ separate PostgREST round trips ending in the status flip, so the row
  -- is unlocked long before it finishes. An entry that lands mid-generation is
  -- admitted here — correctly, the event is still open — and would not be in
  -- the bracket. That half is handled in the admin app by assertFieldDidNotGrow
  -- (tournament-actions/_internal.ts), which re-counts the field immediately
  -- before the draw is published and refuses to publish one that a late entry
  -- has already made wrong.
  SELECT e.status::TEXT, e.max_participants, e.tournament_id
    INTO v_status, v_max, v_tournament
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

      -- doublesDrawSlots: two unpaired entrants amount to one prospective team,
      -- rounded UP because a single loose person still needs a slot.
      v_before := v_pairs + CEIL(v_unpaired / 2.0);
      v_after  := v_pairs + CEIL((v_unpaired + 1) / 2.0);

      -- wouldExceedCapacity: over the limit AND worse than before, so an event
      -- that is already over its own limit does not have slot-neutral
      -- operations refused.
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

  -- ---- per-member entry cap (00098) -----------------------------------
  SELECT max_events_per_player INTO v_cap FROM tournaments WHERE id = v_tournament;
  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    -- Counted across BOTH tables, because a member who is half of a formed pair
    -- has no tournament_participants row at all. A pair whose two halves are
    -- the same player is charged once, matching countEventEntriesPerPlayer.
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
    -- UNIQUE (event_id, player_id) has always decided this; the caller's own
    -- read of the existing row is what produces the two different sentences
    -- (withdrawn vs already registered), so this is only the retry case.
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'already_registered');
  END;

  RETURN jsonb_build_object('ok', TRUE);
END;
$function$;

REVOKE ALL ON FUNCTION public.enter_tournament_event(UUID, UUID, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enter_tournament_event(UUID, UUID, INTEGER, BOOLEAN) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
