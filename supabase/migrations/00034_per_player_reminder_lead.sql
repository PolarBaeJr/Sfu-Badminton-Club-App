-- ============================================================
-- 00034_per_player_reminder_lead.sql — remind each player when THEY asked
-- ============================================================
-- 00033 reminded everyone as soon as an hourly run saw a session dated today.
-- That is wrong twice over: the first run after midnight would fire at 00:07,
-- waking the club in the middle of the night, and it ignored when the session
-- actually starts.
--
-- Reminders now go out a configurable interval before start_time, chosen per
-- player (players.notification_preferences.session_reminder_lead_minutes,
-- default 120). Two people RSVP'd to the same session can want different
-- notice, so "already reminded" has to be tracked per player per session —
-- sessions.reminder_sent_at cannot express that.
--
-- Cadence goes from hourly to every 15 minutes so a "1 hour before" preference
-- lands within a quarter of an hour of the mark rather than up to an hour late.
-- Cost is four no-op round-trips an hour.
-- ============================================================

-- Per-player, per-session stamp. sessions.reminder_sent_at stays for the manual
-- "Send reminder" button, which is still a whole-session action.
ALTER TABLE session_rsvp ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

COMMENT ON COLUMN session_rsvp.reminded_at IS
  'Set when this player was reminded about this session. Claimed with a conditional UPDATE so two runs cannot both notify.';

-- Finding the handful of rows still due, out of every RSVP ever made.
CREATE INDEX IF NOT EXISTS session_rsvp_pending_reminder_idx
  ON session_rsvp (session_id)
  WHERE reminded_at IS NULL AND intent = 'going';

SELECT cron.unschedule('session-reminders')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'session-reminders');

SELECT cron.schedule(
  'session-reminders',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := (SELECT value FROM cron_config WHERE key = 'admin_url') || '/api/cron/session-reminders',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || (SELECT value FROM cron_config WHERE key = 'reminder_secret')
               ),
    body    := '{}'::jsonb
  )
  WHERE EXISTS (SELECT 1 FROM cron_config WHERE key = 'reminder_secret');
  $$
);
