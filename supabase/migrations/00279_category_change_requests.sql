-- ============================================================
-- 00279: A CATEGORY CHANGE AFTER PLAY IS A REQUEST
--
-- A team's category in a staged event (00272) sets the head starts its
-- matches are played from. Until the team has played a match with head
-- starts, the desk changes it directly and the open matches are snapshotted
-- again. Once it has, the old answer was "the category is fixed": a played
-- score was judged by the starts the old category gave, and changing it would
-- leave a result nobody can check.
--
-- The owner's decision: a wrong category is still a wrong category, so the
-- change stays possible, but it becomes a REQUEST with a reason, and somebody
-- who may correct a recorded result (tournaments.results.edit.write) approves
-- or declines it. Approval changes the category and refreshes the head starts
-- of the team's OPEN matches only; played matches keep their recorded scores
-- and can be corrected one at a time with "Apply the current head start".
--
-- WHAT CHANGES.
--   * public.tournament_category_requests: one row per request. At most one
--     'pending' row per team (tournament_category_requests_one_pending); the
--     rest is history ('approved', 'declined', 'cancelled'). Service role
--     only, RLS on with no policy, not in the realtime publication.
--   * approve_pair_category_request: the one approver. It re-asks, under the
--     event field key, everything the app asked before calling it: the request
--     is still pending, the event is staged and not finalised, the category is
--     still one of the event's, the team is still in the event and still has
--     the category the request was made from. Then it writes the category and
--     marks the request approved in one transaction. Declining and cancelling
--     are single guarded UPDATEs from the app and need no function.
--   * merge_players_disposable: requested_by and resolved_by join the
--     fourteen. Both are attribution that may go null.
--
-- ROLLING DEPLOY. Apply this before the build that reads it. A build without
-- it keeps the old refusal; a build with it against a database without it
-- answers "Run migration 00279 first" for the request path and treats the
-- missing table as "no request pending" for the direct path, so a team that
-- has not played can still be changed either way.
--
-- LOCK ORDER, in approve_pair_category_request: the event field advisory key,
-- then the request row FOR UPDATE, then the tournament_pairs row FOR UPDATE.
-- The event row is read under the key and not locked: every writer of its
-- status and format_config that matters here takes the same key first.
-- ============================================================

BEGIN;

-- ---- the table ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tournament_category_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES public.tournament_events(id) ON DELETE CASCADE,
  pair_id       uuid NOT NULL REFERENCES public.tournament_pairs(id) ON DELETE CASCADE,
  -- null on either side is "Unset".
  from_category text,
  to_category   text,
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  requested_by  uuid REFERENCES public.players(id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  resolved_by   uuid REFERENCES public.players(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  CHECK (from_category IS DISTINCT FROM to_category),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);

COMMENT ON TABLE public.tournament_category_requests IS
  'A requested change to a staged team''s category after it has played with head starts (00279). One pending row per team; the rest is history.';
COMMENT ON COLUMN public.tournament_category_requests.from_category IS
  'The team''s category when the request was made. Approval is refused if it has changed since. Null is Unset.';
COMMENT ON COLUMN public.tournament_category_requests.to_category IS
  'The category asked for. Null is Unset.';
COMMENT ON COLUMN public.tournament_category_requests.requested_by IS
  'The officer who asked. Only they may cancel it.';
COMMENT ON COLUMN public.tournament_category_requests.resolved_by IS
  'The officer who approved, declined or cancelled it.';

CREATE UNIQUE INDEX IF NOT EXISTS tournament_category_requests_one_pending
  ON public.tournament_category_requests (pair_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS tournament_category_requests_event_pending
  ON public.tournament_category_requests (event_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS tournament_category_requests_requested_by
  ON public.tournament_category_requests (requested_by);
CREATE INDEX IF NOT EXISTS tournament_category_requests_resolved_by
  ON public.tournament_category_requests (resolved_by);

ALTER TABLE public.tournament_category_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_category_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tournament_category_requests TO service_role;

-- ===========================================================================
-- approve_pair_category_request: the one approver
-- ===========================================================================
--
-- Answers {ok:false, reason} for every refusal and writes nothing. The app
-- refreshes the head starts of the team's open matches afterwards, outside
-- this transaction: a row that went on court in between is skipped there, not
-- refused here.

CREATE OR REPLACE FUNCTION public.approve_pair_category_request(
  p_request_id uuid,
  p_actor      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event      uuid;
  v_req        record;
  v_tournament uuid;
  v_status     text;
  v_format     text;
  v_config     jsonb;
  v_keys       text[];
  v_pair       record;
BEGIN
  SELECT r.event_id INTO v_event FROM tournament_category_requests r WHERE r.id = p_request_id;
  IF v_event IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament_event_field'), hashtext(v_event::text));

  SELECT r.* INTO v_req FROM tournament_category_requests r WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v_req.status);
  END IF;

  SELECT e.tournament_id, e.status::text, e.format, e.format_config
    INTO v_tournament, v_status, v_format, v_config
    FROM tournament_events e WHERE e.id = v_req.event_id;
  IF v_status = 'completed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_completed');
  END IF;
  IF v_format IS DISTINCT FROM 'staged' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_staged');
  END IF;
  IF v_req.to_category IS NOT NULL THEN
    IF jsonb_typeof(v_config -> 'categories') = 'array' THEN
      SELECT COALESCE(array_agg(c ->> 'key'), ARRAY[]::text[]) INTO v_keys
        FROM jsonb_array_elements(v_config -> 'categories') c;
    ELSE
      v_keys := ARRAY['mens', 'womens', 'mixed'];
    END IF;
    IF NOT (v_req.to_category = ANY (v_keys)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'unknown_category');
    END IF;
  END IF;

  SELECT p.id, p.event_id, p.team_category INTO v_pair
    FROM tournament_pairs p WHERE p.id = v_req.pair_id FOR UPDATE;
  IF NOT FOUND OR v_pair.event_id IS DISTINCT FROM v_req.event_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pair_gone');
  END IF;
  IF v_pair.team_category IS DISTINCT FROM v_req.from_category THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale_category');
  END IF;

  UPDATE tournament_pairs SET team_category = v_req.to_category WHERE id = v_req.pair_id;

  UPDATE tournament_category_requests
     SET status = 'approved', resolved_by = p_actor, resolved_at = now()
   WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'ok', true,
    'pair_id', v_req.pair_id,
    'event_id', v_req.event_id,
    'tournament_id', v_tournament,
    'from', v_req.from_category,
    'to', v_req.to_category,
    'requested_by', v_req.requested_by
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_pair_category_request(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_pair_category_request(uuid, uuid) TO service_role;

-- ===========================================================================
-- merge_players_disposable: the fourteen from 00278, and the requests
-- ===========================================================================
--
-- requested_by and resolved_by name an officer acting on a team's head start,
-- not a record about that officer: attribution that may go null, as
-- tournament_event_waitlist.resolved_by already is.

CREATE OR REPLACE FUNCTION public.merge_players_disposable()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',                'player_id'),
    ('push_subscriptions',           'player_id'),
    ('calendar_feed_tokens',         'player_id'),
    ('ratings',                      'player_id'),
    ('reliability_metrics',          'player_id'),
    ('discord_outbox',               'requested_by'),
    ('data_api_consumers',           'created_by'),
    ('data_api_keys',                'minted_by'),
    ('data_api_keys',                'revoked_by'),
    ('club_event_signups',           'player_id'),
    ('club_events',                  'created_by'),
    ('fee_submissions',              'reviewed_by'),
    ('tournament_event_waitlist',    'player_id'),
    ('tournament_event_waitlist',    'resolved_by'),
    ('tournament_category_requests', 'requested_by'),
    ('tournament_category_requests', 'resolved_by')
  ) AS t(tbl, col);
$function$;

REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

DO $verify$
DECLARE
  v_bad  TEXT[] := ARRAY[]::TEXT[];
  v_oid  oid;
  v_src  TEXT;
  r      RECORD;
BEGIN
  -- ---- the table, closed to anon and authenticated --------------------------
  IF to_regclass('public.tournament_category_requests') IS NULL THEN
    v_bad := array_append(v_bad, 'tournament_category_requests missing');
  ELSE
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.tournament_category_requests'::regclass) THEN
      v_bad := array_append(v_bad, 'tournament_category_requests does not have RLS enabled');
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tournament_category_requests'
    ) THEN
      v_bad := array_append(v_bad, 'tournament_category_requests has a policy');
    END IF;
    IF has_table_privilege('anon', 'public.tournament_category_requests', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'public.tournament_category_requests', 'SELECT,INSERT,UPDATE,DELETE') THEN
      v_bad := array_append(v_bad, 'tournament_category_requests is readable or writable by anon or authenticated');
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
       WHERE c.oid = 'public.tournament_category_requests'::regclass
         AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
    ) THEN
      v_bad := array_append(v_bad, 'tournament_category_requests relacl still names anon or authenticated');
    END IF;
    IF NOT has_table_privilege('service_role', 'public.tournament_category_requests', 'SELECT,INSERT,UPDATE,DELETE') THEN
      v_bad := array_append(v_bad, 'tournament_category_requests is not writable by service_role');
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE schemaname = 'public' AND tablename = 'tournament_category_requests'
    ) THEN
      v_bad := array_append(v_bad, 'tournament_category_requests is in a publication');
    END IF;
    IF to_regclass('public.tournament_category_requests_one_pending') IS NULL THEN
      v_bad := array_append(v_bad, 'the one-pending-request unique index is missing');
    END IF;
  END IF;

  -- ---- both functions: one signature, service_role only ---------------------
  FOR r IN
    SELECT * FROM (VALUES
      ('approve_pair_category_request', 'public.approve_pair_category_request(uuid,uuid)'),
      ('merge_players_disposable', 'public.merge_players_disposable()')
    ) AS t(fn, sig)
  LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = r.fn) <> 1 THEN
      v_bad := array_append(v_bad, format('%s does not have exactly one signature', r.fn));
    END IF;
    v_oid := to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      v_bad := array_append(v_bad, format('%s missing', r.sig));
      CONTINUE;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is executable by anon or authenticated', r.sig));
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      v_bad := array_append(v_bad, format('%s is not executable by service_role', r.sig));
    END IF;
  END LOOP;

  -- ---- the approver: definer, pinned path, the key before any row lock ------
  v_oid := to_regprocedure('public.approve_pair_category_request(uuid,uuid)');
  IF v_oid IS NOT NULL THEN
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
      v_bad := array_append(v_bad, 'approve_pair_category_request is not SECURITY DEFINER');
    END IF;
    IF NOT COALESCE((SELECT 'search_path=public, pg_temp' = ANY (proconfig) FROM pg_proc WHERE oid = v_oid), false) THEN
      v_bad := array_append(v_bad, 'approve_pair_category_request does not pin search_path');
    END IF;
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
    IF position('pg_advisory_xact_lock(hashtext(''tournament_event_field'')' in v_src) = 0
       OR position('FOR UPDATE' in v_src) = 0
       OR position('pg_advisory_xact_lock' in v_src) > position('FOR UPDATE' in v_src) THEN
      v_bad := array_append(v_bad, 'approve_pair_category_request does not take the field key before its row locks');
    END IF;
  END IF;

  -- ---- merge_players --------------------------------------------------------
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 16 THEN
    v_bad := array_append(v_bad, 'merge_players_disposable is not the sixteen rows');
  END IF;
  IF EXISTS (SELECT 1 FROM public.merge_players_unhandled()) THEN
    v_bad := array_append(v_bad, format('merge_players_unhandled is not empty: %s',
      (SELECT string_agg(tbl || '.' || col, ', ') FROM public.merge_players_unhandled())));
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION E'00279 verification failed:\n  - %', array_to_string(v_bad, E'\n  - ');
  END IF;
  RAISE NOTICE '00279 verified: the request table, its approver and the merge rows are in place.';
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
