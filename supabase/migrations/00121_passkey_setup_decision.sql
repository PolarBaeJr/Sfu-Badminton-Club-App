-- ============================================================
-- 00121_passkey_setup_decision.sql — record what each member decided about a
-- passkey during onboarding
-- ============================================================
-- Onboarding now ASKS for a passkey rather than offering one at the bottom of
-- the last step, and it will not let the member past "Enter the club" until
-- they have either enrolled one or explicitly said no. This column is the
-- record of that answer.
--
-- WHY RECORD IT AT ALL. Without it "we made passkeys the default" is an
-- unfalsifiable claim: the passkey_credentials table can say how many members
-- enrolled, but it cannot distinguish the member who refused from the member
-- whose browser could not offer it in the first place, and those two numbers
-- argue for completely different follow-ups. One says write better copy; the
-- other says the requirement is unreachable for part of the club and must stay
-- declinable.
--
-- WHY FOUR VALUES AND NOT A declined_at TIMESTAMP.
--
--   enrolled    — a credential was created during onboarding.
--   declined    — offered, capable, and the member deliberately chose email
--                 codes instead. The only value that represents a refusal.
--   unsupported — the member's BROWSER cannot do WebAuthn. Nothing was asked of
--                 them and nothing was refused; they are not counted against
--                 the copy.
--   unavailable — the DEPLOYMENT cannot enrol (PASSKEY_COOKIE_SECRET unset, so
--                 the register routes answer 503). Our fault, not theirs, and
--                 worth being able to see separately: a spike in this value is
--                 a missing environment variable, not a UX problem.
--
-- NULL means "never asked" — every member who onboarded before this shipped,
-- and any row created outside the onboarding flow (admins pre-add roster rows
-- with user_id IS NULL). It is deliberately not backfilled to 'declined':
-- nobody declined anything, and inventing the answer would poison the only
-- number this column exists to produce.
--
-- NO GRANT, DELIBERATELY. Nothing client-side reads this: onboarding knows what
-- it just did from its own state, and the value is written by the service-role
-- client inside completeOnboarding. That is not an oversight, it is the lesson
-- of 00092/00115 — a column granted to `authenticated` is granted on every row,
-- and a column NOT granted makes PostgREST refuse the whole request with a 403
-- that supabase-js resolves rather than rejects, which the app renders as an
-- empty list. A column no client selects can do neither. If a future admin
-- report needs it, add `GRANT SELECT (passkey_setup) ON public.players TO
-- authenticated` then, with its own reasoning — or read it service-side, which
-- is what the console already does for everything else on this table.

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS passkey_setup text;

-- Named, so a bad write reports which constraint it broke rather than a
-- positional one. Added separately from the column so re-running the migration
-- on a database that already has the column is still a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.players'::regclass
      AND conname = 'players_passkey_setup_check'
  ) THEN
    ALTER TABLE public.players
      ADD CONSTRAINT players_passkey_setup_check
      CHECK (passkey_setup IN ('enrolled', 'declined', 'unsupported', 'unavailable'));
  END IF;
END $$;

COMMENT ON COLUMN public.players.passkey_setup IS
  'What this member answered when onboarding asked for a passkey: enrolled, '
  'declined, unsupported (their browser cannot), or unavailable (this '
  'deployment cannot). NULL = never asked, i.e. onboarded before 00121.';
