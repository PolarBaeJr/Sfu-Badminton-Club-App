-- ============================================================
-- 00008_richer_attendance.sql — Richer session attendance
--
-- Adds an attendance status to session_attendance ('checked_in'
-- = self check-in; 'present' = admin-confirmed attended;
-- 'no_show' / 'excused' are admin-only marks), optional session
-- start/end times, and a check-in window enforced at the RLS
-- layer via session_checkin_open(). Session no-shows do NOT feed
-- reliability_metrics.
-- ============================================================

CREATE TYPE attendance_status AS ENUM ('checked_in', 'present', 'no_show', 'excused');

ALTER TABLE session_attendance
  ADD COLUMN status attendance_status NOT NULL DEFAULT 'checked_in',
  ADD COLUMN marked_by UUID REFERENCES players(id) ON DELETE SET NULL,
  ADD COLUMN marked_at TIMESTAMPTZ;

ALTER TABLE sessions
  ADD COLUMN start_time TIME,
  ADD COLUMN end_time TIME;

-- checkin_opens_minutes_before: null = check-in opens as soon as the session
-- exists (advance check-in preserved; only a closing edge is enforced).
INSERT INTO platform_settings (key, value) VALUES
  ('session_attendance', '{
    "checkin_opens_minutes_before": null,
    "default_duration_minutes": 120
  }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Whether self check-in is currently allowed for a session. All wall-clock
-- times on sessions are club-local (America/Vancouver). Close bound:
-- date + end_time if set, else start_time + default_duration_minutes if
-- start_time is set, else the end of the session's date (start of the next
-- day, club time). Open bound: only enforced when
-- checkin_opens_minutes_before is non-null.
-- Mirrored in TypeScript by isCheckinOpen (packages/shared session-window.ts).
CREATE OR REPLACE FUNCTION session_checkin_open(p_session_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_session RECORD;
  v_settings JSONB;
  v_opens_minutes INTEGER;
  v_duration_minutes INTEGER;
  v_start_ts TIMESTAMPTZ;
  v_close_ts TIMESTAMPTZ;
BEGIN
  SELECT date, start_time, end_time, status INTO v_session
  FROM sessions WHERE id = p_session_id;

  IF NOT FOUND OR v_session.status <> 'open' THEN
    RETURN FALSE;
  END IF;

  SELECT value INTO v_settings FROM platform_settings WHERE key = 'session_attendance';
  v_opens_minutes := (v_settings->>'checkin_opens_minutes_before')::int;
  v_duration_minutes := COALESCE((v_settings->>'default_duration_minutes')::int, 120);

  v_start_ts := (v_session.date + COALESCE(v_session.start_time, '00:00'::time))::timestamp
    AT TIME ZONE 'America/Vancouver';

  IF v_session.end_time IS NOT NULL THEN
    v_close_ts := (v_session.date + v_session.end_time)::timestamp
      AT TIME ZONE 'America/Vancouver';
  ELSIF v_session.start_time IS NOT NULL THEN
    v_close_ts := v_start_ts + make_interval(mins => v_duration_minutes);
  ELSE
    v_close_ts := (v_session.date + 1)::timestamp AT TIME ZONE 'America/Vancouver';
  END IF;

  IF v_opens_minutes IS NOT NULL
     AND NOW() < v_start_ts - make_interval(mins => v_opens_minutes) THEN
    RETURN FALSE;
  END IF;

  RETURN NOW() < v_close_ts;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION session_checkin_open(UUID) TO authenticated;

-- Players may only self-insert a plain 'checked_in' row while the check-in
-- window is open; admin marks go through attendance_admin (unchanged).
DROP POLICY attendance_insert ON session_attendance;

CREATE POLICY attendance_insert ON session_attendance FOR INSERT TO authenticated
  WITH CHECK (
    player_id = get_player_id(auth.uid())
    AND status = 'checked_in'
    AND session_checkin_open(session_id)
  );
