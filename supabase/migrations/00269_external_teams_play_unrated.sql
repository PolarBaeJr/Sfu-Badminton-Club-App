-- ============================================================
-- 00269: EXTERNAL TEAMS PLAY AN UNRATED ROUND ROBIN
--
-- An external event: doubles teams who are not club members, entered by the
-- organisers by name only, played as a round robin in groups, one game each.
-- Nobody in it has a players row, so nothing it produces may reach ratings,
-- statistics, notifications, merges, exports or leaderboards.
--
-- "External", not "guest": guest already means a session guest (00254), and
-- external is what membership_type already calls a non-member.
--
-- THE SHAPE.
--   * tournament_events.external_event marks the event. It IS the "unrated"
--     notion: there was none before (an Elo multiplier of 0 is refused by the
--     application, deliberately). Set at creation, never flipped once the event
--     has an entry or a match.
--   * tournament_pairs.player1_id / player2_id become nullable, and two new
--     text columns hold the two names. pair_name is still written as "A / B",
--     so every reader that already prefers pair_name shows the team unchanged.
--   * An external pair is BOTH ids NULL and BOTH names set; a member pair is both
--     ids set and both names NULL. One CHECK, no third shape.
--
-- THE FENCES, all triggers so no function body is restated here.
--   * An external event holds only external pairs and no participant rows; a normal
--     event never holds an external pair. The participants trigger alone keeps
--     enter_tournament_event, add_participants_under_field_lock and
--     unpair_tournament_pair out of an external event without touching them.
--   * An external event is never a pool that seeds another event, and the CHECK
--     keeps it a plain round robin of doubles with no placement bonus, so
--     promote_pool_qualifier and the bonus ledger are unreachable.
--   * elo_snapshot can never be set on an external match. The application returns
--     before rating one; this is the backstop. apply_tournament_match_rating
--     writes the snapshot in the same transaction as the ratings move, so the
--     raise rolls the move back with it.
--
-- WHY THE NULLS ARE SAFE ELSEWHERE. The pair-id readers in SQL compare by
-- equality (NULL never matches) or are unreachable for an external event. The
-- UNIQUE(event_id, player1_id, player2_id) of 00001 treats NULLs as distinct,
-- so any number of external pairs coexist in one event; the RPC below does the
-- duplicate check by name instead.
--
-- One new function, add_external_tournament_pair, service_role only, taking the
-- same field key and tournaments row as pair_tournament_entrants in the same
-- order. It never reads max_events_per_player: nobody in an external pair is a
-- member, so there is no cross-event count to move.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. COLUMNS AND SHAPES
-- ============================================================
ALTER TABLE public.tournament_events
  ADD COLUMN IF NOT EXISTS external_event boolean NOT NULL DEFAULT false;

-- The doubles list is the one pair_tournament_entrants uses (00201). A pool
-- that feeds a knockout is excluded on purpose: seeding a bracket from external
-- standings would route through promote_pool_qualifier, which needs a member.
ALTER TABLE public.tournament_events DROP CONSTRAINT IF EXISTS tournament_events_external_event_shape;
ALTER TABLE public.tournament_events ADD CONSTRAINT tournament_events_external_event_shape
  CHECK (NOT external_event OR (
    format = 'round_robin'
    AND event_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles')
    AND placement_bonus_enabled IS NOT TRUE
    AND seeded_from_event_id IS NULL
  ));

ALTER TABLE public.tournament_pairs
  ALTER COLUMN player1_id DROP NOT NULL,
  ALTER COLUMN player2_id DROP NOT NULL;
ALTER TABLE public.tournament_pairs ADD COLUMN IF NOT EXISTS external1_name text;
ALTER TABLE public.tournament_pairs ADD COLUMN IF NOT EXISTS external2_name text;

-- Every existing row has the member shape, so this validates in place.
ALTER TABLE public.tournament_pairs DROP CONSTRAINT IF EXISTS tournament_pairs_member_or_external;
ALTER TABLE public.tournament_pairs ADD CONSTRAINT tournament_pairs_member_or_external
  CHECK (
    (player1_id IS NOT NULL AND player2_id IS NOT NULL
      AND external1_name IS NULL AND external2_name IS NULL)
    OR
    (player1_id IS NULL AND player2_id IS NULL
      AND external1_name IS NOT NULL AND external2_name IS NOT NULL
      AND external1_name = btrim(external1_name) AND external2_name = btrim(external2_name)
      AND char_length(external1_name) BETWEEN 1 AND 60
      AND char_length(external2_name) BETWEEN 1 AND 60
      AND lower(external1_name) <> lower(external2_name)
      AND pair_name IS NOT NULL)
  );

-- ============================================================
-- 2. FENCES
-- ============================================================

-- An external event takes external pairs only, and a normal event never takes one.
-- Fires on the id columns and the event, not on status or seed updates, so the
-- hot paths (check-in, seeding, finishing positions) never pay for it.
CREATE OR REPLACE FUNCTION public.tournament_pairs_external_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_external boolean;
BEGIN
  SELECT e.external_event INTO v_external FROM tournament_events e WHERE e.id = NEW.event_id;
  IF v_external AND (NEW.player1_id IS NOT NULL OR NEW.player2_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This event is for external teams entered by the organisers, so it cannot take a member pair.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(v_external, false) AND (NEW.player1_id IS NULL OR NEW.player2_id IS NULL) THEN
    RAISE EXCEPTION 'A team without member accounts can only be entered in an external event.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_pairs_external_fence ON public.tournament_pairs;
CREATE TRIGGER tournament_pairs_external_fence
  BEFORE INSERT OR UPDATE OF event_id, player1_id, player2_id ON public.tournament_pairs
  FOR EACH ROW EXECUTE FUNCTION public.tournament_pairs_external_fence();

-- No member ever enters an external event, alone or on the way to a pair. This one
-- trigger is what keeps enter_tournament_event, add_participants_under_field_lock
-- and unpair_tournament_pair out of it, without restating any of them.
CREATE OR REPLACE FUNCTION public.tournament_participants_external_fence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM tournament_events e WHERE e.id = NEW.event_id AND e.external_event) THEN
    RAISE EXCEPTION 'This event is for external teams entered by the organisers.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_participants_external_fence ON public.tournament_participants;
CREATE TRIGGER tournament_participants_external_fence
  BEFORE INSERT OR UPDATE OF event_id ON public.tournament_participants
  FOR EACH ROW EXECUTE FUNCTION public.tournament_participants_external_fence();

-- The flag is decided before anybody is in the event. Flipping it afterwards
-- would leave member pairs in an external event or external pairs in a rated one, and
-- the pairs trigger only looks at rows as they are written. An external event is
-- also never the pool another event seeds from.
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
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_events_external_fence ON public.tournament_events;
CREATE TRIGGER tournament_events_external_fence
  BEFORE INSERT OR UPDATE OF external_event, seeded_from_event_id ON public.tournament_events
  FOR EACH ROW EXECUTE FUNCTION public.tournament_events_external_fence();

-- THE RATINGS BACKSTOP. Only apply_tournament_match_rating sets elo_snapshot
-- (00084), and it does so in the same transaction as the ratings UPDATE, so
-- refusing the snapshot refuses the whole rating. The WHEN clause keeps the
-- reversal path (which sets it back to NULL) out of the trigger entirely.
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
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tournament_matches_external_unrated ON public.tournament_matches;
CREATE TRIGGER tournament_matches_external_unrated
  BEFORE UPDATE OF elo_snapshot ON public.tournament_matches
  FOR EACH ROW WHEN (NEW.elo_snapshot IS NOT NULL)
  EXECUTE FUNCTION public.tournament_matches_external_unrated();

REVOKE ALL ON FUNCTION public.tournament_pairs_external_fence() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tournament_participants_external_fence() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tournament_events_external_fence() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tournament_matches_external_unrated() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 3. add_external_tournament_pair
-- ============================================================
-- Lock order is pair_tournament_entrants' (00201): the event field key, then
-- the tournaments row, then the event row. The names are normalised here as
-- well as in the application, because this is the only writer of an external pair
-- and the CHECK above only refuses, it does not tidy.
--
-- THE TEAM NAME is optional and lives only in pair_name, so every reader that
-- already shows pair_name shows it with no change. Blank means none, and the
-- pair is then named "A / B" as before.
CREATE OR REPLACE FUNCTION public.add_external_tournament_pair(
  p_event_id uuid, p_external1_name text, p_external2_name text, p_added_by uuid,
  p_team_name text DEFAULT NULL
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
  v_name1       text;
  v_name2       text;
  v_team        text;
  v_pairs       integer;
  v_pair_id     uuid;
BEGIN
  v_name1 := btrim(regexp_replace(COALESCE(p_external1_name, ''), '\s+', ' ', 'g'));
  v_name2 := btrim(regexp_replace(COALESCE(p_external2_name, ''), '\s+', ' ', 'g'));
  IF char_length(v_name1) NOT BETWEEN 1 AND 60 OR char_length(v_name2) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Each player needs a name of 1 to 60 characters.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF lower(v_name1) = lower(v_name2) THEN
    RAISE EXCEPTION 'The two players need different names.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_team := NULLIF(btrim(regexp_replace(COALESCE(p_team_name, ''), '\s+', ' ', 'g')), '');
  IF v_team IS NOT NULL AND char_length(v_team) > 60 THEN
    RAISE EXCEPTION 'A team name can be at most 60 characters.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT e.tournament_id INTO v_tournament
    FROM tournament_events e WHERE e.id = p_event_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(p_event_id::text));

  SELECT t.status::TEXT, t.suspended_at,
         NULLIF(BTRIM(COALESCE(t.suspension_reason, '')), '')
    INTO v_t_status, v_suspended, v_suspend_why
    FROM tournaments t WHERE t.id = v_tournament FOR UPDATE;

  IF v_suspended IS NOT NULL THEN
    RAISE EXCEPTION 'This tournament is currently suspended%',
      COALESCE(': ' || v_suspend_why, '') USING ERRCODE = 'check_violation';
  END IF;
  IF v_t_status IN ('completed', 'archived') THEN
    RAISE EXCEPTION 'This tournament is closed.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, draw_locked, max_participants, external_event
    INTO v_event
    FROM tournament_events
   WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found.' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT v_event.external_event THEN
    RAISE EXCEPTION 'External teams can only be entered in an external event.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_event.status NOT IN ('registration', 'checkin') THEN
    RAISE EXCEPTION 'The draw for this event has already been generated, so pairs can no longer be added. Regenerate the draw if this team should be in it.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_event.draw_locked THEN
    RAISE EXCEPTION 'Draw is locked. Unlock it before making changes.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- One person on one live team. A withdrawn team frees its names, as a
  -- withdrawn member pair frees its members.
  IF EXISTS (
    SELECT 1 FROM tournament_pairs
     WHERE event_id = p_event_id
       AND player1_id IS NULL
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
       AND (lower(external1_name) IN (lower(v_name1), lower(v_name2))
         OR lower(external2_name) IN (lower(v_name1), lower(v_name2)))
  ) THEN
    RAISE EXCEPTION 'One of these players is already in a team in this event.'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Two live teams under one name would be indistinguishable on every table.
  IF v_team IS NOT NULL AND EXISTS (
    SELECT 1 FROM tournament_pairs
     WHERE event_id = p_event_id
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified')
       AND lower(pair_name) = lower(v_team)
  ) THEN
    RAISE EXCEPTION '% is already a team in this event', v_team
      USING ERRCODE = 'unique_violation';
  END IF;

  -- An external event has no participant rows (the trigger above), so a draw slot
  -- is simply a live pair.
  IF v_event.max_participants IS NOT NULL AND v_event.max_participants > 0 THEN
    SELECT COUNT(*) INTO v_pairs FROM tournament_pairs
     WHERE event_id = p_event_id
       AND COALESCE(status::TEXT, '') NOT IN ('withdrawn', 'disqualified');
    IF v_pairs + 1 > v_event.max_participants THEN
      RAISE EXCEPTION 'Event is full.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO tournament_pairs (
    event_id, player1_id, player2_id, external1_name, external2_name,
    pair_name, combined_elo, added_by, status
  ) VALUES (
    p_event_id, NULL, NULL, v_name1, v_name2,
    COALESCE(v_team, v_name1 || ' / ' || v_name2), NULL, p_added_by, 'registered'
  )
  RETURNING id INTO v_pair_id;

  RETURN v_pair_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.add_external_tournament_pair(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_external_tournament_pair(uuid, text, text, uuid, text) TO service_role;

-- ============================================================
-- 4. VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_bad   text[] := ARRAY[]::text[];
  v_event uuid;
  v_ok    boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournament_events'
       AND column_name = 'external_event' AND is_nullable = 'NO'
       AND column_default = 'false'
  ) THEN
    v_bad := array_append(v_bad, 'tournament_events.external_event is missing, nullable or not defaulting to false');
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.tournament_pairs'::regclass
       AND attname IN ('player1_id', 'player2_id') AND attnotnull
  ) THEN
    v_bad := array_append(v_bad, 'tournament_pairs player ids are still NOT NULL');
  END IF;

  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('tournament_events_external_event_shape', 'tournament_pairs_member_or_external')
         AND convalidated) <> 2 THEN
    v_bad := array_append(v_bad, 'an external CHECK constraint is missing or not validated');
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('tournament_pairs_external_fence', 'tournament_participants_external_fence',
                        'tournament_events_external_fence', 'tournament_matches_external_unrated')
         AND tgenabled = 'O' AND NOT tgisinternal) <> 4 THEN
    v_bad := array_append(v_bad, 'an external fence trigger is missing or disabled');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.add_external_tournament_pair(uuid, text, text, uuid, text)'::regprocedure
       AND prosecdef
       AND EXISTS (SELECT 1 FROM unnest(proconfig) c WHERE c LIKE 'search_path=%')
  ) THEN
    v_bad := array_append(v_bad, 'add_external_tournament_pair is not SECURITY DEFINER with a pinned search_path');
  END IF;

  IF has_function_privilege('anon', 'public.add_external_tournament_pair(uuid, text, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.add_external_tournament_pair(uuid, text, text, uuid, text)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'add_external_tournament_pair is callable beyond service_role');
  END IF;
  IF NOT has_function_privilege('service_role', 'public.add_external_tournament_pair(uuid, text, text, uuid, text)', 'EXECUTE') THEN
    v_bad := array_append(v_bad, 'service_role cannot call add_external_tournament_pair');
  END IF;

  -- Premises: this file introduces both, so neither can exist yet.
  IF EXISTS (SELECT 1 FROM tournament_pairs WHERE player1_id IS NULL OR player2_id IS NULL) THEN
    v_bad := array_append(v_bad, 'a pair with a NULL player id already exists');
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_events WHERE external_event) THEN
    v_bad := array_append(v_bad, 'an external event already exists');
  END IF;

  -- Smoke: a CHECK-valid external pair into a normal doubles event is refused by
  -- the trigger, not the CHECK. Skipped where no such event exists.
  SELECT id INTO v_event FROM tournament_events
   WHERE NOT external_event
     AND event_type IN ('mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles')
   LIMIT 1;
  IF v_event IS NOT NULL THEN
    v_ok := false;
    BEGIN
      INSERT INTO tournament_pairs (event_id, external1_name, external2_name, pair_name)
      VALUES (v_event, 'Verify One', 'Verify Two', 'Verify One / Verify Two');
    EXCEPTION WHEN check_violation THEN
      v_ok := true;
    END;
    IF NOT v_ok THEN
      v_bad := array_append(v_bad, 'an external pair was accepted into a normal event');
    END IF;
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00269 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
