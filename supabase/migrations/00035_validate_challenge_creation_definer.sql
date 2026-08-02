-- ============================================================
-- 00035_validate_challenge_creation_definer.sql
-- Restore challenge creation for non-admin members
-- ============================================================
-- Creating a challenge failed for every ordinary player with
-- "permission denied for table players".
--
-- validate_challenge_creation runs SECURITY INVOKER, so it executes as
-- `authenticated`. It reads
--
--     SELECT status, is_banned, active_flag FROM players ...
--
-- and 00032 (PII lockdown) replaced the blanket SELECT on players with a
-- column grant. `status` and `active_flag` are in that grant; `is_banned` is
-- not — deliberately, it is moderation state. One ungranted column is enough
-- for Postgres to refuse the whole statement, so the RPC threw before any
-- validation ran and createChallenge failed closed. Admins were unaffected
-- (service-role), which is why it only showed up as a normal user.
--
-- The function returns a verdict — {valid, errors} — never a player row, so it
-- is a natural SECURITY DEFINER: it needs to consult moderation state without
-- handing that state to the caller. Audited first that it is the *only*
-- SECURITY INVOKER function reading a column 00032 revoked.
--
-- ALTER rather than CREATE OR REPLACE on purpose: the body is long and subtle
-- (the status::TEXT cast tolerating the non-existent 'inactive' label, the
-- partner count-vs-expected comparison), and retyping it to change two
-- modifiers risks a silent transcription error in a security check.
--
-- search_path is pinned because a SECURITY DEFINER function without one
-- resolves unqualified names against the caller's path, which lets a caller
-- shadow `players` with their own table and steer the result.
--
-- Note on exposure: as a definer this answers "can X be challenged?" for any
-- id, which indirectly reflects is_banned. That is already inferable — `status`
-- is granted to authenticated and carries 'suspended' — so this widens nothing
-- meaningfully, and the verdict never names which condition failed for another
-- player beyond the existing generic message.

ALTER FUNCTION validate_challenge_creation(uuid, uuid, text, uuid, uuid)
  SECURITY DEFINER;

ALTER FUNCTION validate_challenge_creation(uuid, uuid, text, uuid, uuid)
  SET search_path = public, pg_temp;
