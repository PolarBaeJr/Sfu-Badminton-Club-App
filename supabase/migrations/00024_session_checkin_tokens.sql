-- ============================================================
-- 00024_session_checkin_tokens.sql — QR check-in token per session
--
-- Adds session_checkin_tokens: one opaque token per session backing
-- the admin QR code and the player app's /checkin/[token] page. The
-- admin displays the QR, a logged-in player scans it with their phone
-- camera, and the page checks THEM in — player_id always comes from
-- their own session, never from the URL.
--
-- Security property, stated honestly: an unguessable token means the
-- check-in URL is not derivable from the public session UUID, so nobody
-- can check in to a session they never saw the code for. It does NOT
-- stop a scanned QR being photographed and forwarded to someone who
-- isn't in the gym — no URL-based QR can. The real bound on that is the
-- existing check-in window (session_checkin_open(), 00008) plus
-- admin-initiated rotation from the QR dialog.
--
-- Notes:
--   * Token shape is randomBytes(24).toString('hex') = 48 hex chars,
--     the same primitive as calendar_feed_tokens (00013). The player
--     validator and the admin generator agree via CHECKIN_TOKEN_REGEX
--     in packages/shared.
--   * Apply as a single transaction (psql --single-transaction),
--     matching the runbook — like every other migration here, this file
--     deliberately omits BEGIN/COMMIT.
--
-- Manual staging checklist (the action layer has no test harness):
--   1. Admin > Sessions > open session > "Check-in QR" > Generate code.
--      A QR renders and the URL is /checkin/<48 hex>.
--   2. Reopening the dialog shows the SAME code (get-or-create).
--   3. Scan while logged out -> /login?checkin=<token> -> after sign-in
--      you land on /checkin/<token> and are checked in.
--   4. Scan again -> "already checked in", not an error.
--   5. Scan outside the check-in window -> the window message.
--   6. "Rotate code" issues a new token; the old URL now says
--      "Invalid check-in code" and an audit row is written.
--   7. As a plain member, SELECT * FROM session_checkin_tokens returns
--      zero rows (RLS on, no policies).
-- ============================================================

CREATE TABLE session_checkin_tokens (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ
);

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE session_checkin_tokens ENABLE ROW LEVEL SECURITY;

-- Deliberately ZERO policies. RLS enabled with no policies denies every
-- authenticated and anon access path, which is exactly what we want: a
-- member must not be able to SELECT the token for a session they are not
-- at. Both sides go through a service-role client (bypasses RLS) — the
-- admin app to generate/rotate, the player app to resolve a scanned
-- token to a session_id.
