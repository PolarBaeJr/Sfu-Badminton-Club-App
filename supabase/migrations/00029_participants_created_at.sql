-- 00029_participants_created_at.sql
-- Neither match_participants nor challenge_participants had a created_at column. The Recent-Matches /
-- Next-Challenge widgets sorted by the parent's timestamp via PostgREST's referencedTable, which
-- actually sorts the embedded join (a no-op for one-row joins) and leaves the parent rows in
-- insertion order — combined with .limit() this silently returned the wrong window. Mirroring
-- created_at onto the parent rows lets us drop referencedTable and sort the parents directly.

-- ---- match_participants ----
ALTER TABLE public.match_participants
  ADD COLUMN created_at TIMESTAMPTZ;

-- matches.played_at is NULLABLE (a scheduled-but-unplayed match has none) while matches.created_at
-- is NOT NULL — COALESCE so the SET NOT NULL below can't hard-fail on a NULL backfill in any env.
UPDATE public.match_participants mp
  SET created_at = COALESCE(m.played_at, m.created_at, NOW())
  FROM public.matches m
  WHERE m.id = mp.match_id;

ALTER TABLE public.match_participants
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_match_participants_player_created
  ON public.match_participants (player_id, created_at DESC);

-- ---- challenge_participants ----
ALTER TABLE public.challenge_participants
  ADD COLUMN created_at TIMESTAMPTZ;

-- challenges.created_at is NOT NULL, so this backfill never yields NULL.
UPDATE public.challenge_participants cp
  SET created_at = c.created_at
  FROM public.challenges c
  WHERE c.id = cp.challenge_id;

ALTER TABLE public.challenge_participants
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_challenge_participants_player_created
  ON public.challenge_participants (player_id, created_at DESC);
