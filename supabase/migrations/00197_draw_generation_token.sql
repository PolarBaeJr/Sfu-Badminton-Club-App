-- 00197 — a draw generation is a claim, and a superseded claim cannot write
--         (F-005 residual)
--
-- 00193 made the PUBLICATION of a draw atomic: the field re-count and the status
-- flip happen under one lock on the event row, so an entry arriving mid-build is
-- either refused or forces the publish to refuse. Its own header conceded what it
-- did not close, in as many words: "Draw GENERATION remains dozens of separate
-- round trips; only its publication is atomic."
--
-- That concession is the whole finding. A generation is: delete this phase's
-- matches, then INSERT sixty-odd rows over PostgREST one round trip at a time,
-- then publish. The advisory lock delete_phase_matches (00144) takes is an
-- xact lock, so it is gone the instant that DELETE commits — 00144's header says
-- so explicitly — and every INSERT that follows is unfenced. Two execs pressing
-- Generate on the same event therefore interleave:
--
--   A deletes and starts inserting. B deletes (taking A's rows with it) and
--   starts inserting. B finishes and publishes. A's remaining INSERTs land
--   afterwards, into a draw that is already live.
--
-- Most of A's late rows collide with B's on tournament_matches_draw_position_idx
-- (00107) and fail, which is why this has not obviously broken anything. That is
-- luck, not a guarantee: the index is UNIQUE on (event_id, phase, round_number,
-- bracket_position), so it only saves us while both generators build the SAME
-- position space. Let the field shrink between A and B — one withdrawal is
-- enough — and A's bracket is larger than B's, A's surplus positions collide
-- with nothing, and they land in B's published draw as fixtures nobody scheduled
-- and no round can reach. Nothing says so, and 00193's publish fence cannot see
-- it because it already committed.
--
-- THE FIX IS A TOKEN, NOT A LONGER LOCK. A lock cannot be the answer here: the
-- generation spans dozens of separate transactions, and no lock survives a
-- COMMIT. What CAN span them is a claim recorded on the event row.
--
--   * delete_phase_matches claims one — a fresh uuid on tournament_events —
--     in the same transaction as the DELETE, under the advisory lock it already
--     takes. Claiming and clearing are one act, so there is no window in which
--     the old draw is gone and no generation owns the event.
--   * Every match the generator inserts carries the claim it was issued.
--   * A BEFORE INSERT trigger refuses any stamped row whose claim is not the
--     event's current one. This is the part a function cannot do: match rows are
--     inserted by the application straight through PostgREST, not through an
--     RPC, so the fence has to live on the table.
--   * publish_event_draw refuses a publication whose claim has moved on.
--
-- Every interleaving now ends the same way: whoever claimed last is the only one
-- who can write, and the loser is refused rather than silently half-applied. The
-- operator presses Generate again, which is the recovery path 00144 already
-- relies on and the reason a partial generation is benign.
--
-- WHY THE TRIGGER ONLY FIRES ON A STAMPED ROW. An INSERT with a NULL
-- draw_generation_id passes untouched. That is deliberate and it is not a hole:
-- the fence exists to stop a SUPERSEDED GENERATOR, and the only thing that
-- stamps is the generator. Making NULL an error would break every other way a
-- match row can be created, present or future, to protect against a caller that
-- was never racing. Making the trigger stamp NULL rows with the current
-- generation would be worse — it would launder exactly the late write this is
-- built to refuse.
--
-- WHY THE CLAIM IS PER EVENT AND NOT PER PHASE. delete_phase_matches has always
-- taken an EVENT-scoped advisory lock even though it deletes one phase, so the
-- event is already the unit this codebase serializes draws on. Generating the
-- pool and the knockout of one event at literally the same moment is refused
-- rather than interleaved. That is a real behaviour change, it costs one
-- re-press, and two execs doing that simultaneously is the case least worth
-- optimising for.
--
-- WHAT PUBLISH NOW ASSERTS, which is the other half of the finding. It had no
-- post-generation invariant at all: it re-counted the FIELD and flipped the
-- status without ever looking at what was built. It now also refuses a phase
-- holding a match from another generation (impossible while the trigger stands —
-- which is the point of asserting it, since the assertion is what would notice
-- the trigger being dropped) and refuses to publish a phase with no matches in
-- it, which no legitimate draw has: both generators refuse fewer than two
-- entrants, so every real draw has at least one match.
--
-- THE FOUR-ARGUMENT publish_event_draw IS DROPPED rather than left beside the
-- new one, for 00193's reason: a call omitting the generation would bind to it
-- exactly and publish unfenced. With it gone, an old image mid-deploy fails
-- loudly at the publish step instead, leaving matches behind that pressing
-- Generate again clears. delete_phase_matches keeps its argument list, so the
-- same old image still deletes normally; it simply stamps nothing, and an
-- unstamped generation is exactly as fenced as it is today.

BEGIN;

ALTER TABLE public.tournament_events
  ADD COLUMN IF NOT EXISTS draw_generation_id UUID;
COMMENT ON COLUMN public.tournament_events.draw_generation_id IS
  'The draw generation currently entitled to write matches for this event. Claimed by delete_phase_matches; enforced by the BEFORE INSERT trigger on tournament_matches and by publish_event_draw (00197).';

ALTER TABLE public.tournament_matches
  ADD COLUMN IF NOT EXISTS draw_generation_id UUID;
COMMENT ON COLUMN public.tournament_matches.draw_generation_id IS
  'The generation that inserted this row. NULL for rows created outside draw generation, which are not fenced (00197).';

-- The trigger reads this for every inserted match; a bracket is sixty-odd rows.
CREATE INDEX IF NOT EXISTS idx_tournament_matches_generation
  ON public.tournament_matches (event_id, draw_generation_id);

-- ===========================================================================
-- delete_phase_matches — tear the phase down and claim the next generation
-- ===========================================================================
--
-- The return type changes from integer to jsonb, so the old one has to go. Its
-- ARGUMENTS are unchanged, which is what matters for a rolling deploy: an old
-- image's call still resolves here and still succeeds, it just ignores a
-- payload instead of a count.
DROP FUNCTION IF EXISTS public.delete_phase_matches(uuid, text);

CREATE OR REPLACE FUNCTION public.delete_phase_matches(
  p_event_id uuid,
  p_phase    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deleted    integer;
  v_played     integer;
  v_rated      integer;
  v_live       integer;
  v_generation uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  -- ONE STATEMENT. The rows counted below are the rows this DELETE actually
  -- removed, under its own locks, in its own snapshot — not the rows some
  -- earlier SELECT thought were there.
  WITH gone AS (
    DELETE FROM tournament_matches
     WHERE event_id = p_event_id
       AND (p_phase IS NULL OR phase = p_phase)
    RETURNING status, is_bye, elo_snapshot
  )
  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE is_bye IS NOT TRUE
        AND status IN ('completed', 'walkover', 'disputed')
    )::integer,
    count(*) FILTER (WHERE elo_snapshot IS NOT NULL)::integer,
    count(*) FILTER (WHERE is_bye IS NOT TRUE AND status = 'live')::integer
  INTO v_deleted, v_played, v_rated, v_live
  FROM gone;

  -- Each RAISE aborts the transaction, so the DELETE above is rolled back with
  -- it. Ordered by what the exec should deal with first, and each one names a
  -- REACHABLE remedy — a refusal an exec cannot act on is a dead end.
  IF v_played > 0 THEN
    RAISE EXCEPTION
      '% match% in this draw % a result, and rebuilding the draw deletes every match — including %. Void or undo % first if the draw really has to be rebuilt. Byes do not count towards this.',
      v_played,
      CASE WHEN v_played = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_played = 1 THEN 'has' ELSE 'have' END,
      CASE WHEN v_played = 1 THEN 'that one' ELSE 'those' END,
      CASE WHEN v_played = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reached only by a match whose status says it is finished with while its row
  -- still carries the delta — the void-racing-a-result shape at results.ts:623.
  -- "Void it first" would be a dead end here because it IS already voided, so
  -- the message names the two-step that actually reverses the rating.
  IF v_rated > 0 THEN
    RAISE EXCEPTION
      '% match% in this draw still carr% an applied rating that was never reversed, and deleting % would leave that rating on the ladder with no way to take it back. Unvoid then undo % first.',
      v_rated,
      CASE WHEN v_rated = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_rated = 1 THEN 'ies' ELSE 'y' END,
      CASE WHEN v_rated = 1 THEN 'it' ELSE 'them' END,
      CASE WHEN v_rated = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_live > 0 THEN
    RAISE EXCEPTION
      '% match% in this draw % being played right now. Rebuilding the draw would delete % mid-game. Undo the start on the Court Management tab first, or wait for the result.',
      v_live,
      CASE WHEN v_live = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_live = 1 THEN 'is' ELSE 'are' END,
      CASE WHEN v_live = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  -- THE CLAIM, in the same transaction as the teardown and under the same
  -- advisory lock (00197). It is issued AFTER the three refusals on purpose: a
  -- generation that is not allowed to proceed must not take the event's
  -- generation away from one that is.
  v_generation := gen_random_uuid();
  UPDATE tournament_events
     SET draw_generation_id = v_generation
   WHERE id = p_event_id;

  RETURN jsonb_build_object('deleted', v_deleted, 'generation', v_generation);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_phase_matches(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_phase_matches(uuid, text) TO service_role;

-- ===========================================================================
-- The fence itself — on the table, because the writes are not through an RPC
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
  -- Unstamped rows are not fenced. See the header: the fence is for superseded
  -- generators, and only a generator stamps.
  IF NEW.draw_generation_id IS NULL THEN
    RETURN NEW;
  END IF;

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

DROP TRIGGER IF EXISTS trg_tournament_match_generation ON public.tournament_matches;
CREATE TRIGGER trg_tournament_match_generation
  BEFORE INSERT ON public.tournament_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.tournament_match_generation_is_current();

-- ===========================================================================
-- publish_event_draw — the field count, the generation, and what was built
-- ===========================================================================
DROP FUNCTION IF EXISTS public.publish_event_draw(uuid, text, boolean, integer);

CREATE OR REPLACE FUNCTION public.publish_event_draw(
  p_event_id   UUID,
  p_new_status TEXT,
  p_doubles    BOOLEAN,
  p_expected   INTEGER,
  p_phase      TEXT,
  p_generation UUID
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

  -- WHAT WAS ACTUALLY BUILT (00197). Publication used to assert nothing at all
  -- about the matches — only about the field they were built from.
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE m.draw_generation_id IS DISTINCT FROM p_generation)
    INTO v_matches, v_foreign
    FROM tournament_matches m
   WHERE m.event_id = p_event_id
     AND (p_phase IS NULL OR m.phase = p_phase);

  -- A NULL STAMP COUNTS AS FOREIGN HERE, and deliberately does NOT match the
  -- judgement the trigger makes twenty lines up. This was briefly narrowed to
  -- `IS NOT NULL AND <> p_generation` on the argument that the two halves of
  -- this migration ought to agree — that an unstamped row was not written by a
  -- generator, so it is not evidence of a race. THAT ARGUMENT WAS WRONG and the
  -- round-7 review caught it.
  --
  -- The counter-example is the deploy window this migration already documents.
  -- An image built before 00197, running against a database that HAS 00197,
  -- still calls delete_phase_matches (the argument list was kept compatible on
  -- purpose), ignores the JSON generation it now returns, and inserts rows with
  -- no stamp. The trigger lets those through by design. So "unstamped" does not
  -- mean "not written by a generator" — during a rolling deploy it means
  -- "written by the OLD generator", which is exactly the contamination this
  -- check exists to catch. If one such row lands after a new generator's
  -- teardown and before its publish, the narrowed predicate publishes a mixed
  -- draw and says ok.
  --
  -- The justification for narrowing was also weaker than it was written: a
  -- refusal here does not block the phase "forever". Pressing Generate again
  -- tears the phase down — unstamped rows included — and rebuilds it with every
  -- row stamped. A refusal the desk can clear by repeating the action it just
  -- took is the correct failure for a suspected race.
  --
  -- Safe against false refusals under all-new code: all three insert sites in
  -- brackets.ts (856, 1223, 1759) stamp, so no unstamped row is ever produced
  -- by this image.
  --
  -- Narrowing costs nothing the check was there for. A superseded generator
  -- always stamps — that is what makes it superseded — so if the trigger is
  -- ever dropped, its rows still arrive with a claim that is NOT NULL and NOT
  -- this one, and are still caught here.
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

REVOKE ALL ON FUNCTION public.publish_event_draw(uuid, text, boolean, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_event_draw(uuid, text, boolean, integer, text, uuid) TO service_role;

DO $verify$
DECLARE
  v_bad TEXT[] := ARRAY[]::TEXT[];
  v_oid oid;
  r RECORD;
BEGIN
  -- The unfenced publish signature must be gone, not merely superseded.
  IF to_regprocedure('public.publish_event_draw(uuid,text,boolean,integer)') IS NOT NULL THEN
    v_bad := array_append(v_bad, 'publish_event_draw(uuid,text,boolean,integer) still exists');
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('public.delete_phase_matches(uuid,text)'),
      ('public.publish_event_draw(uuid,text,boolean,integer,text,uuid)')
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

  -- The trigger is the only part of this that a superseded generator's INSERT
  -- goes through, so its absence is the failure that would leave everything
  -- else looking correct.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'tournament_matches'
      AND t.tgname = 'trg_tournament_match_generation'
      AND NOT t.tgisinternal
  ) THEN
    v_bad := array_append(v_bad, 'trg_tournament_match_generation is not on tournament_matches');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournament_events'
       AND column_name = 'draw_generation_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournament_matches'
       AND column_name = 'draw_generation_id'
  ) THEN
    v_bad := array_append(v_bad, 'draw_generation_id missing from one of the two tables');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00197 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00197: a superseded draw generation can no longer write.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
