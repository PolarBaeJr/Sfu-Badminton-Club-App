-- ============================================================
-- 00011_passkeys.sql — WebAuthn passkey credentials
--
-- Adds passkey_credentials (per-player WebAuthn credentials
-- backing the admin-app passkey gate) and has_passkeys(),
-- which the admin middleware calls to decide whether a user
-- is gated. Zero enrolled passkeys = grace period (full
-- access until first enrollment); one or more = hard gate.
-- ============================================================

-- ============================================================
-- PASSKEY CREDENTIALS
-- ============================================================

CREATE TABLE passkey_credentials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE, -- base64url WebAuthn credential ID
  public_key TEXT NOT NULL,           -- base64url COSE public key
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[],
  device_type TEXT,
  backed_up BOOLEAN,
  nickname TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_passkey_credentials_player ON passkey_credentials(player_id);

-- Helper: whether a user has any enrolled passkeys. Drives the admin
-- middleware gate (mirrors admin_access_level's style in 00003).
CREATE OR REPLACE FUNCTION has_passkeys(p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM passkey_credentials pc
    JOIN players p ON p.id = pc.player_id
    WHERE p.user_id = p_user_id
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION has_passkeys(UUID) TO authenticated;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE passkey_credentials ENABLE ROW LEVEL SECURITY;

-- Owners can read their own credentials. All writes go through the admin
-- app's service-role client (bypasses RLS), so there are deliberately no
-- INSERT/UPDATE/DELETE policies.
CREATE POLICY pc_select ON passkey_credentials FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()));
