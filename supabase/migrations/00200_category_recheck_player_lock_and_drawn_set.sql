-- ===========================================================================
-- 00200 — THREE THINGS THE ROUND-8 REVIEW LEFT OPEN, CLOSED BY DECISION
-- ===========================================================================
--
-- Codex ruled these three still open after 00199. All three were deliberate
-- non-changes at the time, each with a written justification; the club owner
-- read them and chose to close all three. They are features here, not risk
-- reversals, and the justifications they replace are recorded below only so
-- that the reasoning is not lost.
--
--   1. THE COMPETITION CATEGORY IS RE-ASKED UNDER THE LOCK.
--   2. THE MEMBER'S ROW IS LOCKED WHILE IT IS READ.
--   3. PUBLICATION COMPARES THE DRAWN SET, NOT A ROW COUNT.
--
--
-- 1 + 2. WHY THEY ARE ONE CHANGE
-- ------------------------------
-- The category gate (00111) runs in the player app, hundreds of milliseconds
-- before the entry lands. An exec may set a member's competition_category in
-- that window — updatePlayer is the only route to it since 00129 — and
-- enter_tournament_event never asked again. The result is an entry in a
-- gendered draw that the same screen would refuse if it ran once more.
--
-- Re-asking is only worth anything if the answer cannot move between the ask
-- and the insert, and the members's row was being read WITHOUT a lock. So the
-- recheck and the row lock are the same fix: FOR SHARE on the players row,
-- held to commit, is what makes the exec's UPDATE queue behind this entry
-- instead of racing it. One without the other closes nothing.
--
-- LOCK ORDER — AND WHY players STAYS WHERE IT IS.
-- The obvious move is to lock the member first, since the function is about
-- them. It is the wrong move. merge_players takes tournaments before it takes
-- the removed member's own row:
--
--     UPDATE tournaments SET created_by = p_keep WHERE created_by = p_remove;
--     ...
--     DELETE FROM players WHERE id = p_remove;
--
-- so a fence that took players first and tournaments second would be the other
-- half of a cycle. Read in the position it already occupies — after the
-- tournament row, before the event row — this function agrees with merge on
-- the only pair they share. The order across the schema is therefore:
--
--     advisory field lock -> tournaments -> players -> tournament_events
--
-- ONE NARROW RESIDUAL, STATED RATHER THAN PAPERED OVER. merge_players opens
-- with `UPDATE players SET banned_by = p_keep WHERE banned_by = p_remove`,
-- which locks THIRD-PARTY rows before it reaches the tournaments update. If
-- the member entering happens to be one of those rows — that is, if they were
-- banned by the exact player being merged away — and a merge runs at the same
-- instant, the two can deadlock. Postgres detects it, aborts one side with
-- 40P01, and nothing is corrupted; the entry is retried. It is not worth
-- reordering an applied migration for, and a banned member's entry is refused
-- a few lines further down regardless.
--
-- WHAT THE FUNCTION RETURNS. A reason code and nothing else — never the
-- member's category. screenSelfEntry's own comment explains why the mismatch
-- sentence names the event and not the person, and a fence that leaked the
-- value would undo that. The app rebuilds the sentence from the event type it
-- already holds, through categoryRefusalMessage, so a member who loses the
-- race reads the same words as one who never entered it.
--
-- MIXED IS NOT A HOLE. mixed_doubles takes either declared category, so the
-- only thing it refuses is an undeclared entrant — the person auto-pairing
-- would have to leave sitting there. That is screenSelfEntry's rule, repeated
-- here, not a stricter one.
--
-- THE CONSOLE IS DELIBERATELY NOT TOUCHED. add_participants_under_field_lock
-- reads no players columns at all and none are added here. An exec adding
-- somebody by hand is an explicit override by a named person — the line
-- screenConsoleEntry already draws — and giving the console fence a players
-- lock would widen the deadlock surface to buy nothing.
--
--
-- 3. THE DRAWN SET
-- ----------------
-- publish_event_draw compared COUNTS: the number of live entrants now against
-- the number the draw was built from. Two consequences, one of them worse than
-- the finding that prompted this.
--
--   * POOL-SEEDED DRAWS COULD NOT BE CHECKED AT ALL. Their field is the
--     qualifiers, a subset of everyone registered, so a live count of the
--     participant table is not the number the draw was built from. The caller
--     passed p_expected => null and publication asserted nothing.
--
--   * A COUNT CANNOT SEE A SWAP. One entrant withdraws and another enters
--     while a draw is being generated: the count is unchanged, publication
--     succeeds, and the bracket contains a fixture for somebody who has left
--     and none for somebody who is in the event. NOBODY ASKED FOR THIS ONE —
--     it fell out of comparing sets instead of totals, and it is the stronger
--     reason for the change.
--
-- p_expected INTEGER is therefore replaced by the ids themselves:
--
--     p_entrants    UUID[]   the participant or pair rows this draw was built
--                            from, in any order
--     p_whole_field BOOLEAN  true when those ids are supposed to BE the field
--
-- Both directions are checked when p_whole_field is true. Only the first is
-- checked when it is false, because a pool-seeded draw is a subset by
-- construction and the members who did not qualify are still registered.
--
--     someone in the draw is no longer live  ->  'entrant_left'
--     someone live is not in the draw        ->  'field_grew'   (whole field only)
--
-- 'field_grew' KEEPS ITS NAME AND ITS SENTENCE. The situation an exec meets is
-- unchanged and so is the remedy. 'entrant_left' is new and needs its own,
-- because the cost of this change is that a legitimate late withdrawal now
-- refuses a publication that used to go through. That is acceptable only
-- because the remedy is pressing Generate again, so the message says exactly
-- that and nothing vaguer.
--
-- THE SIGNATURE CHANGE IS A DROP, NOT A REPLACE. Leaving the old
-- (uuid,text,boolean,integer,text,uuid) overload in place would give PostgREST
-- two candidates for one name, and it resolves that by refusing the call. The
-- verification block asserts it is gone.

BEGIN;

-- ===========================================================================
-- enter_tournament_event — the member's row locked, the category re-asked
-- ===========================================================================

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
  v_event_type    TEXT;
  v_category      TEXT;
  v_required      TEXT;
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
  -- that did so without asking. Taken before the row locks so the whole schema
  -- acquires these in one order; see the header for why that is the safe
  -- direction and not merely a convention.
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

  -- THE MEMBER'S OWN FACTS, NOW UNDER A LOCK (00200). This read used to be
  -- unlocked and the header explained why that was tolerable: a ban or a
  -- membership change landing in the window is a change an exec makes and can
  -- see. That argument never covered competition_category, which is read below
  -- and decides whether this entry is legal at all, so the row is now held
  -- FOR SHARE until this transaction commits. An exec's updatePlayer queues
  -- behind the entry rather than racing it.
  --
  -- FOR SHARE, not FOR UPDATE: several members entering different events at
  -- once must not serialise on each other, and share locks do not conflict
  -- with each other. It is UPDATE that has to wait, and FOR SHARE is enough
  -- to make it.
  --
  -- Position matters — see the header. players is read after tournaments
  -- because merge_players takes them in that order, and reversing it here
  -- would close a cycle.
  SELECT p.is_banned, p.membership_type, p.competition_category::TEXT
    INTO v_banned, v_membership, v_category
    FROM players p WHERE p.id = p_player_id FOR SHARE;

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
  -- the duplicate check must see a state no other entry can move. event_type
  -- joins the read in 00200 — the category gate below is about what THIS event
  -- requires, so it has to come off the locked row rather than from an argument
  -- the caller chose.
  SELECT e.status::TEXT, e.max_participants, e.event_type::TEXT
    INTO v_status, v_max, v_event_type
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_status <> 'registration' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'registration_closed', 'status', v_status);
  END IF;

  -- ---- the competition category, re-asked under the lock (00200) -------
  --
  -- categoryRequiredBy, in plpgsql. The open events return NULL and reach
  -- none of this, which is the property that keeps an undeclared member
  -- playing the club's tournaments.
  v_required := CASE v_event_type
                  WHEN 'mens_singles'   THEN 'mens'
                  WHEN 'mens_doubles'   THEN 'mens'
                  WHEN 'womens_singles' THEN 'womens'
                  WHEN 'womens_doubles' THEN 'womens'
                  WHEN 'mixed_doubles'  THEN 'mixed'
                  ELSE NULL
                END;

  IF v_required IS NOT NULL THEN
    -- screenSelfEntry, in plpgsql, and stricter than the console on purpose:
    -- an undeclared member is refused as well as a mismatched one. Every
    -- member is undeclared the day 00111 applies, so a rule that admitted them
    -- would enforce nothing at all on the day it shipped.
    IF v_category IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'category_undeclared',
                                'event_type', v_event_type);
    END IF;
    -- Mixed takes either declared category — the pair rule does the rest.
    IF v_required <> 'mixed' AND v_category <> v_required THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'category_mismatch',
                                'event_type', v_event_type);
    END IF;
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

-- ===========================================================================
-- publish_event_draw — the drawn SET, in both directions
-- ===========================================================================

DROP FUNCTION IF EXISTS public.publish_event_draw(uuid, text, boolean, integer, text, uuid);

CREATE OR REPLACE FUNCTION public.publish_event_draw(
  p_event_id    UUID,
  p_new_status  TEXT,
  p_doubles     BOOLEAN,
  p_entrants    UUID[],
  p_whole_field BOOLEAN,
  p_phase       TEXT,
  p_generation  UUID
)
RETURNS JSONB
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

REVOKE ALL ON FUNCTION public.publish_event_draw(uuid, text, boolean, uuid[], boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_event_draw(uuid, text, boolean, uuid[], boolean, text, uuid) TO service_role;

-- ===========================================================================
-- Verification
-- ===========================================================================
--
-- READS THE BODIES, not merely the signatures. Every one of these properties
-- is one a later CREATE OR REPLACE could drop while leaving a function that
-- still exists, takes the same arguments and answers the same questions — an
-- existence check would pass over all of it.

DO $verify$
DECLARE
  v_bad  TEXT[] := ARRAY[]::TEXT[];
  v_oid  oid;
  v_src  TEXT;
  r      RECORD;
BEGIN
  -- ---- the replaced publish signature must be GONE --------------------
  -- Two candidates for one name is a call PostgREST refuses rather than
  -- resolves, so an overload left behind does not degrade — it breaks every
  -- publication.
  IF to_regprocedure('public.publish_event_draw(uuid,text,boolean,integer,text,uuid)') IS NOT NULL THEN
    v_bad := array_append(v_bad, 'publish_event_draw(...,integer,text,uuid) still exists');
  END IF;
  IF to_regprocedure('public.publish_event_draw(uuid,text,boolean,integer)') IS NOT NULL THEN
    v_bad := array_append(v_bad, 'publish_event_draw(uuid,text,boolean,integer) still exists');
  END IF;

  -- ---- enter_tournament_event ------------------------------------------
  v_oid := to_regprocedure('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)');
  IF v_oid IS NULL THEN
    v_bad := array_append(v_bad, 'enter_tournament_event(uuid,uuid,integer,boolean,text,text) missing');
  ELSE
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;

    -- The row lock is the whole of change 2. Without it the recheck below
    -- reads a value an exec can still move before this transaction commits.
    IF v_src !~ 'FROM players p WHERE p\.id = p_player_id FOR SHARE' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: players row is not locked FOR SHARE');
    END IF;

    -- ORDER. players must be read AFTER the tournaments lock — see the header:
    -- merge_players takes tournaments before it takes the member's own row, so
    -- reversing these two closes a cycle.
    IF position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src) = 0
       OR position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src)
          > position('FROM players p WHERE p.id = p_player_id FOR SHARE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: players is locked before tournaments');
    END IF;

    -- The advisory lock still precedes both, which is what 00196 and 00198
    -- established and what every other writer of this field agrees to.
    IF position('pg_advisory_xact_lock' in v_src) = 0
       OR position('pg_advisory_xact_lock' in v_src)
          > position('FROM tournaments t WHERE t.id = v_tournament FOR UPDATE' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: advisory lock missing or not first');
    END IF;

    -- The recheck itself, and that it reads the event type off the LOCKED row
    -- rather than from an argument the caller chose.
    IF v_src NOT LIKE '%category_undeclared%' OR v_src NOT LIKE '%category_mismatch%' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: competition category is not re-checked');
    END IF;
    IF v_src !~ 'e\.event_type::TEXT[^;]*FROM tournament_events e WHERE e\.id = p_event_id FOR UPDATE' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: event_type does not come off the locked row');
    END IF;
    IF position('FROM players p WHERE p.id = p_player_id FOR SHARE' in v_src)
       > position('category_undeclared' in v_src) THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: category is checked before the row is locked');
    END IF;

    -- The refusal must not carry the member's category back to the caller.
    -- screenSelfEntry's disclosure property is the reason the sentence names
    -- the event and not the person; a fence that returned v_category would
    -- undo it everywhere the app shows a refusal.
    --
    -- Catches the obvious shape and only that. A reviewer inventing a new key
    -- name for the same value gets past it, which is why the rule is written
    -- in the header as well: the reason code is the whole payload.
    IF v_src ~ 'v_category' AND v_src ~ 'jsonb_build_object[^;]*v_category' THEN
      v_bad := array_append(v_bad, 'enter_tournament_event: refusal leaks the member category');
    END IF;
  END IF;

  -- ---- publish_event_draw ----------------------------------------------
  v_oid := to_regprocedure('public.publish_event_draw(uuid,text,boolean,uuid[],boolean,text,uuid)');
  IF v_oid IS NULL THEN
    v_bad := array_append(v_bad, 'publish_event_draw(uuid,text,boolean,uuid[],boolean,text,uuid) missing');
  ELSE
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;

    -- Both directions, and the empty-array guard that stops the whole check
    -- degrading back into the null-means-do-not-check shape it replaced.
    IF v_src NOT LIKE '%entrant_left%' THEN
      v_bad := array_append(v_bad, 'publish_event_draw: does not check for entrants who left');
    END IF;
    IF v_src NOT LIKE '%field_grew%' THEN
      v_bad := array_append(v_bad, 'publish_event_draw: does not check for entrants who arrived');
    END IF;
    IF v_src NOT LIKE '%p_entrants may not be null or empty%' THEN
      v_bad := array_append(v_bad, 'publish_event_draw: empty entrant list is not refused');
    END IF;
    -- The generation checks 00197 added must still be here. This function is
    -- being replaced wholesale, so they are exactly what a careless rewrite
    -- drops.
    IF v_src NOT LIKE '%superseded%' OR v_src NOT LIKE '%foreign_matches%' OR v_src NOT LIKE '%no_matches%' THEN
      v_bad := array_append(v_bad, 'publish_event_draw: lost a 00197 generation check');
    END IF;
  END IF;

  -- ---- 00198 and 00199 are still standing -------------------------------
  -- Both were replaced-in-place fences whose whole value is a lock this
  -- migration does not touch and could not notice losing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tg
     WHERE tg.tgrelid = 'public.tournament_matches'::regclass
       AND tg.tgname = 'trg_tournament_match_generation'
       AND NOT tg.tgisinternal
  ) THEN
    v_bad := array_append(v_bad, '00197/00198 generation trigger is no longer attached');
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      ('public.add_participants_under_field_lock(uuid,uuid,jsonb)'),
      ('public.promote_pool_qualifier(uuid,boolean,uuid,uuid,text,integer,integer,uuid,timestamptz)')
    ) AS t(sig)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, r.sig || ' missing');
    ELSE
      SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
      IF v_src NOT LIKE '%pg_advisory_xact_lock%' THEN
        v_bad := array_append(v_bad, r.sig || ': no longer takes the field lock');
      END IF;
    END IF;
  END LOOP;

  -- ---- grants ------------------------------------------------------------
  FOR r IN
    SELECT * FROM (VALUES
      ('public.enter_tournament_event(uuid,uuid,integer,boolean,text,text)'),
      ('public.publish_event_draw(uuid,text,boolean,uuid[],boolean,text,uuid)')
    ) AS t(sig)
  LOOP
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NOT NULL THEN
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
    RAISE EXCEPTION E'00200 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
END;
$verify$;

-- PostgREST caches the signature of every function it exposes. publish_event_draw
-- changed shape, so without this the API keeps offering the dropped one and every
-- publication 404s until the schema cache happens to refresh.
NOTIFY pgrst, 'reload schema';

COMMIT;
