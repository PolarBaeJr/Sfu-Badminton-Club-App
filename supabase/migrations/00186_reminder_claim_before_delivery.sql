-- Separate "we tried" from "they were reminded" (F-018).
--
-- The session-reminder job claims session_rsvp.reminded_at and then sends. The
-- bot's own session-ping module documents why that is the wrong way round
-- (apps/bot/src/session-pings.ts, "ORDER OF OPERATIONS IS THE WHOLE DESIGN"):
-- anything that throws between the claim and the send is a silent, permanent
-- drop. The row says reminded, nobody was, and there is no trace to find it by.
-- A duplicate is noticed and mentioned; a miss is invisible.
--
-- The job cannot simply invert the order, because the claim is also what stops
-- two concurrent ticks reminding the same player twice. It needs both, so it
-- needs two columns:
--
--   reminder_attempted_at  the CLAIM. Taken before the send. Mutual exclusion.
--   reminded_at            the RECEIPT. Written after delivery is durable,
--                          which here means the in-app notification row is
--                          committed. Web push stays best-effort and does not
--                          gate this — the bell is what makes the reminder
--                          recoverable, and it is the channel that always works.
--
-- A claim that is old and never grew a receipt is a crashed attempt, and the
-- job retries it. Fifteen minutes on a five-minute schedule means at most one
-- in-flight tick can be mistaken for a crash, and a real crash is picked up on
-- the third tick rather than never.
--
-- Nothing that reads reminded_at today changes meaning: it still means "this
-- player was reminded about this session". It just stops being written when
-- they were not.

BEGIN;

ALTER TABLE public.session_rsvp
  ADD COLUMN IF NOT EXISTS reminder_attempted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.session_rsvp.reminder_attempted_at IS
  'Claimed by the reminder job BEFORE it sends, so two ticks cannot both notify. A claim older than the retry window with reminded_at still NULL is a crashed attempt and is retried. See reminded_at for the receipt.';

COMMENT ON COLUMN public.session_rsvp.reminded_at IS
  'Set AFTER the reminder was durably delivered (the in-app notification row committed). Never a claim — see reminder_attempted_at.';

-- The pending-work index has to cover the retry case too, or a crashed claim is
-- found only by a sequential scan of every RSVP ever made. Both columns are in
-- the predicate the job now uses.
DROP INDEX IF EXISTS session_rsvp_pending_reminder_idx;
CREATE INDEX IF NOT EXISTS session_rsvp_pending_reminder_idx
  ON public.session_rsvp (session_id, reminder_attempted_at)
  WHERE reminded_at IS NULL AND intent = 'going';

-- Existing rows: a reminded_at that is already set was a claim under the old
-- scheme AND, in the overwhelming majority, a real delivery. Backfilling the
-- attempt stamp from it keeps the two columns consistent and stops the retry
-- predicate treating every historical row as an unclaimed attempt.
UPDATE public.session_rsvp
   SET reminder_attempted_at = reminded_at
 WHERE reminded_at IS NOT NULL
   AND reminder_attempted_at IS NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
