-- ============================================================
-- 00254 GUESTS SIGN THE WAIVER
--
-- WHAT IS CREATED: one string in the capability vocabulary
-- (`page.access.guest_waivers`, taking it from 141 to 142), one table
-- (`guest_waiver_signings`) and one function (`sign_guest_waiver`).
--
-- WHAT IT IS FOR. Somebody who is not a member, and has no account, plays at
-- a session as a guest. The club needs them to have signed the liability
-- waiver and the privacy policy first. Until now the only way to sign either
-- was to create an account. The player app gains a public /guest-waiver page:
-- a name, an email, two ticks, and a link back that proves the signing.
--
-- ------------------------------------------------------------
-- THIS IS A DELIBERATE ANONYMOUS WRITE PATH
-- ------------------------------------------------------------
-- A visitor with no session causes a row to be written. That is the feature,
-- and it is the first time this schema has one, so it is stated here rather
-- than left for somebody to discover.
--
-- IT DOES NOT REOPEN THE ANON-FUNCTION DEBT. function-grant-drift.test.ts
-- closed that at six functions `anon` may execute, each kept on purpose. The
-- function below is NOT one of them and does not make seven: EXECUTE is
-- revoked from PUBLIC, anon and authenticated and granted to service_role
-- only. The anonymous visitor never reaches PostgREST with it; they reach a
-- Next server action, which validates the input, checks the club's
-- `guest_waivers` switch, hashes the caller's IP and then calls this function
-- with the service role. Do not "close" this by revoking service_role, and do
-- not "simplify" it by granting anon: the first breaks the page, the second
-- puts an unthrottled writer on the open internet (the edge leaves `/supabase`
-- unrate-limited on both hosts).
--
-- ------------------------------------------------------------
-- WHY A TABLE OF ITS OWN, WITH NO MEMBER COLUMN
-- ------------------------------------------------------------
-- waiver_acceptances hangs off players.id, and a guest has no players row.
-- Inventing one would put a non-member through onboarding, the roster, the
-- ratings and every purge job. So this table names nobody by id: no
-- `player_id`, no foreign key to players. deleted-identity.test.ts treats a
-- `player_id` line as purge coverage and the member data export partitions
-- it as "not about players", and both are true of it.
--
-- NO MERGE INTO A LATER ACCOUNT. Matching a signing to an account by email
-- would let anybody attach a signing to an address they typed. A guest who
-- later joins signs again at onboarding, like everybody else.
--
-- ------------------------------------------------------------
-- THE VERSIONS ARE THE DATABASE'S, NOT THE CALLER'S
-- ------------------------------------------------------------
-- The function has no version parameter. It reads the live `version` of the
-- waiver and the privacy policy from legal_documents inside the same
-- transaction as the insert, so a row always pins the text that was on the
-- page when it was written, and no client can claim to have signed an older
-- one.
--
-- ------------------------------------------------------------
-- THROTTLES, AND WHY THEY LIVE HERE
-- ------------------------------------------------------------
--   * A resubmit of the same email for the same two versions within ten
--     minutes returns the row it already made (`reused = true`), so a double
--     tap or a refresh never files twice.
--   * At most 5 signings per email in 24 hours.
--   * At most 60 per IP hash in an hour, and only when the app sends one.
--     Generous because a campus NAT puts a whole gym behind one address.
-- A transaction-scoped advisory lock on the email serialises the dedupe and
-- the email count, so two racing submits cannot both pass. The IP count is
-- not serialised: it is a coarse ceiling, and one row over it is harmless.
--
-- THE IP IS NEVER STORED. The app sends an HMAC of it under a salt only the
-- app holds (GUEST_WAIVER_IP_SALT). An unsalted sha256 of an IPv4 address is
-- reversible by enumeration, so the salt is not optional; without it the app
-- sends NULL and only the email throttle runs.
--
-- NO PGCRYPTO, for the reason 00241 gives: it lives in `extensions`, which
-- the pinned search_path excludes. Nothing here needs it.
--
-- ------------------------------------------------------------
-- THE SWITCH, AND ITS KEY
-- ------------------------------------------------------------
-- `guest_waivers` is the first club feature switch that is OFF by default: it
-- stays off until the owner republishes a privacy policy that covers guests.
-- Every switch mints a `page.access.<id>` key (00243 explains the model), so
-- the vocabulary learns one string. Purely additive: nothing removed, no
-- stored array rewritten, and in no baseline, like every other page key.
-- ============================================================

BEGIN;

-- 1. THE VOCABULARY: 141 to 142 ------------------------------------------------
-- Dropped by name and re-added, 00247's list verbatim with one appended.
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
    'page.access.events',
    'page.access.membership', 'page.access.socials',
    'page.access.guest_waivers'
    ]::TEXT[]
  );

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
    'page.access.events',
    'page.access.membership', 'page.access.socials',
    'page.access.guest_waivers'
    ]::TEXT[]
  );

-- 2. THE TABLE -----------------------------------------------------------------
--
-- APPEND-ONLY. Nothing is granted UPDATE or DELETE, and there is no void: a
-- signing that happened stays a fact. Retention is the owner's decision and is
-- not made here.
CREATE TABLE IF NOT EXISTS public.guest_waiver_signings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL
    CHECK (full_name = btrim(full_name) AND char_length(full_name) BETWEEN 1 AND 100),
  -- The same shape 00252 holds club_fees.manual_email to.
  email text NOT NULL
    CHECK (
      email = lower(btrim(email))
      AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
      AND char_length(email) <= 254
    ),
  waiver_version text NOT NULL,
  privacy_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  -- A guest must be 19 or older. Not a flag to filter on: a row cannot exist
  -- without it.
  age_attestation boolean NOT NULL CHECK (age_attestation IS TRUE),
  user_agent text,
  ip_hash text CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  -- 24 random bytes as hex, minted by the app. A bearer link: it shows the
  -- name, the date and the two versions, and nothing else.
  token text NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{48}$')
);

COMMENT ON TABLE public.guest_waiver_signings IS
  'Waiver and privacy policy signings by guests who are not members and have no account. Append-only; written only by sign_guest_waiver(), read only by the service role. No member column: a member export, the account deletion flow and the purge jobs cannot reach these rows.';

CREATE INDEX IF NOT EXISTS guest_waiver_signings_email_idx
  ON public.guest_waiver_signings (email, accepted_at DESC);
CREATE INDEX IF NOT EXISTS guest_waiver_signings_ip_hash_idx
  ON public.guest_waiver_signings (ip_hash, accepted_at DESC) WHERE ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS guest_waiver_signings_accepted_at_idx
  ON public.guest_waiver_signings (accepted_at DESC);

-- LOCKED DOWN, the 00241 way. Supabase's default privileges grant anon,
-- authenticated AND service_role on every new relation, so the revoke names
-- all four. service_role gets SELECT back for the proof page and the console
-- list; every write goes through the function below, which runs as the owner.
-- RLS on with no policy, so even a stray grant later reads nothing.
REVOKE ALL ON TABLE public.guest_waiver_signings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.guest_waiver_signings TO service_role;
ALTER TABLE public.guest_waiver_signings ENABLE ROW LEVEL SECURITY;

-- 3. THE FUNCTION --------------------------------------------------------------
--
-- `#variable_conflict use_column`: the OUT columns share their names with the
-- table's, and without it every unqualified reference is ambiguous at call
-- time, which no check at apply time would notice. The table is aliased
-- everywhere regardless.
--
-- Refusals carry SQLSTATE P0001 and a stable HINT, which is what the app maps
-- to plain words: guest_waiver_age, guest_waiver_no_document,
-- guest_waiver_email_limit, guest_waiver_ip_limit.
CREATE OR REPLACE FUNCTION public.sign_guest_waiver(
  p_full_name text,
  p_email text,
  p_age_attestation boolean,
  p_user_agent text,
  p_ip_hash text,
  p_token text
)
RETURNS TABLE (
  token text,
  full_name text,
  accepted_at timestamptz,
  waiver_version text,
  privacy_version text,
  reused boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
#variable_conflict use_column
DECLARE
  v_email text := lower(btrim(p_email));
  v_name text := btrim(p_full_name);
  v_waiver text;
  v_privacy text;
  v_id uuid;
BEGIN
  IF p_age_attestation IS NOT TRUE THEN
    RAISE EXCEPTION 'A guest must confirm they are 19 or older'
      USING ERRCODE = 'P0001', HINT = 'guest_waiver_age';
  END IF;

  SELECT d.version INTO v_waiver FROM public.legal_documents d WHERE d.document = 'waiver';
  SELECT d.version INTO v_privacy FROM public.legal_documents d WHERE d.document = 'privacy_policy';
  IF v_waiver IS NULL OR v_privacy IS NULL THEN
    RAISE EXCEPTION 'The waiver or the privacy policy is not published'
      USING ERRCODE = 'P0001', HINT = 'guest_waiver_no_document';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('guest_waiver:' || v_email));

  -- A resubmit within ten minutes gets the row it already made. The name has
  -- to match as well: on the email alone, anybody typing a stranger's address
  -- would be shown that stranger's name and handed their proof link.
  RETURN QUERY
    SELECT g.token, g.full_name, g.accepted_at, g.waiver_version, g.privacy_version, true
      FROM public.guest_waiver_signings g
     WHERE g.email = v_email
       AND g.full_name = v_name
       AND g.waiver_version = v_waiver
       AND g.privacy_version = v_privacy
       AND g.accepted_at > now() - interval '10 minutes'
     ORDER BY g.accepted_at DESC
     LIMIT 1;
  IF FOUND THEN
    RETURN;
  END IF;

  IF (SELECT count(*) FROM public.guest_waiver_signings g
       WHERE g.email = v_email AND g.accepted_at > now() - interval '24 hours') >= 5 THEN
    RAISE EXCEPTION 'Too many guest signings for this email today'
      USING ERRCODE = 'P0001', HINT = 'guest_waiver_email_limit';
  END IF;

  IF p_ip_hash IS NOT NULL
     AND (SELECT count(*) FROM public.guest_waiver_signings g
           WHERE g.ip_hash = p_ip_hash AND g.accepted_at > now() - interval '1 hour') >= 60 THEN
    RAISE EXCEPTION 'Too many guest signings from this network in the last hour'
      USING ERRCODE = 'P0001', HINT = 'guest_waiver_ip_limit';
  END IF;

  INSERT INTO public.guest_waiver_signings AS g
    (full_name, email, waiver_version, privacy_version, age_attestation, user_agent, ip_hash, token)
  VALUES
    (v_name, v_email, v_waiver, v_privacy, true, left(p_user_agent, 500), p_ip_hash, p_token)
  RETURNING g.id INTO v_id;

  RETURN QUERY
    SELECT g.token, g.full_name, g.accepted_at, g.waiver_version, g.privacy_version, false
      FROM public.guest_waiver_signings g
     WHERE g.id = v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.sign_guest_waiver(text, text, boolean, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sign_guest_waiver(text, text, boolean, text, text, text) TO service_role;

-- 4. VERIFY --------------------------------------------------------------------
DO $verify$
DECLARE
  v_tbl text := 'public.guest_waiver_signings';
  v_fn  text := 'public.sign_guest_waiver(text, text, boolean, text, text, text)';
  v_def text;
  v_sec boolean;
  v_cfg text[];
  v_acl text;
BEGIN
  FOR v_def IN
    SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
     WHERE c.conname IN ('players_permission_vocabulary_check',
                         'permission_baselines_vocabulary_check')
  LOOP
    IF position(quote_literal('page.access.guest_waivers') IN v_def) = 0 THEN
      RAISE EXCEPTION '00254: a vocabulary CHECK does not admit page.access.guest_waivers';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('players_permission_vocabulary_check',
                         'permission_baselines_vocabulary_check')) <> 2 THEN
    RAISE EXCEPTION '00254: expected both vocabulary CHECKs to exist';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_tbl::regclass) THEN
    RAISE EXCEPTION '00254: % does not have row level security on', v_tbl;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'guest_waiver_signings') THEN
    RAISE EXCEPTION '00254: % has a policy, and it must have none', v_tbl;
  END IF;
  IF has_table_privilege('anon', v_tbl, 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', v_tbl, 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION '00254: anon or authenticated holds a privilege on %', v_tbl;
  END IF;
  IF NOT has_table_privilege('service_role', v_tbl, 'SELECT')
     OR has_table_privilege('service_role', v_tbl, 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION '00254: service_role must hold SELECT and only SELECT on %', v_tbl;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = v_tbl::regclass AND contype = 'c'
       AND position('age_attestation IS TRUE' IN pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION '00254: the age CHECK on % is missing', v_tbl;
  END IF;

  SELECT prosecdef, proconfig, coalesce(proacl::text, '') INTO v_sec, v_cfg, v_acl
    FROM pg_proc WHERE oid = v_fn::regprocedure;
  IF NOT v_sec THEN
    RAISE EXCEPTION '00254: % is not SECURITY DEFINER', v_fn;
  END IF;
  IF v_cfg IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_cfg)) THEN
    RAISE EXCEPTION '00254: % has no pinned search_path: %', v_fn, v_cfg;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00254: % is executable by anon or authenticated', v_fn;
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00254: service_role cannot execute %', v_fn;
  END IF;
  IF v_acl = '' OR v_acl ~ '(^|[{,])=X' THEN
    RAISE EXCEPTION '00254: PUBLIC can execute %: %', v_fn, v_acl;
  END IF;
END
$verify$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- AFTER THE MIGRATION
--
-- It has a top-level BEGIN/COMMIT, so apply it WITHOUT --single-transaction.
-- A new table and function, so regenerate database.gen.ts from a database
-- that has this and read the diff; until then the app carries hand-written
-- row types. Regenerate the release manifest (./scripts/gen-migration-
-- manifest.sh) if this file changes.
--
-- Set GUEST_WAIVER_IP_SALT on the player app, or only the email throttle runs.
-- Republish the privacy policy to cover guests BEFORE switching guest_waivers
-- on; the switch is off until somebody does.
--
-- VERIFYING IT
--
--   SELECT relacl FROM pg_class WHERE oid = 'public.guest_waiver_signings'::regclass;
--   -- expect postgres=arwdDxt.../postgres and service_role=r/postgres only
--   SELECT proacl FROM pg_proc
--    WHERE oid = 'public.sign_guest_waiver(text, text, boolean, text, text, text)'::regprocedure;
--   -- expect postgres=X/postgres and service_role=X/postgres only
--   SET ROLE anon; SELECT count(*) FROM public.guest_waiver_signings; RESET ROLE;
--   -- expect ERROR 42501 permission denied, NOT a count of 0
-- ============================================================================
