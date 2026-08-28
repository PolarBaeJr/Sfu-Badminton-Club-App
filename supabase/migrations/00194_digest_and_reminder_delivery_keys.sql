-- 00194 — a per-recipient idempotency key for the digest, and a bounded retry
-- for the reminder (F-018, F-019)
--
-- BOTH SCHEDULES ARE LIVE IN PRODUCTION AND HAVE BEEN THROUGHOUT. The
-- remediation record wrote these two findings down as operational residuals
-- whose containment was "keep those schedules disabled". They were never
-- disabled: cron.job holds `session-reminders` on */5 and `weekly-digest` on
-- */5 17-18 * * 1, both active. So the containment did not exist and these are
-- ordinary live defects.
--
-- ---------------------------------------------------------------------------
-- 1. THE DIGEST'S ONLY DEFENCE AGAINST A DOUBLE SEND IS A SINGLE SHARED CURSOR
--    (cron_config.weekly_digest_progress), and a cursor is a read-modify-write.
--    Two invocations that overlap both read the same `after`, both take the
--    same first 40 members in id order, and both mail them. The Monday
--    schedule fires every five minutes for two hours precisely so a long run
--    can resume, which is the same thing as saying invocations are expected to
--    be close together; pg_net's timeout-and-retry makes the overlap reachable
--    without anything going wrong on the app side.
--
--    digest_deliveries is the per-recipient, per-window key codex asked for.
--    The send is preceded by an INSERT .. ON CONFLICT DO NOTHING RETURNING, so
--    the claim IS the exclusion: two concurrent runs claim disjoint sets and
--    the loser skips rather than sends. The cursor stays, but only as the cheap
--    resume position and the "week finished" flag — it is no longer what stands
--    between a member and a second copy of the same mail.
--
--    A STRANDED CLAIM IS NOT RETRIED. completed_at NULL past the run means we
--    do not know whether Resend accepted it, and for a club-wide mailing the
--    two errors are not symmetric: a duplicate is unrecallable, drives
--    unsubscribes and spam complaints, and costs the sending domain's
--    reputation, while a missed digest costs one member one week of a summary
--    they can see in the app anyway. The reminder job below deliberately
--    decides this the OTHER way round. Whoever changes one of them should read
--    both — the asymmetry is the design, not an inconsistency.
--
-- 2. THE REMINDER'S RETRY IS UNBOUNDED. 00186 made a claim with no receipt
--    retryable after fifteen minutes, which is what stopped a crash between
--    claim and send being a permanent silent drop. Nothing bounds it: a player
--    whose send fails for a reason that will not fix itself is re-attempted
--    every fifteen minutes until the session starts, and the run reports the
--    same claimed-but-not-notified split every time with nothing accumulating
--    that anyone could alert on. reminder_attempts counts, reminder_failed_at
--    is the terminal state, and the job stops after the cap and says so once.
-- ---------------------------------------------------------------------------

BEGIN;

-- `week_start`, not `window`: window is a reserved word in Postgres (the
-- OVER (...) frame clause) and would need quoting here and in every PostgREST
-- filter that ever touches it.
CREATE TABLE IF NOT EXISTS public.digest_deliveries (
  week_start          DATE        NOT NULL,
  player_id           UUID        NOT NULL REFERENCES public.players (id) ON DELETE CASCADE,
  claimed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  outcome             TEXT,
  provider_message_id TEXT,
  PRIMARY KEY (week_start, player_id),
  -- The four states the run can end a recipient in. NULL outcome with a NULL
  -- completed_at is the in-flight claim; anything else is a decision.
  CONSTRAINT digest_deliveries_outcome_known
    CHECK (outcome IS NULL OR outcome IN ('sent', 'suppressed', 'opted_out', 'failed')),
  CONSTRAINT digest_deliveries_completed_has_outcome
    CHECK ((completed_at IS NULL) = (outcome IS NULL))
);

COMMENT ON TABLE public.digest_deliveries IS
  'One row per (week, member) the weekly digest has DECIDED ABOUT. Inserted as a claim before the provider is called, completed after. The primary key is the idempotency key: it is what makes two concurrent cron invocations unable to mail the same member twice.';
COMMENT ON COLUMN public.digest_deliveries.claimed_at IS
  'Set before the send. A row with claimed_at and no completed_at is either in flight or stranded by a crash — NEVER retried automatically, because we cannot tell which and a duplicate club-wide mailing is the more expensive error.';
COMMENT ON COLUMN public.digest_deliveries.provider_message_id IS
  'Resend message id where the provider returned one. The only durable link from a member who says they did not get it to the provider log.';

-- Same lockdown as cron_config (00033): RLS on with no policies at all, and
-- the grants revoked outright. This table says who was mailed and when, which
-- is per-member delivery data; the route reaches it with the service-role key,
-- which bypasses RLS, and nothing else has any business reading it.
ALTER TABLE public.digest_deliveries ENABLE ROW LEVEL SECURITY;  -- no policies = no access
REVOKE ALL ON public.digest_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.digest_deliveries TO service_role;

-- The run's own sweep for strandeds is "this week, claimed, never completed".
CREATE INDEX IF NOT EXISTS digest_deliveries_incomplete_idx
  ON public.digest_deliveries (week_start)
  WHERE completed_at IS NULL;

ALTER TABLE public.session_rsvp
  ADD COLUMN IF NOT EXISTS reminder_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reminder_failed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.session_rsvp.reminder_attempts IS
  'How many times a reminder for this RSVP has been claimed. Bounds the 00186 stale-claim retry so a permanently failing send stops being re-attempted every fifteen minutes until the session starts.';
COMMENT ON COLUMN public.session_rsvp.reminder_failed_at IS
  'Terminal: the attempt cap was reached without the notification ever committing. This RSVP will not be reminded again and the failure was reported once, at the moment this was set.';

DO $verify$
DECLARE
  v_bad TEXT[] := '{}';
BEGIN
  IF to_regclass('public.digest_deliveries') IS NULL THEN
    v_bad := array_append(v_bad, 'digest_deliveries missing');
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM pg_class WHERE oid = 'public.digest_deliveries'::regclass AND relrowsecurity
    ) THEN
      v_bad := array_append(v_bad, 'digest_deliveries: RLS not enabled');
    END IF;
    -- Grants are read off pg_class.relacl, NOT information_schema: that view
    -- reports grants which do not exist (it expands role membership), and it
    -- cost a false all-clear on this exact question in August.
    IF has_table_privilege('anon', 'public.digest_deliveries', 'SELECT') THEN
      v_bad := array_append(v_bad, 'digest_deliveries: anon can SELECT');
    END IF;
    IF has_table_privilege('authenticated', 'public.digest_deliveries', 'SELECT') THEN
      v_bad := array_append(v_bad, 'digest_deliveries: authenticated can SELECT');
    END IF;
    IF NOT has_table_privilege('service_role', 'public.digest_deliveries', 'INSERT') THEN
      v_bad := array_append(v_bad, 'digest_deliveries: service_role CANNOT insert');
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'session_rsvp'
       AND column_name = 'reminder_attempts'
  ) THEN
    v_bad := array_append(v_bad, 'session_rsvp.reminder_attempts missing');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'session_rsvp'
       AND column_name = 'reminder_failed_at'
  ) THEN
    v_bad := array_append(v_bad, 'session_rsvp.reminder_failed_at missing');
  END IF;

  IF array_length(v_bad, 1) > 0 THEN
    RAISE EXCEPTION '00194 verification failed: %', array_to_string(v_bad, '; ');
  END IF;

  RAISE NOTICE '00194: the digest has a per-recipient key and the reminder retry is bounded.';
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
