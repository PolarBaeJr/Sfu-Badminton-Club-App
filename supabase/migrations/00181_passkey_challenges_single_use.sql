-- 00181_passkey_challenges_single_use.sql
--
-- A WebAuthn challenge must be usable exactly once. Today the only record of an
-- outstanding challenge is a signed cookie in the caller's own browser, cleared
-- by the verify route on every outcome. That is not single-use, for two
-- reasons:
--
--   1. CLEARING A COOKIE IS A RESPONSE HEADER, NOT A LOCK. Two requests
--      carrying the same cookie and the same assertion, issued before either
--      response is processed, both find a valid challenge and both verify.
--
--   2. THE SIGNATURE COUNTER CANNOT COVER FOR IT. iCloud- and Google-synced
--      passkeys — which is most of them — always report counter 0, so the
--      regression check in the verify routes has nothing to compare and the
--      replay is indistinguishable from a first use.
--
-- The fix is a server-side record that a single atomic UPDATE claims:
--
--   UPDATE ... SET consumed_at = now()
--    WHERE challenge_hash = $1 AND purpose = $2
--      AND consumed_at IS NULL AND expires_at > now()
--
-- Exactly one caller can make that statement affect a row. Everyone else gets
-- zero and is refused.
--
-- PURPOSE IS PART OF THE KEY, not decoration. The three flows issue
-- structurally identical challenges, so without it a challenge minted for a
-- player-app login could be presented to admin step-up. Binding the purpose at
-- issue time and requiring it at consume time makes that a mismatch rather
-- than a valid assertion.
--
-- ONLY A HASH IS STORED. The challenge is a bearer value for the length of the
-- ceremony; keeping the plaintext in a table would add a place to steal it from
-- for no benefit, since the only operation ever performed on it is equality.
--
-- The signed cookie STAYS. It still carries the challenge to the verify route
-- and still binds it to a user id. It simply stops being the authoritative
-- record of whether the challenge has been spent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.passkey_challenges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256 of the base64url challenge, hex encoded.
  challenge_hash text NOT NULL,
  purpose        text NOT NULL CHECK (purpose IN (
                   'player_login', 'player_register',
                   'admin_login',  'admin_register', 'admin_stepup')),
  -- NULL for a discoverable-credential login, where the user is not known
  -- until the assertion comes back.
  user_id        uuid,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  UNIQUE (challenge_hash, purpose)
);

-- The consume path's predicate, and the sweeper's.
CREATE INDEX IF NOT EXISTS passkey_challenges_expires_idx
  ON public.passkey_challenges (expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE public.passkey_challenges ENABLE ROW LEVEL SECURITY;
-- No policies: every access goes through the two SECURITY DEFINER functions
-- below. There is nothing here a member should read, including their own rows.

CREATE OR REPLACE FUNCTION public.issue_passkey_challenge(
  p_challenge_hash text,
  p_purpose        text,
  p_user_id        uuid,
  p_ttl_seconds    integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Opportunistic sweep. The table is write-once per ceremony and read once,
  -- so it would otherwise grow for ever; doing it here keeps it to one
  -- statement on a path that is already writing, with no scheduled job to
  -- forget about. Only rows well past any possible use are removed.
  DELETE FROM passkey_challenges WHERE expires_at < NOW() - INTERVAL '1 day';

  INSERT INTO passkey_challenges (challenge_hash, purpose, user_id, expires_at)
  VALUES (p_challenge_hash, p_purpose, p_user_id, NOW() + make_interval(secs => p_ttl_seconds))
  -- A repeat of the same hash and purpose means the caller re-issued: reset it
  -- rather than failing the ceremony. Cryptographically this cannot collide
  -- between two different ceremonies.
  ON CONFLICT (challenge_hash, purpose) DO UPDATE
    SET user_id     = EXCLUDED.user_id,
        expires_at  = EXCLUDED.expires_at,
        created_at  = NOW(),
        consumed_at = NULL;
END;
$function$;

-- Returns TRUE for the one caller that claimed it, FALSE for everyone else —
-- already consumed, expired, wrong purpose, or never issued.
CREATE OR REPLACE FUNCTION public.consume_passkey_challenge(
  p_challenge_hash text,
  p_purpose        text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  UPDATE passkey_challenges
     SET consumed_at = NOW()
   WHERE challenge_hash = p_challenge_hash
     AND purpose        = p_purpose
     AND consumed_at IS NULL
     AND expires_at  > NOW()
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.issue_passkey_challenge(text, text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_passkey_challenge(text, text, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.consume_passkey_challenge(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_passkey_challenge(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
