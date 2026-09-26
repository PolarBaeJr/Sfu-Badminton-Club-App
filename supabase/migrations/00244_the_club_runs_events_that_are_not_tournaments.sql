-- ============================================================
-- 00244 THE CLUB RUNS EVENTS THAT ARE NOT TOURNAMENTS
--
-- Socials, workshops, clinics, outings and the AGM. Two tables, two
-- service-role RPCs that serialise on the event row, the merge guard told
-- about the two new references to players, and the vocabulary learning
-- eight strings (131 to 139): seven admin-only events.* capabilities and
-- page.access.events, the key to the new events feature switch.
--
-- REQUIRES 00242 APPLIED FIRST. 00242 restates merge_players_disposable()
-- with nine rows and asserts the merge guard is empty. This file restates it
-- again with those nine plus two. Applied in the other order, 00242 would
-- drop the two club event rows and its own verify would abort, leaving it
-- unappliable. Section 0 refuses to run without it.
--
-- STAGING: the 04:00 snapshot restores prod and replays migrations prod lacks
-- from the Pi checkout ~/ssd/Deploy/badminton-staging, in order. Until prod
-- has this file the two tables are recreated EMPTY every night. If it fails
-- against prod-state data the run aborts before the scrub and the fail-closed
-- path truncates players, so rehearse it first.
-- ============================================================

BEGIN;

-- 0. PRECONDITION: 00242 ----------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.merge_players_disposable()
                  WHERE tbl = 'discord_outbox' AND col = 'requested_by') THEN
    RAISE EXCEPTION '00244: apply 00242 first, merge_players_disposable() does not have its rows';
  END IF;
END
$pre$;

-- 1. TABLES -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.club_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  kind             text NOT NULL DEFAULT 'social'
                   CHECK (kind IN ('social','workshop','clinic','outing','agm','other')),
  description      text CHECK (description IS NULL OR char_length(description) <= 4000),
  location         text CHECK (location IS NULL OR char_length(location) <= 200),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz,
  capacity         integer CHECK (capacity IS NULL OR capacity > 0),
  cost_cents       integer CHECK (cost_cents IS NULL OR cost_cents BETWEEN 0 AND 100000),
  signup_opens_at  timestamptz,
  signup_closes_at timestamptz,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','published','cancelled')),
  cancelled_at     timestamptz,
  cancelled_reason text CHECK (cancelled_reason IS NULL OR char_length(cancelled_reason) <= 500),
  created_by       uuid REFERENCES public.players(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT club_events_window CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT club_events_signup_window CHECK (
    signup_opens_at IS NULL OR signup_closes_at IS NULL OR signup_closes_at > signup_opens_at),
  CONSTRAINT club_events_cancel_consistent CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS club_events_status_starts_idx ON public.club_events (status, starts_at);

-- RESTRICT, not CASCADE: an event with anybody signed up cannot be deleted,
-- only cancelled, so the people signed up are told. The console counts first
-- for a friendly message, but a sign-up landing between that count and the
-- DELETE would otherwise vanish with the event; this makes the database refuse.
CREATE TABLE IF NOT EXISTS public.club_event_signups (
  event_id   uuid NOT NULL REFERENCES public.club_events(id) ON DELETE RESTRICT,
  player_id  uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, player_id)
);
CREATE INDEX IF NOT EXISTS club_event_signups_player_idx ON public.club_event_signups (player_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.club_events;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.club_events
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- 2. GRANTS AND RLS ---------------------------------------------------------
-- Supabase default privileges give anon and authenticated everything on a new
-- table, so both are revoked and SELECT is handed back to members only.
ALTER TABLE public.club_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_event_signups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.club_events        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.club_event_signups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.club_events        TO authenticated;
GRANT SELECT ON TABLE public.club_event_signups TO authenticated;
GRANT ALL    ON TABLE public.club_events        TO service_role;
GRANT ALL    ON TABLE public.club_event_signups TO service_role;

DROP POLICY IF EXISTS club_events_member_read ON public.club_events;
CREATE POLICY club_events_member_read ON public.club_events
  FOR SELECT TO authenticated
  USING (status IN ('published','cancelled') AND public.get_player_id(auth.uid()) IS NOT NULL);

DROP POLICY IF EXISTS club_event_signups_own_read ON public.club_event_signups;
CREATE POLICY club_event_signups_own_read ON public.club_event_signups
  FOR SELECT TO authenticated
  USING (player_id = public.get_player_id(auth.uid()));
-- No write policy: every write goes through the RPCs below or the console's
-- service-role client.

-- 3. SIGN UP -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_event_sign_up(p_event_id uuid, p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event    public.club_events%ROWTYPE;
  v_status   text;
  v_banned   boolean;
  v_deleting timestamptz;
  v_taken    integer;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  -- The event row is the lock. FOR NO KEY UPDATE is the mode a plain UPDATE
  -- takes, so a console edit of this event queues here too, and the count
  -- below cannot race another sign-up.
  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_event.status = 'cancelled' THEN RETURN jsonb_build_object('ok', false, 'reason', 'cancelled'); END IF;
  IF v_event.status <> 'published' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_published'); END IF;
  IF v_event.starts_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'started'); END IF;
  IF v_event.signup_opens_at IS NOT NULL AND now() < v_event.signup_opens_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_open_yet');
  END IF;
  IF v_event.signup_closes_at IS NOT NULL AND now() >= v_event.signup_closes_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'closed');
  END IF;

  -- Unlocked on purpose: an explicit players lock here would invert
  -- merge_players, which locks players and then reaches club_events through
  -- ON DELETE SET NULL.
  SELECT p.status::text, p.is_banned, p.deletion_requested_at
    INTO v_status, v_banned, v_deleting
    FROM public.players p WHERE p.id = p_player_id;
  IF v_status IS NULL OR v_banned OR v_deleting IS NOT NULL
     OR v_status IN ('pending_approval','suspended') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_eligible');
  END IF;

  IF EXISTS (SELECT 1 FROM public.club_event_signups s
              WHERE s.event_id = p_event_id AND s.player_id = p_player_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  IF v_event.capacity IS NOT NULL THEN
    SELECT count(*) INTO v_taken FROM public.club_event_signups WHERE event_id = p_event_id;
    IF v_taken >= v_event.capacity THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'full');
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.club_event_signups (event_id, player_id) VALUES (p_event_id, p_player_id);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- 4. WITHDRAW ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.club_event_withdraw(p_event_id uuid, p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_event public.club_events%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND get_player_id(auth.uid()) IS DISTINCT FROM p_player_id THEN
    RAISE EXCEPTION 'Not permitted to act for another member' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_event.starts_at <= now() AND v_event.status <> 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'started');
  END IF;

  DELETE FROM public.club_event_signups WHERE event_id = p_event_id AND player_id = p_player_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_registered'); END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.club_event_sign_up(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.club_event_withdraw(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.club_event_sign_up(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.club_event_withdraw(uuid, uuid) TO service_role;

-- 5. MERGE GUARD ---------------------------------------------------------------
-- Since 00207 merge_players_unhandled() sees every FK to players, so both new
-- references must be classified or every merge is refused. Both are
-- disposable, meaning merge_players never touches them and the removed
-- account's DELETE runs the FK's own action:
--   club_event_signups.player_id  CASCADE: the removed account's sign-ups go
--                                 with it; the survivor signs up again.
--   club_events.created_by        SET NULL: authorship is blanked. The audit
--                                 row for club_event_created keeps the actor.
-- Repointing would mean restating the whole of merge_players (00216).
-- The nine rows are 00242's, verbatim. digest_deliveries is NOT among them:
-- 00204 moved it to repointed.
CREATE OR REPLACE FUNCTION public.merge_players_disposable()
 RETURNS TABLE(tbl text, col text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT * FROM (VALUES
    ('notifications',        'player_id'),
    ('push_subscriptions',   'player_id'),
    ('calendar_feed_tokens', 'player_id'),
    ('ratings',              'player_id'),
    ('reliability_metrics',  'player_id'),
    ('discord_outbox',       'requested_by'),
    ('data_api_consumers',   'created_by'),
    ('data_api_keys',        'minted_by'),
    ('data_api_keys',        'revoked_by'),
    ('club_event_signups',   'player_id'),
    ('club_events',          'created_by')
  ) AS t(tbl, col);
$function$;
REVOKE ALL ON FUNCTION public.merge_players_disposable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players_disposable() TO service_role;

-- 6. THE PLAYER COLUMNS: 131 to 139 ------------------------------------------
-- Dropped by name and re-added: 00243 is recorded as applied, so an in-place
-- edit there would never re-run. Its list, verbatim, with eight appended.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_vocabulary_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_vocabulary_check
  CHECK (
    (permission_grants || permission_revokes) <@ ARRAY[
    'players.page', 'players.read', 'players.approve.write',
    'players.create.write', 'players.update.write', 'players.waiver.resign.write',
    'players.ban.write', 'players.reinstate.write', 'players.editor.varsitynotes.write',
    'players.deletion.cancel.write', 'players.remove.write', 'players.merge.write',
    'players.reliability.write', 'players.privilegedfields.write', 'players.consoleaccess.write',
    'players.discordlink.write',
    'seasons.page', 'seasons.create.write', 'seasons.activate.write',
    'seasons.end.write', 'seasons.fees.write', 'sessions.page',
    'sessions.reminders.write', 'sessions.create.write', 'sessions.update.write',
    'sessions.archive.write', 'sessions.checkin.token.write', 'sessions.attendance.write',
    'sessions.delete.write', 'matches.page', 'matches.void.write',
    'matches.convert.write', 'matches.create.write', 'challenges.page',
    'challenges.create.write', 'challenges.expire.write', 'announcements.page',
    'announcements.create.write', 'announcements.update.write', 'announcements.delete.write',
    'announcements.discord.write', 'tournaments.page', 'tournaments.manage.create.write',
    'tournaments.manage.update.write', 'tournaments.manage.status.write', 'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write', 'tournaments.manage.archive.write', 'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write', 'tournaments.draw.lock.write', 'tournaments.draw.unlock.write',
    'tournaments.draw.waivers.read', 'tournaments.draw.entrycounts.read', 'tournaments.results.enter.write',
    'tournaments.results.walkover.write', 'tournaments.results.void.write', 'tournaments.results.unvoid.write',
    'tournaments.results.undo.write', 'tournaments.results.edit.write', 'tournaments.results.entry.write',
    'tournaments.results.doublenoshow.write', 'tournaments.results.bonuses.write', 'tournaments.results.standings.write',
    'tournaments.results.finalize.write', 'tournaments.fees.read', 'tournaments.fees.tier.create.write',
    'tournaments.fees.tier.update.write', 'tournaments.fees.tier.delete.write', 'tournaments.fees.markpaid.write',
    'tournaments.fees.markunpaid.write', 'fees.page', 'fees.expenses.read',
    'fees.expenses.add.write', 'fees.expenses.update.write', 'fees.expenses.reimburse.write',
    'fees.expenses.remove.write', 'fees.otherincome.read', 'fees.otherincome.add.write',
    'fees.otherincome.remove.write', 'fees.clubfees.read', 'fees.clubfees.markpaid.write',
    'fees.clubfees.markunpaid.write', 'fees.clubfees.waive.write', 'fees.clubfees.addmanual.write',
    'fees.clubfees.removemanual.write', 'fees.reinstatements.read', 'fees.reinstatements.write',
    'fees.netposition.read', 'fees.playerflags.write', 'legal.page',
    'legal.reacceptance.write', 'legal.documents.write', 'legal.waivertemplate.write',
    'walkovers.page', 'walkovers.confirm.write', 'walkovers.reject.write',
    'disputes.page', 'disputes.resolve.write', 'permissions.page',
    'permissions.write', 'audit.page', 'ratings.page',
    'accounts.page', 'accounts.apikey.read', 'accounts.apikey.mint.write',
    'accounts.apikey.revoke.write', 'platform.page', 'platform.settings.write',
    'page.access.sessions', 'page.access.challenges', 'page.access.tournaments',
    'page.access.leaderboard', 'page.access.my_stats', 'page.access.announcements',
    'page.access.fees',
    'events.page', 'events.signups.read', 'events.signups.remove.write',
    'events.manage.create.write', 'events.manage.update.write',
    'events.manage.cancel.write', 'events.manage.delete.write',
    'page.access.events'
    ]::TEXT[]
  );

-- 7. THE BASELINES TABLE -------------------------------------------------------
ALTER TABLE public.permission_baselines
  DROP CONSTRAINT IF EXISTS permission_baselines_vocabulary_check;
ALTER TABLE public.permission_baselines
  ADD CONSTRAINT permission_baselines_vocabulary_check
  CHECK (
    capabilities <@ ARRAY[
    'players.page', 'players.read', 'players.approve.write',
    'players.create.write', 'players.update.write', 'players.waiver.resign.write',
    'players.ban.write', 'players.reinstate.write', 'players.editor.varsitynotes.write',
    'players.deletion.cancel.write', 'players.remove.write', 'players.merge.write',
    'players.reliability.write', 'players.privilegedfields.write', 'players.consoleaccess.write',
    'players.discordlink.write',
    'seasons.page', 'seasons.create.write', 'seasons.activate.write',
    'seasons.end.write', 'seasons.fees.write', 'sessions.page',
    'sessions.reminders.write', 'sessions.create.write', 'sessions.update.write',
    'sessions.archive.write', 'sessions.checkin.token.write', 'sessions.attendance.write',
    'sessions.delete.write', 'matches.page', 'matches.void.write',
    'matches.convert.write', 'matches.create.write', 'challenges.page',
    'challenges.create.write', 'challenges.expire.write', 'announcements.page',
    'announcements.create.write', 'announcements.update.write', 'announcements.delete.write',
    'announcements.discord.write', 'tournaments.page', 'tournaments.manage.create.write',
    'tournaments.manage.update.write', 'tournaments.manage.status.write', 'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write', 'tournaments.manage.archive.write', 'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write', 'tournaments.manage.event.update.write', 'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write', 'tournaments.draw.participants.add.write', 'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write', 'tournaments.draw.checkin.mark.write', 'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write', 'tournaments.draw.pairs.add.write', 'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write', 'tournaments.draw.seed.auto.write', 'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write', 'tournaments.draw.lock.write', 'tournaments.draw.unlock.write',
    'tournaments.draw.waivers.read', 'tournaments.draw.entrycounts.read', 'tournaments.results.enter.write',
    'tournaments.results.walkover.write', 'tournaments.results.void.write', 'tournaments.results.unvoid.write',
    'tournaments.results.undo.write', 'tournaments.results.edit.write', 'tournaments.results.entry.write',
    'tournaments.results.doublenoshow.write', 'tournaments.results.bonuses.write', 'tournaments.results.standings.write',
    'tournaments.results.finalize.write', 'tournaments.fees.read', 'tournaments.fees.tier.create.write',
    'tournaments.fees.tier.update.write', 'tournaments.fees.tier.delete.write', 'tournaments.fees.markpaid.write',
    'tournaments.fees.markunpaid.write', 'fees.page', 'fees.expenses.read',
    'fees.expenses.add.write', 'fees.expenses.update.write', 'fees.expenses.reimburse.write',
    'fees.expenses.remove.write', 'fees.otherincome.read', 'fees.otherincome.add.write',
    'fees.otherincome.remove.write', 'fees.clubfees.read', 'fees.clubfees.markpaid.write',
    'fees.clubfees.markunpaid.write', 'fees.clubfees.waive.write', 'fees.clubfees.addmanual.write',
    'fees.clubfees.removemanual.write', 'fees.reinstatements.read', 'fees.reinstatements.write',
    'fees.netposition.read', 'fees.playerflags.write', 'legal.page',
    'legal.reacceptance.write', 'legal.documents.write', 'legal.waivertemplate.write',
    'walkovers.page', 'walkovers.confirm.write', 'walkovers.reject.write',
    'disputes.page', 'disputes.resolve.write', 'permissions.page',
    'permissions.write', 'audit.page', 'ratings.page',
    'accounts.page', 'accounts.apikey.read', 'accounts.apikey.mint.write',
    'accounts.apikey.revoke.write', 'platform.page', 'platform.settings.write',
    'page.access.sessions', 'page.access.challenges', 'page.access.tournaments',
    'page.access.leaderboard', 'page.access.my_stats', 'page.access.announcements',
    'page.access.fees',
    'events.page', 'events.signups.read', 'events.signups.remove.write',
    'events.manage.create.write', 'events.manage.update.write',
    'events.manage.cancel.write', 'events.manage.delete.write',
    'page.access.events'
    ]::TEXT[]
  );

-- 8. VERIFY ------------------------------------------------------------------
DO $verify$
DECLARE
  v_src text;
  v_fn  text;
  v_gap text;
  v_key text;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.club_event_sign_up(uuid,uuid)',
                              'public.club_event_withdraw(uuid,uuid)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00244: % is executable by anon or authenticated', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '00244: service_role cannot execute %', v_fn;
    END IF;
  END LOOP;

  -- Whole statements, because prosrc carries the comments too.
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE oid = 'public.club_event_sign_up(uuid,uuid)'::regprocedure;
  IF position('SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;' IN v_src) = 0
     OR position('SELECT * INTO v_event FROM public.club_events WHERE id = p_event_id FOR NO KEY UPDATE;' IN v_src)
        > position('SELECT count(*) INTO v_taken FROM public.club_event_signups WHERE event_id = p_event_id;' IN v_src)
     OR position('SELECT count(*) INTO v_taken FROM public.club_event_signups WHERE event_id = p_event_id;' IN v_src)
        > position('INSERT INTO public.club_event_signups (event_id, player_id) VALUES (p_event_id, p_player_id);' IN v_src)
  THEN
    RAISE EXCEPTION '00244: club_event_sign_up does not lock, then count, then insert';
  END IF;

  IF has_table_privilege('anon', 'public.club_events', 'SELECT')
     OR has_table_privilege('anon', 'public.club_event_signups', 'SELECT')
     OR has_table_privilege('authenticated', 'public.club_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.club_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.club_events', 'DELETE')
     OR has_table_privilege('authenticated', 'public.club_event_signups', 'INSERT')
     OR has_table_privilege('authenticated', 'public.club_event_signups', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.club_event_signups', 'DELETE') THEN
    RAISE EXCEPTION '00244: table grants wider than intended';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.club_events'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.club_event_signups'::regclass) THEN
    RAISE EXCEPTION '00244: RLS is not enabled';
  END IF;

  -- The merge guard is empty, the same assertion 00242 makes.
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO v_gap
    FROM public.merge_players_unhandled();
  IF v_gap IS NOT NULL THEN
    RAISE EXCEPTION '00244: merges would be refused, unclassified: %', v_gap;
  END IF;
  IF (SELECT count(*) FROM public.merge_players_disposable()) <> 11 THEN
    RAISE EXCEPTION '00244: merge_players_disposable is not the eleven rows';
  END IF;

  FOR v_def IN
    SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
     WHERE c.conname IN ('players_permission_vocabulary_check',
                         'permission_baselines_vocabulary_check')
  LOOP
    FOREACH v_key IN ARRAY ARRAY[
      'events.page', 'events.signups.read', 'events.signups.remove.write',
      'events.manage.create.write', 'events.manage.update.write',
      'events.manage.cancel.write', 'events.manage.delete.write',
      'page.access.events'
    ]::TEXT[] LOOP
      IF position(quote_literal(v_key) IN v_def) = 0 THEN
        RAISE EXCEPTION '00244: a vocabulary CHECK does not admit %', v_key;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('players_permission_vocabulary_check',
                         'permission_baselines_vocabulary_check')) <> 2 THEN
    RAISE EXCEPTION '00244: expected both vocabulary CHECKs to exist';
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';
