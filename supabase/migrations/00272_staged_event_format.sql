-- ============================================================
-- 00272: AN EVENT PLAYED IN STAGES
--
-- A fourth format, 'staged': the organiser writes the event as a list of stages
-- (groups, a knockout, or named matches), each fed by the field or by named
-- slots out of the stages before it. The definition is data on the event
-- (format_config, version 1, validated by formatConfigSchema in
-- packages/shared); this migration gives it somewhere to live and somewhere to
-- put its matches. The three legacy formats are untouched.
--
-- WHAT CHANGES.
--   * tournament_events: format_config, current_stage, rated. 'staged' joins the
--     format CHECK, and a staged event must carry a version 1 object.
--   * rated: the event-wide "does this move ratings" switch. An external event
--     is always unrated (owner decision 6), so every existing external event is
--     set false and the external shape CHECK now says so. The external fence
--     trigger sets it on the way in, so an insert that does not know the column
--     (an image older than this file) still lands.
--   * tournament_pairs.team_category: the category a team plays as (mens,
--     womens, mixed or an organiser's own key), read for head starts.
--   * tournament_matches: stage (1-based index into format_config.stages),
--     pool_number, group_number, slot, match_label and the head start each side
--     started every game on (handicap_a/b, a snapshot taken when the stage was
--     drawn). A staged match has a stage and no phase; a legacy match the
--     reverse.
--   * The draw-position and one-third-place indexes are narrowed to stage IS
--     NULL, which is every existing row, so legacy uniqueness is unchanged; a
--     staged stage gets the same two guarantees per stage, and a label is
--     unique within its stage.
--
-- NEW FUNCTIONS (service_role only).
--   * delete_stage_matches(event, stage): 00197's delete_phase_matches for one
--     stage. Same refusals (played, rated, live), plus: a stage cannot be torn
--     down while a later stage has matches, since the later stage was drawn
--     from it. Claims the event's draw generation, as 00197 does.
--   * staged_source_fingerprint(event, stage): event_results_fingerprint over
--     the stages before `stage` only, plus the entries that have left the
--     event. A later stage is drawn from those results, so publication
--     compares them under the lock.
--   * publish_stage_draw(...): 00202's publish_event_draw for one stage. Stage 1
--     is fenced on the field exactly as a legacy draw is (entrant_left,
--     entrant_changed, field_grew, same digest keys); a later stage on the
--     source fingerprint. Sets current_stage. Stage 1 leaves the event at
--     bracket_generated, or live if it was live (a redraw never sends an event
--     backwards); a later stage needs the event live and leaves it there.
--
-- CHANGED FUNCTIONS.
--   * event_results_fingerprint (00213) also carries the stage columns and the
--     head starts, so finalisation sees a stage's results move.
--   * delete_phase_matches (00197) refuses a staged event: its NULL phase means
--     "every match", which on a staged event is every stage.
--   * tournament_matches_external_unrated (00269) also refuses a rating on an
--     event with rated = false, and on a stage whose config says rated false.
--   * tournament_events_external_fence (00269) keeps rated = false on an
--     external event, and restores true when an empty event stops being one.
--
-- ROLLING DEPLOY. Nothing here renames or drops anything a running image
-- calls. New code probes for format_config and says "Run migration 00272
-- first" when it is missing.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. tournament_events
-- ============================================================
ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS format_config jsonb;
ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS current_stage smallint;
ALTER TABLE public.tournament_events ADD COLUMN IF NOT EXISTS rated boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.tournament_events.format_config IS
  'The stage definition of a staged event (00272), version 1, as formatConfigSchema in packages/shared validates it. NULL on the legacy formats.';
COMMENT ON COLUMN public.tournament_events.current_stage IS
  'The latest stage of a staged event that has been drawn, 1-based (00272). Written by publish_stage_draw.';
COMMENT ON COLUMN public.tournament_events.rated IS
  'Whether this event moves ratings at all (00272). Always false on an external event.';

ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_format_check;
ALTER TABLE public.tournament_events ADD CONSTRAINT tournament_events_format_check
  CHECK (format IN ('single_elimination', 'round_robin', 'pool_to_bracket', 'staged'));

ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_staged_config;
ALTER TABLE public.tournament_events ADD CONSTRAINT tournament_events_staged_config
  CHECK (format <> 'staged' OR (
    format_config IS NOT NULL
    AND jsonb_typeof(format_config) = 'object'
    AND format_config->>'version' = '1'
  ));

ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_current_stage_range;
ALTER TABLE public.tournament_events ADD CONSTRAINT tournament_events_current_stage_range
  CHECK (current_stage IS NULL OR current_stage BETWEEN 1 AND 8);

-- Before the CHECK below, which requires it.
UPDATE public.tournament_events SET rated = false WHERE external_event AND rated;

ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_external_event_shape;
ALTER TABLE public.tournament_events ADD CONSTRAINT tournament_events_external_event_shape
  CHECK (NOT external_event OR (
    format IN ('round_robin', 'staged')
    AND event_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles')
    AND placement_bonus_enabled IS NOT TRUE
    AND seeded_from_event_id IS NULL
    AND rated = false
  ));

-- 00269's body, plus the two lines that keep rated in step with external_event.
-- A BEFORE trigger runs before the CHECK, so an insert of an external event that
-- does not mention rated is made valid here rather than refused.
CREATE OR REPLACE FUNCTION public.tournament_events_external_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.external_event IS DISTINCT FROM OLD.external_event THEN
    IF EXISTS (SELECT 1 FROM tournament_pairs WHERE event_id = NEW.id)
       OR EXISTS (SELECT 1 FROM tournament_participants WHERE event_id = NEW.id)
       OR EXISTS (SELECT 1 FROM tournament_matches WHERE event_id = NEW.id) THEN
      RAISE EXCEPTION 'An event with entries or matches cannot be switched to or from an external event.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.seeded_from_event_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tournament_events s WHERE s.id = NEW.seeded_from_event_id AND s.external_event
  ) THEN
    RAISE EXCEPTION 'An external event cannot seed another event.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 00272. An external event is unrated; an empty event that stops being
  -- external goes back to the default.
  IF NEW.external_event THEN
    NEW.rated := false;
  ELSIF TG_OP = 'UPDATE' AND OLD.external_event THEN
    NEW.rated := true;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tournament_events_external_fence() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 2. tournament_pairs
-- ============================================================
ALTER TABLE public.tournament_pairs ADD COLUMN IF NOT EXISTS team_category text;
ALTER TABLE public.tournament_pairs DROP CONSTRAINT IF EXISTS tournament_pairs_team_category_len;
ALTER TABLE public.tournament_pairs ADD CONSTRAINT tournament_pairs_team_category_len
  CHECK (team_category IS NULL OR char_length(team_category) BETWEEN 1 AND 24);

COMMENT ON COLUMN public.tournament_pairs.team_category IS
  'The category this team plays as in a staged event (00272), a key of format_config.categories. Read for head starts.';

-- ============================================================
-- 3. tournament_matches
-- ============================================================
ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS stage smallint;
ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS pool_number smallint;
ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS group_number smallint;
ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS slot smallint;
ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS match_label text;
ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS handicap_a smallint NOT NULL DEFAULT 0;
ALTER TABLE public.tournament_matches ADD COLUMN IF NOT EXISTS handicap_b smallint NOT NULL DEFAULT 0;

ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_stage_range;
ALTER TABLE public.tournament_matches ADD CONSTRAINT tournament_matches_stage_range
  CHECK (stage IS NULL OR stage BETWEEN 1 AND 8);
ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_match_label_len;
ALTER TABLE public.tournament_matches ADD CONSTRAINT tournament_matches_match_label_len
  CHECK (match_label IS NULL OR char_length(match_label) BETWEEN 1 AND 40);
ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_handicap_range;
ALTER TABLE public.tournament_matches ADD CONSTRAINT tournament_matches_handicap_range
  CHECK (handicap_a BETWEEN 0 AND 29 AND handicap_b BETWEEN 0 AND 29);
-- Every existing row has stage NULL, so this validates in place whatever its phase.
ALTER TABLE public.tournament_matches DROP CONSTRAINT IF EXISTS tournament_matches_stage_or_phase;
ALTER TABLE public.tournament_matches ADD CONSTRAINT tournament_matches_stage_or_phase
  CHECK (stage IS NULL OR phase IS NULL);

COMMENT ON COLUMN public.tournament_matches.stage IS
  'The stage of a staged event this match belongs to, 1-based into format_config.stages (00272). NULL on every legacy match.';
COMMENT ON COLUMN public.tournament_matches.handicap_a IS
  'Points side A started every game on, snapshotted when the stage was drawn (00272). Scores include it.';
COMMENT ON COLUMN public.tournament_matches.handicap_b IS
  'Points side B started every game on, snapshotted when the stage was drawn (00272). Scores include it.';

-- The legacy guarantees, narrowed to the legacy rows. Every existing row has
-- stage NULL, so neither index loses an entry.
DROP INDEX IF EXISTS public.tournament_matches_draw_position_idx;
CREATE UNIQUE INDEX tournament_matches_draw_position_idx
  ON public.tournament_matches (event_id, COALESCE(phase, ''), round_number, bracket_position)
  WHERE NOT is_third_place AND stage IS NULL;

DROP INDEX IF EXISTS public.tournament_matches_one_third_place_per_event;
CREATE UNIQUE INDEX tournament_matches_one_third_place_per_event
  ON public.tournament_matches (event_id)
  WHERE is_third_place AND stage IS NULL;

-- The same two, per stage.
DROP INDEX IF EXISTS public.tournament_matches_stage_position_idx;
CREATE UNIQUE INDEX tournament_matches_stage_position_idx
  ON public.tournament_matches (event_id, stage, round_number, bracket_position)
  WHERE NOT is_third_place AND stage IS NOT NULL;

DROP INDEX IF EXISTS public.tournament_matches_one_third_place_per_stage;
CREATE UNIQUE INDEX tournament_matches_one_third_place_per_stage
  ON public.tournament_matches (event_id, stage)
  WHERE is_third_place AND stage IS NOT NULL;

DROP INDEX IF EXISTS public.tournament_matches_stage_label_idx;
CREATE UNIQUE INDEX tournament_matches_stage_label_idx
  ON public.tournament_matches (event_id, stage, match_label)
  WHERE match_label IS NOT NULL;

-- ============================================================
-- 4. event_results_fingerprint: the stage columns and head starts
-- ============================================================
-- 00213's body with seven keys added. Both sides of every comparison call this
-- function, so there is no TypeScript copy of the key list to keep in step.
CREATE OR REPLACE FUNCTION public.event_results_fingerprint(p_event_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    jsonb_object_agg(m.id::TEXT, jsonb_build_object(
      'st', m.status::TEXT,
      'wp', m.winner_participant_id,
      'wr', m.winner_pair_id,
      'lp', m.loser_participant_id,
      'lr', m.loser_pair_id,
      'sc', m.scores,
      'wo', m.walkover_winner,
      'by', m.is_bye,
      'th', m.is_third_place,
      'rn', m.round_number,
      'bp', m.bracket_position,
      'ph', m.phase,
      'pa', m.participant_a_id,
      'pb', m.participant_b_id,
      'ra', m.pair_a_id,
      'rb', m.pair_b_id,
      'dg', m.draw_generation_id,
      'sg', m.stage,
      'pn', m.pool_number,
      'gn', m.group_number,
      'sl', m.slot,
      'ml', m.match_label,
      'ha', m.handicap_a,
      'hb', m.handicap_b
    )),
    '{}'::jsonb)
  FROM tournament_matches m
  WHERE m.event_id = p_event_id;
$function$;

REVOKE ALL ON FUNCTION public.event_results_fingerprint(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_results_fingerprint(uuid) TO service_role;

-- What a later stage is drawn from: the matches of every stage before it, and
-- who has left the event. A withdrawal changes no match row until the forfeit
-- sweep runs, but it changes who a table ranks and who may be drawn, so the
-- out entries ride along under '_out' (not a uuid, so no match id collides).
CREATE OR REPLACE FUNCTION public.staged_source_fingerprint(p_event_id uuid, p_stage smallint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (public.event_results_fingerprint(p_event_id) - COALESCE(
    (SELECT array_agg(m.id::TEXT) FROM tournament_matches m
      WHERE m.event_id = p_event_id
        AND (m.stage IS NULL OR m.stage >= p_stage)),
    ARRAY[]::text[]))
  || jsonb_build_object('_out', COALESCE(
    (SELECT jsonb_agg(x.id ORDER BY x.id) FROM (
       SELECT pr.id::TEXT AS id FROM tournament_pairs pr
        WHERE pr.event_id = p_event_id AND pr.status::TEXT IN ('withdrawn', 'disqualified')
       UNION ALL
       SELECT tp.id::TEXT FROM tournament_participants tp
        WHERE tp.event_id = p_event_id AND tp.status::TEXT IN ('withdrawn', 'disqualified')) x),
    '[]'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.staged_source_fingerprint(uuid, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staged_source_fingerprint(uuid, smallint) TO service_role;

-- ============================================================
-- 5. delete_phase_matches refuses a staged event
-- ============================================================
-- 00197's body with one refusal after the lock. A legacy generator reaching a
-- staged event would pass p_phase NULL, which reads as "every match".
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

  IF EXISTS (SELECT 1 FROM tournament_events WHERE id = p_event_id AND format = 'staged') THEN
    RAISE EXCEPTION 'This event is played in stages, so it is drawn one stage at a time from its Stages tab.'
      USING ERRCODE = 'check_violation';
  END IF;

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

  IF v_played > 0 THEN
    RAISE EXCEPTION
      '% match% in this draw % a result, and rebuilding the draw deletes every match, including %. Void or undo % first if the draw really has to be rebuilt. Byes do not count towards this.',
      v_played,
      CASE WHEN v_played = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_played = 1 THEN 'has' ELSE 'have' END,
      CASE WHEN v_played = 1 THEN 'that one' ELSE 'those' END,
      CASE WHEN v_played = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

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

  v_generation := gen_random_uuid();
  UPDATE tournament_events
     SET draw_generation_id = v_generation
   WHERE id = p_event_id;

  RETURN jsonb_build_object('deleted', v_deleted, 'generation', v_generation);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_phase_matches(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_phase_matches(uuid, text) TO service_role;

-- ============================================================
-- 6. delete_stage_matches
-- ============================================================
-- delete_phase_matches for one stage of a staged event: the teardown and the
-- three refusals in one statement, then the generation claim. The trigger of
-- 00198 fences the inserts on that generation, and it does not key on phase,
-- so it fences a stage unchanged.
CREATE OR REPLACE FUNCTION public.delete_stage_matches(
  p_event_id uuid,
  p_stage    smallint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_format     text;
  v_later      integer;
  v_deleted    integer;
  v_played     integer;
  v_rated      integer;
  v_live       integer;
  v_generation uuid;
BEGIN
  IF p_event_id IS NULL OR p_stage IS NULL OR p_stage NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'delete_stage_matches: a stage is 1 to 8';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.format INTO v_format FROM tournament_events e WHERE e.id = p_event_id;
  IF v_format IS NULL THEN
    RAISE EXCEPTION 'delete_stage_matches: event % not found', p_event_id;
  END IF;
  IF v_format <> 'staged' THEN
    RAISE EXCEPTION 'delete_stage_matches: event % is not a staged event', p_event_id;
  END IF;

  -- A later stage was drawn from this one's results. Tearing this one down
  -- would leave it holding entrants this stage no longer produces.
  SELECT count(DISTINCT m.stage)::integer INTO v_later
    FROM tournament_matches m
   WHERE m.event_id = p_event_id AND m.stage > p_stage;
  IF v_later > 0 THEN
    RAISE EXCEPTION
      'A later stage has already been drawn from this one, so this stage cannot be rebuilt. Rebuild the later stage first, or void its matches and rebuild it.'
      USING ERRCODE = 'check_violation';
  END IF;

  WITH gone AS (
    DELETE FROM tournament_matches
     WHERE event_id = p_event_id
       AND stage = p_stage
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

  IF v_played > 0 THEN
    RAISE EXCEPTION
      '% match% in this stage % a result, and rebuilding the stage deletes every match in it, including %. Void or undo % first if the stage really has to be rebuilt. Byes do not count towards this.',
      v_played,
      CASE WHEN v_played = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_played = 1 THEN 'has' ELSE 'have' END,
      CASE WHEN v_played = 1 THEN 'that one' ELSE 'those' END,
      CASE WHEN v_played = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rated > 0 THEN
    RAISE EXCEPTION
      '% match% in this stage still carr% an applied rating that was never reversed, and deleting % would leave that rating on the ladder with no way to take it back. Unvoid then undo % first.',
      v_rated,
      CASE WHEN v_rated = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_rated = 1 THEN 'ies' ELSE 'y' END,
      CASE WHEN v_rated = 1 THEN 'it' ELSE 'them' END,
      CASE WHEN v_rated = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_live > 0 THEN
    RAISE EXCEPTION
      '% match% in this stage % being played right now. Rebuilding the stage would delete % mid-game. Undo the start on the Court Management tab first, or wait for the result.',
      v_live,
      CASE WHEN v_live = 1 THEN '' ELSE 'es' END,
      CASE WHEN v_live = 1 THEN 'is' ELSE 'are' END,
      CASE WHEN v_live = 1 THEN 'it' ELSE 'them' END
      USING ERRCODE = 'check_violation';
  END IF;

  v_generation := gen_random_uuid();
  UPDATE tournament_events
     SET draw_generation_id = v_generation
   WHERE id = p_event_id;

  RETURN jsonb_build_object('deleted', v_deleted, 'generation', v_generation);
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_stage_matches(uuid, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_stage_matches(uuid, smallint) TO service_role;

-- ============================================================
-- 7. publish_stage_draw
-- ============================================================
-- publish_event_draw (00202) for one stage. Stage 1 is drawn from the field
-- and fenced on it exactly as a legacy draw is, with the same digest keys. A
-- later stage is drawn from earlier results, so it is fenced on those instead:
-- p_source_fingerprint is staged_source_fingerprint as the generator read it,
-- and it is read again here under the lock.
CREATE OR REPLACE FUNCTION public.publish_stage_draw(
  p_event_id uuid, p_stage smallint, p_generation uuid, p_doubles boolean,
  p_entrants uuid[], p_digests jsonb, p_source_fingerprint jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status     TEXT;
  v_format     TEXT;
  v_generation UUID;
  v_new_status TEXT;
  v_now        INTEGER;
  v_expected   INTEGER;
  v_left       INTEGER;
  v_extra      INTEGER;
  v_matches    INTEGER;
  v_foreign    INTEGER;
  v_changed    INTEGER;
  v_rows       INTEGER;
BEGIN
  IF p_stage IS NULL OR p_stage NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'publish_stage_draw: a stage is 1 to 8';
  END IF;
  IF p_generation IS NULL THEN
    RAISE EXCEPTION 'publish_stage_draw: p_generation may not be null';
  END IF;
  IF p_entrants IS NULL OR array_length(p_entrants, 1) IS NULL THEN
    RAISE EXCEPTION 'publish_stage_draw: p_entrants may not be null or empty';
  END IF;
  v_expected := array_length(p_entrants, 1);

  IF p_stage = 1 THEN
    IF p_digests IS NULL OR jsonb_typeof(p_digests) <> 'array' THEN
      RAISE EXCEPTION 'publish_stage_draw: p_digests must be a jsonb array';
    END IF;
    IF jsonb_array_length(p_digests) <> v_expected THEN
      RAISE EXCEPTION 'publish_stage_draw: p_digests has % entries for % entrants',
        jsonb_array_length(p_digests), v_expected;
    END IF;
  ELSIF p_source_fingerprint IS NULL OR jsonb_typeof(p_source_fingerprint) <> 'object' THEN
    RAISE EXCEPTION 'publish_stage_draw: a later stage needs p_source_fingerprint';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT e.status::TEXT, e.format, e.draw_generation_id
    INTO v_status, v_format, v_generation
    FROM tournament_events e WHERE e.id = p_event_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_found');
  END IF;
  IF v_format <> 'staged' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'not_staged');
  END IF;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_completed', 'event_status', v_status);
  END IF;
  IF p_stage > 1 AND v_status <> 'live' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'event_not_live', 'event_status', v_status);
  END IF;

  IF v_generation IS DISTINCT FROM p_generation THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'superseded');
  END IF;

  -- ---- everybody drawn is still in the event ---------------------------
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

  IF p_stage = 1 THEN
    -- ---- what the entrants contained: 00202's digest, key for key -------
    IF p_doubles THEN
      SELECT COUNT(*) INTO v_changed
        FROM unnest(p_entrants) WITH ORDINALITY AS e(id, ord)
        JOIN tournament_pairs pr ON pr.id = e.id AND pr.event_id = p_event_id
       WHERE jsonb_build_object(
               'p1',   pr.player1_id,
               'p2',   pr.player2_id,
               'ce',   pr.combined_elo,
               'seed', pr.seed_number,
               'grp',  pr.group_number)
             IS DISTINCT FROM (p_digests -> (e.ord - 1)::INTEGER);
    ELSE
      SELECT COUNT(*) INTO v_changed
        FROM unnest(p_entrants) WITH ORDINALITY AS e(id, ord)
        JOIN tournament_participants tp ON tp.id = e.id AND tp.event_id = p_event_id
       WHERE jsonb_build_object(
               'p',    tp.player_id,
               'eb',   tp.elo_before,
               'ea',   tp.elo_after,
               'seed', tp.seed_number,
               'grp',  tp.group_number)
             IS DISTINCT FROM (p_digests -> (e.ord - 1)::INTEGER);
    END IF;
    IF v_changed > 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'entrant_changed', 'count', v_changed);
    END IF;

    -- ---- nobody in the event is missing from the draw --------------------
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
    IF v_extra > 0 THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'field_grew',
                                'expected', v_expected, 'now', v_now);
    END IF;
  ELSE
    -- ---- the results this stage was drawn from have not moved -------------
    IF public.staged_source_fingerprint(p_event_id, p_stage) IS DISTINCT FROM p_source_fingerprint THEN
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'source_changed');
    END IF;
  END IF;

  -- ---- what was actually built (00197) -----------------------------------
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE m.draw_generation_id IS DISTINCT FROM p_generation)
    INTO v_matches, v_foreign
    FROM tournament_matches m
   WHERE m.event_id = p_event_id
     AND m.stage = p_stage;
  IF v_foreign > 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'foreign_matches', 'count', v_foreign);
  END IF;
  IF v_matches = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'no_matches');
  END IF;

  -- A redraw never sends a live event backwards; a later stage is drawn while
  -- the event is live and leaves it there.
  v_new_status := CASE WHEN v_status = 'live' THEN 'live' ELSE 'bracket_generated' END;

  UPDATE tournament_events
     SET status = v_new_status, current_stage = p_stage, updated_at = NOW()
   WHERE id = p_event_id
     AND status::TEXT = v_status;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'publish_stage_draw: event status moved under the lock (% rows updated)', v_rows
      USING ERRCODE = 'serialization_failure';
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'matches', v_matches, 'status', v_new_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.publish_stage_draw(uuid, smallint, uuid, boolean, uuid[], jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_stage_draw(uuid, smallint, uuid, boolean, uuid[], jsonb, jsonb) TO service_role;

-- ============================================================
-- 8. The ratings backstop: unrated events and unrated stages
-- ============================================================
-- 00269's trigger, widened. A stage's rated key absent means rated, as the
-- schema defaults it.
CREATE OR REPLACE FUNCTION public.tournament_matches_external_unrated()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM tournament_events e WHERE e.id = NEW.event_id AND e.external_event) THEN
    RAISE EXCEPTION 'A match in an external event is unrated and cannot move anybody''s rating.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tournament_events e
     WHERE e.id = NEW.event_id
       AND (NOT e.rated
         OR (NEW.stage IS NOT NULL
             AND e.format_config #>> ARRAY['stages', (NEW.stage - 1)::text, 'rated'] = 'false'))
  ) THEN
    RAISE EXCEPTION 'This match is unrated and cannot move anybody''s rating.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tournament_matches_external_unrated() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 9. VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_bad text[] := ARRAY[]::text[];
  v_fn  text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND (table_name, column_name) IN (
         ('tournament_events', 'format_config'), ('tournament_events', 'current_stage'),
         ('tournament_events', 'rated'), ('tournament_pairs', 'team_category'),
         ('tournament_matches', 'stage'), ('tournament_matches', 'pool_number'),
         ('tournament_matches', 'group_number'), ('tournament_matches', 'slot'),
         ('tournament_matches', 'match_label'), ('tournament_matches', 'handicap_a'),
         ('tournament_matches', 'handicap_b'))) <> 11 THEN
    v_bad := array_append(v_bad, 'a 00272 column is missing');
  END IF;

  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('tournament_events_format_check', 'tournament_events_staged_config',
                         'tournament_events_current_stage_range', 'tournament_events_external_event_shape',
                         'tournament_pairs_team_category_len', 'tournament_matches_stage_range',
                         'tournament_matches_match_label_len', 'tournament_matches_handicap_range',
                         'tournament_matches_stage_or_phase')
         AND convalidated) <> 9 THEN
    v_bad := array_append(v_bad, 'a 00272 constraint is missing or not validated');
  END IF;

  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'tournament_events_format_check'))
     NOT LIKE '%staged%' THEN
    v_bad := array_append(v_bad, 'the format CHECK does not allow staged');
  END IF;

  IF (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'tournament_matches'
         AND indexname IN ('tournament_matches_draw_position_idx', 'tournament_matches_one_third_place_per_event',
                           'tournament_matches_stage_position_idx', 'tournament_matches_one_third_place_per_stage',
                           'tournament_matches_stage_label_idx')
         AND indexdef LIKE 'CREATE UNIQUE INDEX%') <> 5 THEN
    v_bad := array_append(v_bad, 'a 00272 unique index is missing');
  END IF;
  IF (SELECT indexdef FROM pg_indexes WHERE indexname = 'tournament_matches_draw_position_idx') NOT LIKE '%stage IS NULL%'
     OR (SELECT indexdef FROM pg_indexes WHERE indexname = 'tournament_matches_one_third_place_per_event') NOT LIKE '%stage IS NULL%' THEN
    v_bad := array_append(v_bad, 'a legacy index was not narrowed to stage IS NULL');
  END IF;

  IF EXISTS (SELECT 1 FROM tournament_events WHERE external_event AND rated) THEN
    v_bad := array_append(v_bad, 'an external event is rated');
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.delete_stage_matches(uuid, smallint)',
    'public.publish_stage_draw(uuid, smallint, uuid, boolean, uuid[], jsonb, jsonb)',
    'public.staged_source_fingerprint(uuid, smallint)',
    'public.event_results_fingerprint(uuid)',
    'public.delete_phase_matches(uuid, text)'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc
       WHERE oid = v_fn::regprocedure
         AND prosecdef
         AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%')
    ) THEN
      v_bad := array_append(v_bad, v_fn || ' is not SECURITY DEFINER with a pinned search_path');
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, v_fn || ' is callable beyond service_role');
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      v_bad := array_append(v_bad, 'service_role cannot call ' || v_fn);
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('tournament_events_external_fence', 'tournament_matches_external_unrated',
                        'trg_tournament_match_generation')
         AND tgenabled = 'O' AND NOT tgisinternal) <> 3 THEN
    v_bad := array_append(v_bad, 'a fence trigger is missing or disabled');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00272 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00272 verified: staged columns, constraints, indexes and the three new functions are in place.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
