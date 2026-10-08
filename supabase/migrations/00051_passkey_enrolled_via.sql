-- ============================================================
-- 00051_passkey_enrolled_via.sql — stop a members'-app passkey
-- from arming the admin console's second factor
--
-- The two apps deliberately SHARE passkey_credentials: one RP ID
-- covers both hosts so a single passkey works everywhere. The
-- admin gate then read that shared table as consent to be gated
-- — has_passkeys() asks "does this user hold ANY passkey", so
-- enrolling one on the members' app silently flipped an exec
-- from the grace period into a hard gate on a different app.
--
-- That is exactly what happened on 2026-08-05: an exec enrolled
-- a passkey on the player app for convenience and lost access to
-- the exec panel, with no warning and no obvious connection
-- between the two actions.
--
-- Fix: record which app enrolled a credential, and have the gate
-- count only the ones enrolled through the admin console.
-- Signing in with any credential still works on both apps —
-- this changes only what ARMS the gate.
-- ============================================================

ALTER TABLE passkey_credentials
  ADD COLUMN IF NOT EXISTS enrolled_via TEXT NOT NULL DEFAULT 'player'
    CHECK (enrolled_via IN ('admin', 'player'));

COMMENT ON COLUMN passkey_credentials.enrolled_via IS
  'Which app enrolled this credential. Only ''admin'' credentials arm the admin console passkey gate; ''player'' ones are a members''-app convenience. Defaults to ''player'' so a new enrolment path can never arm the gate by omission.';

-- Backfill. The player-app enrolment route did not exist before its deploy on
-- 2026-08-05, so every credential older than that is necessarily admin-enrolled.
-- Verified against the only two rows in existence at the time of writing:
--   2026-08-02  role=admin, nickname 'Mac'  -> admin
--   2026-08-05  role=player/is_exec, no nickname, created 22:30 -> player
UPDATE passkey_credentials
   SET enrolled_via = 'admin'
 WHERE created_at < TIMESTAMPTZ '2026-08-05 21:00:00+00';

-- ============================================================
-- The gate
-- ============================================================

-- Signature and grants unchanged; only the predicate moves. The admin
-- middleware calls this to decide grace period vs hard gate, so narrowing it
-- here is the whole fix.
CREATE OR REPLACE FUNCTION has_passkeys(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM passkey_credentials pc
    JOIN players p ON p.id = pc.player_id
    WHERE p.user_id = p_user_id
      AND pc.enrolled_via = 'admin'
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- Keep the 00050 lockout guard pointed at the same thing
-- ============================================================

-- 00050 protects "at least one admin who can get in with a passkey". Now that
-- only admin-enrolled credentials arm the gate, counting player-enrolled ones
-- here would defend a credential that no longer gates anything — and would
-- happily let the last REAL admin passkey be deleted so long as some admin
-- held an unrelated members'-app one.
CREATE OR REPLACE FUNCTION admins_with_passkeys(
  p_excluding_credential UUID DEFAULT NULL,
  p_excluding_player UUID DEFAULT NULL
)
RETURNS INTEGER AS $$
  SELECT COUNT(DISTINCT p.id)::INTEGER
  FROM players p
  JOIN passkey_credentials pc ON pc.player_id = p.id
  WHERE p.role = 'admin'
    AND pc.enrolled_via = 'admin'
    AND (p_excluding_credential IS NULL OR pc.id <> p_excluding_credential)
    AND (p_excluding_player IS NULL OR p.id <> p_excluding_player);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;
