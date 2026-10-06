-- ============================================================
-- 00273: A TOURNAMENT'S OWN COURTS
--
-- Until now a court was free text on the match (00135): the desk typed "3" or
-- "Court 3" and nothing knew how many courts a tournament had, which ones were
-- in use, or that two matches had just been sent to the same one. This gives a
-- tournament a list of its courts, links a match to one, and lets the database
-- refuse two matches being played on the same court at once.
--
-- WHAT CHANGES.
--   * tournament_courts: one row per court of a tournament, with a label (what
--     members read, 1 to 20 characters), an order, an active switch and a note.
--     Console only: RLS on with no policy, every grant taken from PUBLIC, anon
--     and authenticated, and not published to Realtime. Courts are deactivated,
--     never deleted, so a finished match never loses the court it was on.
--   * tournament_matches.court_id: the court a match is on, when the tournament
--     has courts. NULL on every existing row; nothing is backfilled. A
--     tournament without courts keeps working exactly as before on the text.
--   * tournament_matches.court stays the members' label. It is kept in step
--     with court_id by a trigger, so the player app, the bracket and the Data
--     API go on reading the one column they already read and never learn the
--     id.
--   * tournament_matches_one_live_per_court: at most one live match per court.
--     This is the real guard against double booking; the desk's "in use" marks
--     are a courtesy and can be stale.
--
-- NEW FUNCTIONS (trigger functions, service_role only).
--   * tournament_matches_court_sync: BEFORE INSERT OR UPDATE OF court_id, court
--     on tournament_matches. Refuses a court of another tournament, copies the
--     court's label into `court` when court_id is set or changed, and unlinks
--     court_id when somebody writes a different text over a linked court.
--   * tournament_courts_label_sync: AFTER UPDATE OF label on tournament_courts.
--     A rename reaches every unfinished match on that court; a finished match
--     keeps the label it was played under.
--
-- ROLLING DEPLOY. Nothing here renames or drops anything a running image
-- reads. New code probes for tournament_courts and court_id and says "Run
-- migration 00273 first" when they are missing; draws only write court_id once
-- the table is there.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. tournament_courts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tournament_courts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  label         text NOT NULL CONSTRAINT tournament_courts_label_len CHECK (length(btrim(label)) BETWEEN 1 AND 20),
  sort_order    smallint NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  notes         text CONSTRAINT tournament_courts_notes_len CHECK (notes IS NULL OR length(notes) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A BACKSTOP, NOT THE RULE. The console compares labels by courtKey (in
-- packages/shared match-court.ts), which also treats "Court 3" and "3" as the
-- same court; that is stricter than this index and is what an organiser is
-- told about. This index only stops two rows that are the same text up to case
-- and spaces, which is what a race between two editors could still produce.
CREATE UNIQUE INDEX IF NOT EXISTS tournament_courts_label_key
  ON public.tournament_courts (tournament_id, lower(btrim(label)));
CREATE INDEX IF NOT EXISTS tournament_courts_order_idx
  ON public.tournament_courts (tournament_id, sort_order);

-- 00118's private-table pattern: RLS with no policy is the braces, the revokes
-- are the belt. service_role bypasses RLS, so the console is unaffected.
ALTER TABLE public.tournament_courts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_courts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tournament_courts TO service_role;

COMMENT ON TABLE public.tournament_courts IS
  'The courts of a tournament (00273). Console only: RLS with no policy, no grants beyond service_role, not published. Deactivate a court rather than delete it.';
COMMENT ON COLUMN public.tournament_courts.label IS
  'What members read, 1 to 20 characters. Copied into tournament_matches.court by tournament_matches_court_sync and on rename by tournament_courts_label_sync.';
COMMENT ON COLUMN public.tournament_courts.active IS
  'False hides the court from the desk and from new draws. Matches already on it keep it.';

-- ============================================================
-- 2. tournament_matches.court_id
-- ============================================================
ALTER TABLE public.tournament_matches
  ADD COLUMN IF NOT EXISTS court_id uuid REFERENCES public.tournament_courts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tournament_matches_court_id_idx
  ON public.tournament_matches (court_id) WHERE court_id IS NOT NULL;

-- One match on a court at a time. A match goes live only through the desk's
-- Start (setMatchLive), and two desks can press it for two matches on the same
-- court a second apart; this is what makes the second one fail.
CREATE UNIQUE INDEX IF NOT EXISTS tournament_matches_one_live_per_court
  ON public.tournament_matches (court_id) WHERE status = 'live' AND court_id IS NOT NULL;

COMMENT ON COLUMN public.tournament_matches.court_id IS
  'The tournament court this match is on (00273), when the tournament has courts. Console only: the player app and the Data API read court, never this.';
COMMENT ON COLUMN public.tournament_matches.court IS
  'The court as members read it. Free text where the tournament has no courts (00135); where it has courts (00273) it is the linked court''s label, kept in step by tournament_matches_court_sync and tournament_courts_label_sync.';

-- ============================================================
-- 3. Keeping court and court_id in step
-- ============================================================
CREATE OR REPLACE FUNCTION public.tournament_matches_court_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_label text;
  v_court_tournament uuid;
BEGIN
  IF NEW.court_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.label, c.tournament_id
    INTO v_label, v_court_tournament
    FROM tournament_courts c
   WHERE c.id = NEW.court_id;

  IF v_court_tournament IS NULL
     OR v_court_tournament IS DISTINCT FROM (SELECT e.tournament_id FROM tournament_events e WHERE e.id = NEW.event_id) THEN
    RAISE EXCEPTION 'That court belongs to another tournament'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Nested rather than one OR: plpgsql does not promise to short-circuit, and
  -- OLD is not assigned on INSERT.
  IF TG_OP = 'INSERT' THEN
    NEW.court := v_label;
  ELSIF NEW.court_id IS DISTINCT FROM OLD.court_id THEN
    NEW.court := v_label;
  ELSIF NEW.court IS DISTINCT FROM OLD.court
        AND lower(btrim(coalesce(NEW.court, ''))) <> lower(btrim(v_label)) THEN
    -- Somebody wrote a different place over a linked court: the text wins and
    -- the link goes, so the two can never disagree.
    NEW.court_id := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tournament_matches_court_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tournament_matches_court_sync() TO service_role;

DROP TRIGGER IF EXISTS tournament_matches_court_sync ON public.tournament_matches;
CREATE TRIGGER tournament_matches_court_sync
  BEFORE INSERT OR UPDATE OF court_id, court ON public.tournament_matches
  FOR EACH ROW EXECUTE FUNCTION public.tournament_matches_court_sync();

-- A rename reaches the matches still to be played. A finished match keeps the
-- label it was played under. The UPDATE below re-enters the trigger above,
-- which reads the court's NEW label and so leaves court_id linked.
CREATE OR REPLACE FUNCTION public.tournament_courts_label_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE tournament_matches
     SET court = NEW.label, updated_at = now()
   WHERE court_id = NEW.id
     AND status IN ('pending', 'ready', 'live')
     AND court IS DISTINCT FROM NEW.label;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tournament_courts_label_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tournament_courts_label_sync() TO service_role;

DROP TRIGGER IF EXISTS tournament_courts_label_sync ON public.tournament_courts;
CREATE TRIGGER tournament_courts_label_sync
  AFTER UPDATE OF label ON public.tournament_courts
  FOR EACH ROW EXECUTE FUNCTION public.tournament_courts_label_sync();

COMMENT ON FUNCTION public.tournament_matches_court_sync() IS
  'BEFORE INSERT OR UPDATE OF court_id, court on tournament_matches (00273). Refuses a court of another tournament; copies the court label into court; unlinks court_id when a different text is written.';
COMMENT ON FUNCTION public.tournament_courts_label_sync() IS
  'AFTER UPDATE OF label on tournament_courts (00273). Copies a renamed label onto the unfinished matches on that court.';

-- ============================================================
-- 4. VERIFY
-- ============================================================
DO $verify$
DECLARE
  v_bad text[] := ARRAY[]::text[];
  v_fn  text;
  v_role text;
BEGIN
  IF to_regclass('public.tournament_courts') IS NULL THEN
    v_bad := array_append(v_bad, 'tournament_courts is missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'tournament_matches' AND column_name = 'court_id') THEN
    v_bad := array_append(v_bad, 'tournament_matches.court_id is missing');
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tournament_courts'::regclass) THEN
    v_bad := array_append(v_bad, 'tournament_courts does not have RLS enabled');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.tournament_courts'::regclass) THEN
    v_bad := array_append(v_bad, 'tournament_courts has a policy');
  END IF;
  -- has_table_privilege, not information_schema, which reports grants that do
  -- not exist.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(v_role, 'public.tournament_courts', 'SELECT')
       OR has_table_privilege(v_role, 'public.tournament_courts', 'INSERT')
       OR has_table_privilege(v_role, 'public.tournament_courts', 'UPDATE')
       OR has_table_privilege(v_role, 'public.tournament_courts', 'DELETE') THEN
      v_bad := array_append(v_bad, v_role || ' holds a privilege on tournament_courts');
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.tournament_courts', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.tournament_courts', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.tournament_courts', 'UPDATE') THEN
    v_bad := array_append(v_bad, 'service_role cannot read and write tournament_courts');
  END IF;

  IF (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tournament_matches_one_live_per_court')
     IS DISTINCT FROM
     'CREATE UNIQUE INDEX tournament_matches_one_live_per_court ON public.tournament_matches USING btree (court_id) WHERE ((status = ''live''::text) AND (court_id IS NOT NULL))' THEN
    v_bad := array_append(v_bad, 'the one-live-match-per-court index is missing or different');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND indexname = 'tournament_courts_label_key'
                    AND indexdef LIKE 'CREATE UNIQUE INDEX%') THEN
    v_bad := array_append(v_bad, 'the court label backstop index is missing');
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('tournament_matches_court_sync', 'tournament_courts_label_sync')
         AND tgenabled = 'O' AND NOT tgisinternal) <> 2 THEN
    v_bad := array_append(v_bad, 'a court trigger is missing or disabled');
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.tournament_matches_court_sync()',
    'public.tournament_courts_label_sync()'
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
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_publication_tables
              WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tournament_courts') THEN
    v_bad := array_append(v_bad, 'tournament_courts is published to Realtime');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00273 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00273 verified: tournament_courts is private, court_id is linked and kept in step, and a court holds one live match.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
