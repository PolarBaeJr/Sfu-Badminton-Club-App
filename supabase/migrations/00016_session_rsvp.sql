-- ============================================================
-- 00016_session_rsvp.sql — Session RSVP (intent to attend)
--
-- Adds a lightweight, ahead-of-time "going / can't make it"
-- signal for open sessions, distinct from same-day check-in.
-- Kept in its own table rather than session_attendance: that
-- table's one-row-per-(session,player) already models check-in,
-- so an RSVP would collide with / be indistinguishable from it.
-- One row per (session, player); players manage only their own
-- RSVP and only while the session is 'open'. Read access is
-- open to all authenticated users so counts render on cards.
-- ============================================================

CREATE TYPE session_intent AS ENUM ('going','declined');

CREATE TABLE session_rsvp (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES players(id)  ON DELETE CASCADE,
  intent     session_intent NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, player_id)
);

CREATE INDEX idx_session_rsvp_session ON session_rsvp(session_id);
CREATE INDEX idx_session_rsvp_player  ON session_rsvp(player_id);

ALTER TABLE session_rsvp ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_rsvp_select ON session_rsvp FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY session_rsvp_insert ON session_rsvp FOR INSERT TO authenticated
  WITH CHECK (
    player_id = get_player_id(auth.uid())
    AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_id AND s.status = 'open')
  );

CREATE POLICY session_rsvp_update ON session_rsvp FOR UPDATE TO authenticated
  USING (player_id = get_player_id(auth.uid()))
  WITH CHECK (player_id = get_player_id(auth.uid()));

CREATE POLICY session_rsvp_delete ON session_rsvp FOR DELETE TO authenticated
  USING (player_id = get_player_id(auth.uid()));
