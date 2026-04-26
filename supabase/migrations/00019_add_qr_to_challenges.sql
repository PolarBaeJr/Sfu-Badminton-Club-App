-- ============================================================
-- 00019_add_qr_to_challenges.sql
--
-- Adds QR-code based result submission to challenges.
-- Admins generate a signed token (HMAC'd server-side) when a
-- challenge reaches 'accepted', embed it in a QR code, and
-- players scan it to land on /submit?cid=...&tok=... where they
-- can fill in scores without authenticating through the full app.
--
-- Columns:
--   qr_token         — the base64url signed token (unique, nullable)
--   qr_generated_at  — server timestamp when the QR was generated
--   qr_expires_at    — hard expiry (HMAC payload also carries exp)
--   submitted_via    — 'manual' | 'qr' — used for analytics + dashboard stat
-- ============================================================

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS qr_token TEXT,
  ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_via TEXT NOT NULL DEFAULT 'manual'
    CHECK (submitted_via IN ('manual', 'qr'));

-- Partial unique index — only non-null tokens have to be unique, so regenerating
-- (which nulls then re-sets) never collides.
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenges_qr_token
  ON challenges (qr_token)
  WHERE qr_token IS NOT NULL;

-- Lookup-only index for the admin analytics aggregate (submitted_via stat).
CREATE INDEX IF NOT EXISTS idx_challenges_submitted_via
  ON challenges (submitted_via)
  WHERE submitted_via = 'qr';
