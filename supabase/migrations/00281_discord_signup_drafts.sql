-- ============================================================================
-- 00281: A SIGN-UP STARTED IN DISCORD IS A DRAFT UNTIL THE EMAIL IS PROVEN
--
-- APPLY AFTER 00280. Nothing here depends on it.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS
-- ----------------------------------------------------------------------------
-- /signup in the bot walks a new member through every step the web onboarding
-- asks (name, the tournament events question, skill level, the four legal
-- documents, the age line, photo and video consent) and only THEN emails a
-- code. No auth user and no players row exists until every required answer is
-- in and the code is verified, so an abandoned sign-up leaves nothing behind
-- but a row here that expires.
--
-- The state cannot live in the bot. A Discord interaction token lasts fifteen
-- minutes, a component's state is gone when the bot restarts, and a second
-- replica can take the next click. So the answers are written here, keyed on
-- the Discord account, by the player app's service role.
--
--   public.discord_signup_drafts     one row per Discord account mid-sign-up
--   public.discord_signup_attempts   a rate-limit ledger, purged after a day
--
-- ----------------------------------------------------------------------------
-- WHY THE LEDGER IS ITS OWN TABLE
-- ----------------------------------------------------------------------------
-- The limits are per email address (three codes an hour) and per Discord
-- account (three sign-ups a day). A draft is deleted when it is cancelled or
-- finished, so counting drafts would let anybody reset both limits by pressing
-- Cancel. The ledger survives that and holds no address: the email is a
-- SHA-256 digest of the lowercased address, which is enough to count by and
-- not enough to read.
--
-- ----------------------------------------------------------------------------
-- PRIVACY
-- ----------------------------------------------------------------------------
-- A draft holds an email address, a name and possibly a phone number for at
-- most thirty minutes, for somebody who is not a member yet. Neither table has
-- a player id or a foreign key to players, so neither can reach a member's
-- data export; both are declared NOT_ABOUT_PLAYERS in the export registry.
-- Purged without a cron job: the app deletes a draft on completion and on
-- cancel, and deletes every expired draft and every ledger row older than a
-- day each time somebody starts a sign-up.
--
-- RLS on, no policy, and no grant to anon or authenticated: only the service
-- role reads or writes either table.
-- ============================================================================


-- ============================================================================
-- SECTION 1: the drafts
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.discord_signup_drafts (
  discord_user_id     text PRIMARY KEY CHECK (discord_user_id ~ '^\d{5,25}$'),
  email               text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  -- Lengths match profileSchema: first and last name 40, display name 2 to 40,
  -- phone the same pattern the web form takes.
  first_name          text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 40),
  last_name           text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 40),
  display_name        text CHECK (display_name IS NULL OR length(display_name) BETWEEN 2 AND 40),
  phone               text CHECK (phone IS NULL OR phone ~ '^\+?[0-9 ()-]{7,20}$'),
  skill_tier          text CHECK (skill_tier IS NULL OR skill_tier IN ('beginner', 'intermediate', 'advanced')),
  -- "Which events do you play in tournaments?" Men's is 'mens', Women's is
  -- 'womens', Open events only is NULL, the same three states the players
  -- column has. gender_answered is what tells "Open events only" from "not
  -- asked yet", and the code is not sent until it is true.
  competition_category text CHECK (competition_category IS NULL OR competition_category IN ('mens', 'womens')),
  gender_answered     boolean NOT NULL DEFAULT false,
  -- document -> the version the member was shown when they pressed I accept.
  accepted            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(accepted) = 'object'),
  age_attestation     boolean NOT NULL DEFAULT false,
  -- NULL until answered. Optional: either answer continues.
  media_consent       boolean,
  code_sent_at        timestamptz,
  send_count          integer NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  verify_attempts     integer NOT NULL DEFAULT 0 CHECK (verify_attempts >= 0),
  -- Set by the verify that claims the draft, so a double submit completes once.
  completing_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);

COMMENT ON TABLE public.discord_signup_drafts IS
  'A sign-up in progress from the Discord /signup command (00281). Pre-account scratch: no player id, deleted on completion or cancel, and expired rows purged when anybody starts a sign-up. Service role only.';

CREATE INDEX IF NOT EXISTS discord_signup_drafts_email
  ON public.discord_signup_drafts (lower(email));
CREATE INDEX IF NOT EXISTS discord_signup_drafts_expires_at
  ON public.discord_signup_drafts (expires_at);

ALTER TABLE public.discord_signup_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discord_signup_drafts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.discord_signup_drafts TO service_role;


-- ============================================================================
-- SECTION 2: the rate-limit ledger
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.discord_signup_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  discord_user_id text NOT NULL,
  -- 'draft' when a Discord account starts a new sign-up, 'send' when a code is
  -- emailed. A send carries the digest; a draft does not need one.
  kind            text NOT NULL CHECK (kind IN ('draft', 'send')),
  email_digest    text CHECK (email_digest IS NULL OR email_digest ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'send' OR email_digest IS NOT NULL)
);

COMMENT ON TABLE public.discord_signup_attempts IS
  'Rate-limit ledger for the Discord /signup command (00281): one row per sign-up started and per code sent. The email is a SHA-256 digest, never the address. No player id; rows older than a day are purged when anybody starts a sign-up. Service role only.';

CREATE INDEX IF NOT EXISTS discord_signup_attempts_user
  ON public.discord_signup_attempts (discord_user_id, kind, created_at);
CREATE INDEX IF NOT EXISTS discord_signup_attempts_email
  ON public.discord_signup_attempts (email_digest, created_at) WHERE email_digest IS NOT NULL;

ALTER TABLE public.discord_signup_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discord_signup_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.discord_signup_attempts TO service_role;


-- ============================================================================
-- SECTION 3: VERIFY
-- ============================================================================

DO $verify$
DECLARE
  v_table text;
  v_role  text;
  v_priv  text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.discord_signup_drafts', 'public.discord_signup_attempts'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_table::regclass) THEN
      RAISE EXCEPTION '00281: RLS is off on %', v_table;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_table::regclass) THEN
      RAISE EXCEPTION '00281: % has a policy; it is meant to have none', v_table;
    END IF;
    -- has_table_privilege reads the real ACL, unlike information_schema.
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION '00281: % holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF NOT has_table_privilege('service_role', v_table, 'SELECT')
       OR NOT has_table_privilege('service_role', v_table, 'INSERT')
       OR NOT has_table_privilege('service_role', v_table, 'DELETE') THEN
      RAISE EXCEPTION '00281: service_role cannot use %', v_table;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = v_table::regclass AND contype = 'f'
    ) THEN
      RAISE EXCEPTION '00281: % has a foreign key; it must not point at players', v_table;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('service_role', 'public.discord_signup_drafts', 'UPDATE') THEN
    RAISE EXCEPTION '00281: service_role cannot update the drafts';
  END IF;
END
$verify$;


NOTIFY pgrst, 'reload schema';
