-- ============================================================
-- 00037_email_suppression.sql — stop mailing addresses that bounced,
-- complained, or unsubscribed
-- ============================================================
-- Amazon SES judges the account on bounce and complaint rate, and a bad rate
-- gets sending suspended outright — not throttled. SES keeps its own
-- account-level suppression list, but that is invisible to the app: we would
-- keep queueing mail to a dead address and only find out from the console. So
-- we mirror the decision locally and check it before every send.
--
-- Keyed on the ADDRESS, not on players.id, on purpose:
--   * a bounce notification identifies a recipient by address only;
--   * an address can be suppressed before or after any player row exists
--     (an admin pre-adds a member, the address is dead, they never sign in);
--   * a member changing their email should get a clean slate, and keying on
--     the address gives that for free.
--
-- No RLS policies are added. RLS is ENABLED with zero policies, which denies
-- every role that goes through PostgREST — only the service-role key (used by
-- the SES webhook and the mailer) can read or write this. Members must never
-- be able to enumerate addresses, and must never be able to suppress someone
-- else's.
-- ============================================================

CREATE TABLE IF NOT EXISTS email_suppressions (
  -- Lowercased by the app before insert. Addresses are case-insensitive in the
  -- domain part and effectively so in practice for the local part; storing one
  -- canonical form means the pre-send check is a plain PK lookup.
  email       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'manual')),
  -- Raw SES bounce/complaint payload, or the unsubscribe context. Kept because
  -- diagnosing "why did this member stop getting mail" after the fact is
  -- otherwise guesswork.
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE email_suppressions IS
  'Addresses the app must not send to. Written by the SES bounce/complaint webhook and by one-click unsubscribe; checked before every outbound notification email. Auth/sign-in mail goes through GoTrue and does NOT consult this table.';

COMMENT ON COLUMN email_suppressions.reason IS
  'bounce = hard bounce (SES bounceType Permanent); complaint = recipient marked it spam; unsubscribe = one-click opt-out of all mail; manual = added by an admin.';

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;

-- Belt and braces alongside the empty-policy RLS above: PostgREST exposes any
-- table the anon/authenticated roles hold grants on, so drop the grants too.
REVOKE ALL ON email_suppressions FROM anon, authenticated;
