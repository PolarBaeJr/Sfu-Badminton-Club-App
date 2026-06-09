-- 00028_matches_challenge_id_unique.sql
-- Prevents two matches against the same challenge (QR-vs-manual race; the manual submit path has no
-- duplicate pre-check, so this constraint + the 23505 catches in both submit paths are the only
-- race-safe guard). Multiple NULL challenge_id rows remain allowed (tournament/session matches have
-- no challenge) — Postgres treats NULLs as distinct in UNIQUE indexes. Not DEFERRABLE: no code
-- reorders match rows mid-transaction, so IMMEDIATE surfaces violations at the failing statement.

ALTER TABLE matches
  ADD CONSTRAINT matches_challenge_id_unique
  UNIQUE (challenge_id);
