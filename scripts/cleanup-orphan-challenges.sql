-- One-off cleanup: remove orphaned challenges left by the pre-fix
-- challenge_participants RLS failure (challenge row committed, participant
-- insert rejected -> zero-participant challenge). Safe: only deletes
-- challenges that have NO participants AND no associated match.
--
-- Run:
--   ssh pi "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < scripts/cleanup-orphan-challenges.sql
--
-- Preview first (uncomment) to see what would be deleted:
-- SELECT c.id, c.status, c.created_at
--   FROM challenges c
--   LEFT JOIN challenge_participants cp ON cp.challenge_id = c.id
--   LEFT JOIN matches m ON m.challenge_id = c.id
--   GROUP BY c.id
--   HAVING COUNT(cp.id) = 0 AND COUNT(m.id) = 0;

DELETE FROM challenges c
WHERE NOT EXISTS (SELECT 1 FROM challenge_participants cp WHERE cp.challenge_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.challenge_id = c.id);
