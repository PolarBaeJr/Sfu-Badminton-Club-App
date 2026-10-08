-- ============================================================
-- 00241 THE DATA API GETS ITS KEYS
--
-- WHAT IS CREATED: two tables (`data_api_consumers`, `data_api_keys`), one
-- role (`data_api_reader`), one view (`data_api_player_feed`) and four
-- functions. 00238 taught the capability vocabulary the three key strings;
-- this is the storage and the read path underneath them. The service itself
-- is not in this migration and does not exist yet.
--
-- ------------------------------------------------------------
-- WHY TWO TABLES AND NOT ONE
-- ------------------------------------------------------------
-- THE SALT IS PER CONSUMER, NOT PER KEY. `player_ref` is a salted hash of a
-- member's internal id, and the contract (apps/data-api/API.md) promises the
-- consumer that it is "stable forever". It also promises that a lost key is
-- revoked and a new one issued. Those two promises are only compatible if the
-- salt outlives the key: with a per-key salt, reissuing after a leak would
-- silently change EVERY `player_ref` the consumer holds, their join keys would
-- stop matching their own history, and nothing anywhere would raise an error.
-- The consumer row is the thing that persists; the key row is the credential
-- that comes and goes. One table cannot express that.
--
-- ------------------------------------------------------------
-- WHY REVOKE KEEPS THE ROW
-- ------------------------------------------------------------
-- `revoked_at`, `revoked_by` and `revoke_reason` are set and the row stays.
-- The row is the audit record of who could read the club's data, from when to
-- when, and on whose authority. Deleting it destroys exactly the fact somebody
-- would want after a leak. That is why the capability 00238 landed is called
-- `accounts.apikey.revoke.write` and not `.delete.write`, and it is why
-- neither table below is granted DELETE to anybody: the convention is made
-- structural rather than left to whoever writes the next server action.
--
-- ------------------------------------------------------------
-- WHY THE SALT NEVER LEAVES POSTGRES
-- ------------------------------------------------------------
-- `data_api_consumers.player_ref_salt` is DEFAULTED in the database, read only
-- by a SECURITY DEFINER function, and excluded from the column-level SELECT
-- grant the console's service role holds. Nothing above the database can read
-- it, so "nobody outside the club can turn a player_ref back into a person"
-- does not depend on an application remembering not to select a column. The
-- same posture 00032 took with the PII columns on `players`.
--
-- ------------------------------------------------------------
-- WHY A NEW ROLE
-- ------------------------------------------------------------
-- The service needs to execute two functions and reach nothing else.
-- `data_api_reader` is NOLOGIN NOINHERIT and holds EXECUTE on
-- `data_api_verify_key` and `data_api_players` and on nothing else in this
-- database: not `players`, not the two tables below, not the feed view.
-- `GRANT data_api_reader TO authenticator` opens the PostgREST JWT-role path,
-- which is the door that needs no credential. The other door, a direct
-- connection, needs `ALTER ROLE data_api_reader LOGIN PASSWORD ...`, and a
-- password is a credential and therefore the owner's to mint, not this file's.
-- The function signatures are identical either way, so choosing later costs
-- nothing.
--
-- The role is created inside a guard because roles are CLUSTER GLOBALS. They
-- live outside the database, a `pg_restore` of one database does not carry
-- them, and the nightly staging scrub may or may not have one. An unguarded
-- CREATE ROLE aborts the whole migration on the second environment it meets.
--
-- ------------------------------------------------------------
-- THE NIGHTLY SCRUB WOULD HAVE UNDONE HALF OF THIS, SILENTLY.
-- ------------------------------------------------------------
-- prod-to-dev-snapshot.sh drops and recreates `public` on staging every night
-- and then replays production's privileges through scripts/sql/
-- mirror-public-acls.sql. That file mirrored grants for exactly four grantees
-- (PUBLIC, anon, authenticated, service_role) and read only table-level ACLs.
-- Neither covers this migration: the reader role is not on that list, and the
-- grant that matters most here is COLUMN level, on `data_api_consumers`.
--
-- So the pre-existing behaviour was: staging comes back each morning with
-- these tables restored and `data_api_reader` holding nothing on them. The
-- data API answers with an empty member list. Not an error, not a log line, on
-- the one database the club uses to rehearse migrations before production sees
-- them. The same class of bug as the one 00157 exists to clean up.
--
-- Fixed in the mirror rather than worked around here, because a note in this
-- header telling somebody to re-grant by hand every morning is not a fix. That
-- file now reads `pg_attribute.attacl` as well as `pg_class.relacl`, and names
-- this role in an allowlist CTE. It emits nothing for the role when the source
-- database has not applied 00241, so it stays safe to run everywhere.
--
-- ------------------------------------------------------------
-- NO PGCRYPTO. THIS WAS PROBED, NOT ASSUMED.
-- ------------------------------------------------------------
-- The obvious way to write the hash below is `hmac()` with `gen_random_bytes()`
-- for the salt. Both live in the `pgcrypto` extension, and on this cluster
-- pgcrypto is installed in the `extensions` schema, NOT in `public`. Every
-- function in this repository pins `SET search_path TO 'public','pg_temp'`, so
-- inside one of them neither name resolves and the migration would have failed
-- on apply, in the owner's hands, with an undefined-function error. Zero of the
-- 229 migrations before this one call a pgcrypto function, so nothing in this
-- directory ever demonstrated otherwise.
--
-- What is used instead is core `pg_catalog`, present on PG 17.6 with no
-- extension at all:
--   salt   gen_random_uuid()::text || gen_random_uuid()::text  (244 bits)
--   hash   encode(sha256(convert_to(..., 'utf8')), 'hex')
--
-- ------------------------------------------------------------
-- ALTERNATIVES REJECTED
-- ------------------------------------------------------------
--   ONE TABLE, with the salt on the key row. Rejected above: reissuing a key
--   would rotate every pseudonym the consumer holds, silently.
--
--   THE SALT IN THE SERVICE'S ENVIRONMENT. Rejected because it makes the
--   pseudonym boundary a property of a `.env` file on a host: anybody who can
--   read that file, or a backup of it, can recompute every `player_ref` from a
--   roster they already have. It would also be one salt for all consumers,
--   which breaks the "two consumers cannot cross-join their datasets" property
--   the contract states.
--
--   GRANTING THE FEED TO `anon`. Rejected: `anon` is what an unauthenticated
--   PostgREST request resolves to, so this would publish the club's rating
--   table to the internet, and the edge leaves `/supabase` unrate-limited on
--   both hosts. The key would decorate a door that was already open.
--
--   USING `service_role`. Rejected by construction, not by preference.
--   `service_role` is BYPASSRLS and carries the default grants on everything in
--   `public`, so a service holding it can read `players` in full. There is no
--   arrangement of this migration that isolates a role which is defined by not
--   being isolated. The verification block at the end asserts the isolation
--   against `data_api_reader`, which is a claim that can only be made about a
--   role that holds nothing to begin with.
-- ============================================================

BEGIN;

-- ---- 1. THE CONSUMERS -----------------------------------------------------
--
-- One row per organisation or person the club has agreed to give data to. The
-- name is what an admin types in the panel and is what the key is grouped
-- under, so it is unique and trimmed-non-empty rather than free text.
--
-- NO COLUMN HERE IS CALLED `player_id`, and that is deliberate rather than
-- incidental: deleted-identity.test.ts partitions every table whose CREATE
-- TABLE body has a line beginning `player_id` into the purge-coverage set, and
-- a consumer is an outside organisation, not a member. `created_by` is the
-- officer who wrote the row down, which is the honest name for it anyway.
CREATE TABLE IF NOT EXISTS public.data_api_consumers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  player_ref_salt text NOT NULL DEFAULT (gen_random_uuid()::text || gen_random_uuid()::text),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.players(id) ON DELETE SET NULL,
  notes text,
  CONSTRAINT data_api_consumers_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 80)
);

COMMENT ON TABLE public.data_api_consumers IS
  'One row per outside party the club issues data API keys to. Holds the per-consumer salt behind every player_ref that party sees, which is why two consumers cannot cross-join their datasets.';

-- The immutability rule has to be stated in words because no constraint
-- expresses "never updated" without a trigger, and a trigger for a rule with
-- no write path to break it would be ceremony. There is no UPDATE of this
-- column anywhere in the application, and there must never be: rewriting it
-- changes every player_ref the consumer has ever been handed, with no error
-- and no symptom on this side.
COMMENT ON COLUMN public.data_api_consumers.player_ref_salt IS
  'NEVER UPDATED once written. Changing it silently rotates every player_ref this consumer holds and breaks their join keys with no error anywhere. Readable only by data_api_player_ref(), and withheld from the console service role by column-level grant.';

-- ---- 2. THE KEYS ----------------------------------------------------------
--
-- `key_prefix` is not decoration. The plaintext is gone the moment it is shown
-- and the hash is not something to put on a screen, so without a prefix the
-- panel cannot tell an admin WHICH of three keys they are about to revoke.
--
-- ON DELETE RESTRICT on `consumer_id`, because a consumer with keys against it
-- is the audit record those keys belong to.
--
-- `minted_by` and `revoked_by` are NULLABLE with ON DELETE SET NULL, and the
-- combination is the point: NOT NULL plus SET NULL is a contradiction that
-- surfaces as a constraint violation during an account deletion, at the worst
-- possible moment. The key must outlive the minter's own account, because the
-- key is the thing that read the data.
CREATE TABLE IF NOT EXISTS public.data_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id uuid NOT NULL REFERENCES public.data_api_consumers(id) ON DELETE RESTRICT,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  label text,
  scopes text[] NOT NULL,
  minted_by uuid REFERENCES public.players(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.players(id) ON DELETE SET NULL,
  revoke_reason text,
  CONSTRAINT data_api_keys_prefix_length CHECK (length(key_prefix) BETWEEN 4 AND 20),
  -- The three strings the contract names. `ratings:history:read` is admitted
  -- and backed by nothing: no table in this database journals per-match rating
  -- movement, so a key carrying it gets an empty history rather than a 403.
  -- That is recorded in API.md as accepted-and-empty rather than quietly
  -- dropped from the vocabulary, because 00238 and the contract both name it.
  CONSTRAINT data_api_keys_scope_vocabulary
    CHECK (scopes <@ ARRAY['players:read', 'matches:read', 'ratings:history:read']::text[]),
  -- cardinality(), NOT array_length(). `array_length('{}', 1)` is NULL, and a
  -- CHECK only refuses a row when the expression is FALSE, so the obvious
  -- `array_length(scopes, 1) >= 1` admits the empty array it was written to
  -- refuse. `cardinality('{}')` is 0.
  CONSTRAINT data_api_keys_scope_not_empty CHECK (cardinality(scopes) >= 1),
  CONSTRAINT data_api_keys_expiry_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

COMMENT ON TABLE public.data_api_keys IS
  'Issued data API keys. THE PLAINTEXT KEY EXISTS NOWHERE IN THIS DATABASE: only a sha256 hex digest of it and a short display prefix. A key nobody can find is a key nobody can recover, which is why the panel shows it exactly once. Revoking sets revoked_at and keeps the row.';

-- One index, on the column the panel groups by. NO PARTIAL INDEX ON LIVE KEYS:
-- this table holds a handful of rows and will hold a handful for years, so an
-- index whose only job is to skip the revoked ones would cost more to maintain
-- than the sequential scan it replaces. The UNIQUE on key_hash is what the
-- verification probe rides on, and that index already exists by construction.
CREATE INDEX IF NOT EXISTS idx_data_api_keys_consumer ON public.data_api_keys (consumer_id);

-- ---- 3. THE ROLE ----------------------------------------------------------
--
-- Guarded: see the header. Roles are cluster globals and this file is applied
-- to more than one database.
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'data_api_reader') THEN
    CREATE ROLE data_api_reader NOLOGIN NOINHERIT;
  END IF;
END $role$;

-- PostgREST switches to the role named in the JWT, and it can only switch to a
-- role `authenticator` is a member of. Without this line the JWT path answers
-- 42501 for every request and no amount of granting on the functions helps.
GRANT data_api_reader TO authenticator;

COMMENT ON ROLE data_api_reader IS
  'The data API service. NOLOGIN NOINHERIT. Holds EXECUTE on data_api_verify_key and data_api_players and nothing else: no table, no view, no column of players.';

-- ---- 4. THE FEED VIEW -----------------------------------------------------
--
-- Every column on this view was chosen. There is no name, email, phone,
-- avatar_url, handle, display_name, full_name, first_name, last_name, bio,
-- member_code or Discord column on it, and `p.id` is present only because
-- computing a pseudonym requires the thing being pseudonymised.
CREATE OR REPLACE VIEW public.data_api_player_feed AS
  SELECT
    p.id,
    -- Population columns, in the feed so the function below can filter on them
    -- rather than reaching back into `players` for a second time.
    p.active_flag,
    p.status,
    -- Privacy columns. Both are filters in the function, and both are on the
    -- view so that the predicate and the data come from the same place.
    p.hide_from_leaderboard,
    p.deletion_requested_at,
    -- The figures, exactly the ones API.md documents.
    r.singles_elo,
    r.doubles_elo,
    r.singles_provisional,
    r.doubles_provisional,
    r.singles_matches_played,
    r.doubles_matches_played,
    r.singles_wins,
    r.singles_losses,
    r.doubles_wins,
    r.doubles_losses,
    r.updated_at
  FROM public.players p
  JOIN public.ratings r ON r.player_id = p.id;

COMMENT ON VIEW public.data_api_player_feed IS
  'THE COLUMN LIST OF THIS VIEW IS THE PRIVACY BOUNDARY of the data API. Adding a column here is a privacy change and must be argued as one, not reviewed as a widening of a query. Reachable only through data_api_players(); no role holds SELECT on it.';

-- REVOKE-THEN-NOTHING, and the revoke has to name service_role too. Supabase
-- ships ALTER DEFAULT PRIVILEGES in `public` granting anon, authenticated AND
-- service_role on newly created relations (00117:85-92 states this and 00073
-- pays for it), so a bare CREATE VIEW is world-readable at birth and
-- "reachable only through the function" would be false the moment it was
-- written down.
--
-- NOBODY IS GRANTED IT BACK, `data_api_reader` INCLUDED. Granting the reader
-- role SELECT here would hand it `players.id` directly, and `players.id` is the
-- input to the pseudonym. The whole point of the SECURITY DEFINER function
-- below is that the id goes in and only the hash comes out.
REVOKE ALL ON public.data_api_player_feed FROM PUBLIC, anon, authenticated, service_role;

-- ---- 5. THE PSEUDONYM -----------------------------------------------------
--
-- SALT ON BOTH ENDS. `sha256(salt || player_id)` would be length-extendable:
-- given one hash an attacker can compute the hash of a longer input without
-- knowing the salt. That attack is not reachable here, because a valid ref only
-- ever comes from a fixed-format UUID and there is nothing to extend it with.
-- The bracketing costs one line and saves the next reader the hour it takes to
-- reach that conclusion themselves.
--
-- SECURITY DEFINER because the salt is not readable by the caller, which is the
-- property the whole scheme rests on.
CREATE OR REPLACE FUNCTION public.data_api_player_ref(p_consumer_id uuid, p_player_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT encode(
    sha256(convert_to(
      c.player_ref_salt || ':' || p_player_id::text || ':' || c.player_ref_salt,
      'utf8'
    )),
    'hex'
  )
  FROM data_api_consumers c
  WHERE c.id = p_consumer_id;
$function$;

COMMENT ON FUNCTION public.data_api_player_ref(uuid, uuid) IS
  'The per-consumer pseudonym for a member. Salted on both ends of the id so the digest is not length-extendable. Internal helper: no role is granted EXECUTE, and it is reached only from the two feed functions, which run as their definer.';

-- An internal helper gets no grant at all. The REVOKE still names anon and
-- authenticated explicitly, with the parenthesised argument list, because
-- REVOKE ... FROM PUBLIC does not remove the explicit grants Supabase's default
-- privileges minted (00126, 00187), and because function-grant-drift.test.ts
-- reads this line as text.
REVOKE ALL ON FUNCTION public.data_api_player_ref(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---- 6. KEY VERIFICATION --------------------------------------------------
--
-- IT TAKES THE HASH, NEVER THE PLAINTEXT. A plaintext key passed as a bound
-- parameter can land in `log_statement` output, in a PostgREST log line, or in
-- a slow-query report, and a key in a log is a key that has left the service.
-- The service hashes the bearer token itself and sends the digest.
--
-- UNKNOWN, EXPIRED AND REVOKED ALL RETURN ZERO ROWS, indistinguishably. That is
-- what lets the service answer one identical 401 to all three without anybody
-- having to remember to: there is no branch to forget. API.md promises exactly
-- that, in five cases.
--
-- The contract also permits the service to cache a verification result for up
-- to 30 seconds, which is the reason there is no `last_used_at` column on
-- `data_api_keys`. Stamping one per request would turn the hot read path into a
-- write and make the cache useless, to record a fact nothing asks for.
CREATE OR REPLACE FUNCTION public.data_api_verify_key(p_key_hash text)
RETURNS TABLE(consumer_id uuid, key_id uuid, scopes text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT k.consumer_id, k.id, k.scopes
  FROM data_api_keys k
  WHERE k.key_hash = p_key_hash
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now());
$function$;

COMMENT ON FUNCTION public.data_api_verify_key(text) IS
  'Resolves a key HASH to its consumer, key id and scopes. Unknown, expired and revoked keys are all zero rows, so the service cannot accidentally distinguish them to a caller. Never takes a plaintext key.';

REVOKE ALL ON FUNCTION public.data_api_verify_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_verify_key(text) TO data_api_reader;

-- ---- 7. THE FEED ----------------------------------------------------------
--
-- The column names and order are API.md's, so the service can select them
-- straight through without a mapping layer that could disagree with the
-- contract.
CREATE OR REPLACE FUNCTION public.data_api_players(p_consumer_id uuid)
RETURNS TABLE(
  player_ref text,
  singles_elo int,
  doubles_elo int,
  singles_provisional boolean,
  doubles_provisional boolean,
  singles_matches_played int,
  doubles_matches_played int,
  singles_wins int,
  singles_losses int,
  doubles_wins int,
  doubles_losses int,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    data_api_player_ref(p_consumer_id, f.id),
    f.singles_elo,
    f.doubles_elo,
    f.singles_provisional,
    f.doubles_provisional,
    f.singles_matches_played,
    f.doubles_matches_played,
    f.singles_wins,
    f.singles_losses,
    f.doubles_wins,
    f.doubles_losses,
    f.updated_at
  FROM data_api_player_feed f
  -- POPULATION, not privacy. A resigned or removed member is not part of the
  -- club's current roster, and the public leaderboard draws the same line at
  -- 00003_functions.sql:143.
  WHERE f.active_flag = TRUE
  -- POPULATION, not privacy. Somebody awaiting approval has not been admitted
  -- yet and somebody suspended is not currently a member. 00003_functions.sql:145.
    AND f.status NOT IN ('pending_approval', 'suspended')
  -- PRIVACY CONTROL, not a filter. hide_from_leaderboard is a member's standing
  -- instruction that their figures are not published, and an external feed is
  -- publication. 00003_functions.sql:144 applies the same control to the public
  -- leaderboard.
    AND f.hide_from_leaderboard = FALSE
  -- PRIVACY CONTROL, not a filter. Effective the moment the request is made, not
  -- at the next purge run. The purge ANONYMIZES rather than deletes, so the row
  -- survives with its ratings intact, and this predicate is the only thing
  -- keeping it out of the feed.
    AND f.deletion_requested_at IS NULL;
$function$;

COMMENT ON FUNCTION public.data_api_players(uuid) IS
  'The players feed for one consumer. Two of its four WHERE arms are privacy controls rather than filters: hide_from_leaderboard is a member instruction, and deletion_requested_at bites immediately because the purge anonymizes rather than deletes. Removing either is a privacy change.';

REVOKE ALL ON FUNCTION public.data_api_players(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_players(uuid) TO data_api_reader;

-- ---- 8. ONE PLAYER BY REF -------------------------------------------------
--
-- RECOMPUTES THE PSEUDONYM ACROSS THE ELIGIBLE POPULATION rather than looking
-- the ref up in a table. A ref-to-id table would be the obvious index, and it
-- is a privacy regression: it puts the mapping from pseudonym back to member on
-- disk, in the same database as the roster, where today the mapping exists only
-- as a computation nobody can run without the salt. Every backup would then
-- carry the de-anonymisation table.
--
-- THE ROW-COUNT ASSUMPTION, stated so the next person does not have to measure
-- it. This hashes once per eligible member per request: about forty rows today,
-- and a sha256 of a sixty-character string is microseconds. It is linear, and
-- at a few thousand members with a busy consumer it would stop being free. The
-- scaling answer IS the lookup table, and adopting it is an owner decision
-- about privacy rather than a performance patch somebody applies quietly.
CREATE OR REPLACE FUNCTION public.data_api_player_by_ref(p_consumer_id uuid, p_player_ref text)
RETURNS TABLE(
  player_ref text,
  singles_elo int,
  doubles_elo int,
  singles_provisional boolean,
  doubles_provisional boolean,
  singles_matches_played int,
  doubles_matches_played int,
  singles_wins int,
  singles_losses int,
  doubles_wins int,
  doubles_losses int,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Both sides qualified with the alias. This function's own RETURNS TABLE
  -- declares a column called `player_ref` too, and an unqualified reference to
  -- that name inside the body is ambiguous between the output column and the
  -- feed's.
  SELECT f.*
  FROM data_api_players(p_consumer_id) AS f
  WHERE f.player_ref = p_player_ref;
$function$;

COMMENT ON FUNCTION public.data_api_player_by_ref(uuid, text) IS
  'One player by their per-consumer pseudonym. Recomputes the refs over the eligible population rather than reading a ref-to-id table, because such a table would put the de-anonymisation mapping on disk and into every backup. Linear in the roster; see the migration header for when that stops being free.';

REVOKE ALL ON FUNCTION public.data_api_player_by_ref(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.data_api_player_by_ref(uuid, text) TO data_api_reader;

-- ---- 9. TABLE LOCKDOWN ----------------------------------------------------
--
-- THE REVOKE NAMES service_role, WHICH LOOKS WRONG AND IS NOT. Supabase's
-- ALTER DEFAULT PRIVILEGES grants anon, authenticated and service_role on every
-- new table in `public`, so at this point in the file the console's admin
-- client already holds SELECT on `player_ref_salt` and DELETE on both tables.
-- Two claims made further up would then be false: that the salt never leaves
-- Postgres, and that no DELETE grant exists. Starting from nothing and granting
-- back precisely what is intended is the only version of this that says what it
-- means, which is 00126 and 00187's rule applied to tables.
REVOKE ALL ON public.data_api_consumers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.data_api_keys      FROM PUBLIC, anon, authenticated, service_role;

-- COLUMN-LEVEL SELECT, in the 00032_players_pii_lockdown.sql:36-51 style. The
-- panel needs every column here except the salt, and the salt is the one the
-- pseudonym rests on. Naming the readable columns rather than revoking the one
-- unreadable one means a column added later is withheld until somebody decides
-- otherwise, which is the right default for this table.
GRANT SELECT (id, name, created_at, created_by, notes) ON public.data_api_consumers TO service_role;
GRANT INSERT, UPDATE ON public.data_api_consumers TO service_role;

-- No column-level grant on the keys table: `key_hash` is the only sensitive
-- column and the panel never selects it, but a hash of 32 random bytes is not a
-- credential anybody can use. The line that matters here is the absence of
-- DELETE.
GRANT SELECT, INSERT, UPDATE ON public.data_api_keys TO service_role;

-- RLS ON, WITH NO POLICIES, on both. `service_role` is BYPASSRLS so the console
-- is unaffected and the panel works. What this buys is the braces: if a future
-- migration or a console tool ever re-grants either table to `authenticated`,
-- the rows still do not come out. The same arrangement 00117 uses for the
-- private match notes, and for the same reason.
ALTER TABLE public.data_api_consumers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_api_keys      ENABLE ROW LEVEL SECURITY;

-- ---- 10. VERIFICATION -----------------------------------------------------
--
-- THE ISOLATION IS ASSERTED, NOT DESCRIBED. If any of it is untrue when this is
-- applied, the migration aborts and nothing lands, which is the only way a
-- claim in a comment above becomes a property of the database.
--
-- has_*_privilege throughout and never information_schema: information_schema
-- reports grants that do not exist, and has_*_privilege resolves PUBLIC and
-- role inheritance, which is the question PostgREST's role actually asks.
-- information_schema.columns IS used below, but only to ask whether a COLUMN
-- EXISTS, which it answers correctly and which has_column_privilege does not
-- tolerate being wrong about: it raises on a column that is not there.
DO $verify$
DECLARE
  v_col   TEXT;
  v_fn    TEXT;
  v_bad   TEXT := '';
BEGIN
  -- 1. The role cannot read the roster at all.
  IF has_table_privilege('data_api_reader', 'public.players', 'SELECT') THEN
    v_bad := v_bad || 'data_api_reader holds SELECT on players; ';
  END IF;

  -- 2. Nor any single identifier column of it. Table-level SELECT and
  --    column-level SELECT are separate grants and the first check does not
  --    imply the second. Each column is guarded by an existence test so that a
  --    column this schema does not have (the Discord ones live on
  --    player_discord_links, not here) cannot abort the migration.
  FOREACH v_col IN ARRAY ARRAY[
    'first_name', 'last_name', 'full_name', 'display_name', 'handle',
    'email', 'phone', 'avatar_url', 'bio', 'member_code',
    'discord_user_id', 'discord_username'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'players' AND column_name = v_col
    ) AND has_column_privilege('data_api_reader', 'public.players', v_col, 'SELECT') THEN
      v_bad := v_bad || format('data_api_reader holds SELECT on players.%s; ', v_col);
    END IF;
  END LOOP;

  -- 3. Nor the key store, nor the consumers, nor the feed view. The view is the
  --    one most easily granted by accident, because it looks harmless and
  --    carries players.id.
  IF has_table_privilege('data_api_reader', 'public.data_api_consumers', 'SELECT') THEN
    v_bad := v_bad || 'data_api_reader holds SELECT on data_api_consumers; ';
  END IF;
  IF has_table_privilege('data_api_reader', 'public.data_api_keys', 'SELECT') THEN
    v_bad := v_bad || 'data_api_reader holds SELECT on data_api_keys; ';
  END IF;
  IF has_table_privilege('data_api_reader', 'public.data_api_player_feed', 'SELECT') THEN
    v_bad := v_bad || 'data_api_reader holds SELECT on data_api_player_feed; ';
  END IF;

  -- 4. The salt is unreadable by the console's own client. This is the line
  --    that makes "the salt never leaves Postgres" a fact rather than a habit.
  IF has_column_privilege('service_role', 'public.data_api_consumers', 'player_ref_salt', 'SELECT') THEN
    v_bad := v_bad || 'service_role can read data_api_consumers.player_ref_salt; ';
  END IF;

  -- 5. THE OTHER DIRECTION. An over-zealous revoke that locked the service out
  --    of its own feed would pass every check above and break the API, and the
  --    symptom would be an empty list rather than an error.
  --
  --    Every function this migration grants is named here. Listing them in an
  --    array rather than writing the checks out one by one is deliberate: a
  --    later migration that adds a fifth function and grants it has to come
  --    back to this array, whereas it could very easily forget a hand-written
  --    IF. The three entries are the service's whole reachable surface.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_players(uuid)',
    'public.data_api_player_by_ref(uuid,text)',
    'public.data_api_verify_key(text)'
  ] LOOP
    IF NOT has_function_privilege('data_api_reader', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'data_api_reader LOST EXECUTE on ' || v_fn || '; ';
    END IF;
  END LOOP;

  -- 6. And none of them is reachable by a member's session or by a signed-out
  --    visitor, which is what the default privileges would have left behind if
  --    the REVOKEs above had named only PUBLIC. data_api_player_ref is in this
  --    list but NOT in the one above: it is an internal helper that the feed
  --    functions call while running as their definer, so nobody outside needs
  --    EXECUTE on it, the reader role included. It is the one function here
  --    that mints a pseudonym from a raw player id, so a grant on it is worth
  --    failing the migration over.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.data_api_players(uuid)',
    'public.data_api_player_by_ref(uuid,text)',
    'public.data_api_verify_key(text)',
    'public.data_api_player_ref(uuid,uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'anon can execute ' || v_fn || '; ';
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      v_bad := v_bad || 'authenticated can execute ' || v_fn || '; ';
    END IF;
  END LOOP;

  IF has_function_privilege('data_api_reader', 'public.data_api_player_ref(uuid,uuid)', 'EXECUTE') THEN
    v_bad := v_bad || 'data_api_reader can execute data_api_player_ref(uuid,uuid), which turns a player id into a pseudonym; ';
  END IF;

  -- 7. THE PROMISE THE CONTRACT IS BUILT ON, which until now nothing checked.
  --
  --    API.md tells a consumer that a player_ref is stable: they may store it,
  --    join their own records against it, and come back a year later expecting
  --    it to mean the same member. Every other assertion here is about who can
  --    reach what. This one is about whether the thing they reach is worth
  --    anything, and it is the assertion a future edit is most likely to break,
  --    because the salt concatenation above looks like an implementation detail
  --    and reads like one.
  --
  --    Breaking it is silent in the worst way. A changed construction does not
  --    error: it returns a different valid-looking digest, the consumer's joins
  --    start missing, and the members they thought they were tracking simply
  --    become strangers. No log line anywhere says why.
  --
  --    Two properties, on a row that exists only inside this transaction and is
  --    deleted three lines later. Same consumer twice must agree, and two
  --    consumers must disagree: the second is what makes the ref a per-consumer
  --    pseudonym rather than a global identifier that correlates across every
  --    recipient the club ever issues a key to.
  INSERT INTO data_api_consumers (id, name)
  --    The two names differ because `name` is UNIQUE. That is not a detail
  --    worth a comment except that the first draft of this block used the same
  --    name twice, and the constraint turned a stability check into a failed
  --    migration. Which is the system behaving correctly, and is why this block
  --    is run before it is trusted.
  VALUES ('00000000-0000-0000-0000-000000000241', '00241 self-check A'),
         ('00000000-0000-0000-0000-000000000242', '00241 self-check B');

  IF data_api_player_ref('00000000-0000-0000-0000-000000000241', '00000000-0000-0000-0000-0000000000aa')
     IS DISTINCT FROM
     data_api_player_ref('00000000-0000-0000-0000-000000000241', '00000000-0000-0000-0000-0000000000aa') THEN
    v_bad := v_bad || 'player_ref is not stable for one consumer, so every ref the API has ever issued is unjoinable; ';
  END IF;

  IF data_api_player_ref('00000000-0000-0000-0000-000000000241', '00000000-0000-0000-0000-0000000000aa')
     IS NOT DISTINCT FROM
     data_api_player_ref('00000000-0000-0000-0000-000000000242', '00000000-0000-0000-0000-0000000000aa') THEN
    v_bad := v_bad || 'two consumers produce the same player_ref, so the pseudonym correlates across recipients; ';
  END IF;

  DELETE FROM data_api_consumers
   WHERE id IN ('00000000-0000-0000-0000-000000000241',
                '00000000-0000-0000-0000-000000000242');

  IF v_bad <> '' THEN
    RAISE EXCEPTION '00241 verification failed: %', v_bad;
  END IF;
  RAISE NOTICE '00241 verified: data_api_reader reaches three functions and nothing else, the salt is unreadable above the database, and player_ref is stable per consumer and distinct across consumers.';
END
$verify$;

COMMIT;

-- PostgREST caches the schema. Without this the four functions exist in
-- Postgres and are invisible through the API, and a failed PostgREST read
-- arrives as an EMPTY LIST rather than an error, so the symptom would be a feed
-- that reports the club has no members.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFYING IT
--
-- WHAT THE DO $verify$ BLOCK ABOVE ALREADY DOES, so an abort is read correctly.
-- It is not a caveat attached to this migration; it is the migration refusing
-- to leave the database in a state whose privileges do not match what this
-- header claims. If it raises, NOTHING was applied: it runs inside the same
-- transaction, so the failure and the rollback are the same event. Read an
-- abort as the check earning its place, not as a fault in the apply.
--
-- Those seven assertions were executed before this file shipped, against a
-- throwaway PostgreSQL cluster carrying the two prerequisite tables and, in
-- the run that counts, Supabase's own
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES/FUNCTIONS
--   TO anon, authenticated, service_role;
-- which is the thing the REVOKEs here exist to defeat. The block compiled, all
-- seven passed, the two self-check rows left no residue, and four independent
-- catalogue checks agreed: service_role cannot read the salt, anon cannot read
-- the key store, and data_api_reader can neither read the salt nor execute
-- data_api_player_ref. Assertion 7 was then mutation-tested by removing the
-- salt from the digest, and it correctly refused the migration.
--
-- Two honest limits on that. The rehearsal cluster was PostgreSQL 16, this one
-- is 17.6; and `players` and `ratings` were minimal stubs carrying the view's
-- columns and nothing else, so the assertions were exercised, not the data.
-- Neither touches what the block asserts, both are worth knowing.
--
-- WHAT STILL HAS TO BE DONE BY HAND, below.
--
-- Run as data_api_reader, NOT as postgres. Superuser bypasses grants and RLS,
-- so a psql check as postgres proves nothing about the isolation this file
-- exists to create.
--
--   SET ROLE data_api_reader;
--
-- The roster is out of reach:
--
--   SELECT * FROM players LIMIT 1;
--   -- expect: ERROR  permission denied for table players
--
-- So is the key store, so a stolen service connection cannot mint or read keys:
--
--   SELECT * FROM data_api_keys LIMIT 1;
--   -- expect: ERROR  permission denied for table data_api_keys
--
-- And so is the view, which is the one that carries players.id:
--
--   SELECT * FROM data_api_player_feed LIMIT 1;
--   -- expect: ERROR  permission denied for view data_api_player_feed
--
-- The feed itself works. Take a consumer id from the panel, or:
--   (as postgres)  SELECT id, name FROM data_api_consumers;
--
--   SELECT * FROM data_api_players('<consumer-uuid>') LIMIT 5;
--   -- expect: rows of player_ref + ratings, and NO column naming anybody
--
--   RESET ROLE;
--
-- The pseudonym is stable and per consumer. Two consumers, one member, two
-- different refs, and each one the same on every call (as postgres):
--
--   SELECT c.name, data_api_player_ref(c.id, p.id)
--     FROM data_api_consumers c, players p
--    WHERE p.id = '<a-player-uuid>';
--
-- The privacy arms actually bite. Pick somebody in the feed, hide them, count,
-- put them back:
--
--   SELECT count(*) FROM data_api_players('<consumer-uuid>');        -- before
--   UPDATE players SET hide_from_leaderboard = TRUE WHERE id = '<a-player-uuid>';
--   SELECT count(*) FROM data_api_players('<consumer-uuid>');        -- one fewer
--   UPDATE players SET hide_from_leaderboard = FALSE WHERE id = '<a-player-uuid>';
--
-- A revoked key stops verifying, and the row stays:
--
--   UPDATE data_api_keys SET revoked_at = now() WHERE id = '<a-key-uuid>';
--   SELECT * FROM data_api_verify_key('<the-hash>');   -- expect zero rows
--   SELECT id, revoked_at FROM data_api_keys WHERE id = '<a-key-uuid>';  -- still there
-- ============================================================================
