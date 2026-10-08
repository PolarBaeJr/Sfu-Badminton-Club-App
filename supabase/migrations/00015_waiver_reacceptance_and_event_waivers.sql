-- ============================================================
-- 00015_waiver_reacceptance_and_event_waivers.sql — forced
-- re-signature (global + per-player) and per-tournament event
-- waivers
--
-- Two additive features on top of the legal-documents system
-- (00010, 00014):
--
--   1. Forced re-signature. Admins can require every member to
--      re-accept a specific legal document on their next visit
--      (legal_documents.reacceptance_required_since), and can
--      force a single player to re-sign the waiver
--      (players.waiver_reset_at). The shared
--      getMissingLegalDocuments helper treats an acceptance as
--      stale when its latest accepted_at predates the relevant
--      threshold — so the existing waiver gate re-triggers with
--      no new plumbing.
--
--   2. Event waivers. A tournament may carry its own waiver text
--      (tournaments.waiver_text) that participants must accept
--      before registering. Acceptances are recorded in
--      event_waiver_acceptances as immutable evidence, keyed by a
--      SHA-256 hash of the accepted text so an edit re-requires
--      acceptance.
-- ============================================================

-- ============================================================
-- FORCED RE-SIGNATURE
-- ============================================================

-- Global (per-document): set to now() to require every member to
-- re-accept this document; acceptances older than this are stale.
ALTER TABLE legal_documents ADD COLUMN reacceptance_required_since TIMESTAMPTZ;

-- Per-player: set to now() to force just this member to re-sign the
-- waiver on their next visit.
ALTER TABLE players ADD COLUMN waiver_reset_at TIMESTAMPTZ;

-- ============================================================
-- EVENT WAIVERS
-- ============================================================

-- Optional per-tournament waiver shown at registration. NULL = none.
ALTER TABLE tournaments ADD COLUMN waiver_text TEXT;

CREATE TABLE event_waiver_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  waiver_hash TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  UNIQUE(player_id, tournament_id, waiver_hash)
);

CREATE INDEX idx_ewa_player_tournament ON event_waiver_acceptances(player_id, tournament_id);

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE event_waiver_acceptances ENABLE ROW LEVEL SECURITY;

-- Players can read their own acceptances; admins can read all.
CREATE POLICY ewa_select ON event_waiver_acceptances FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()) OR is_admin(auth.uid()));

-- Players can insert their own acceptance rows.
CREATE POLICY ewa_insert ON event_waiver_acceptances FOR INSERT TO authenticated
  WITH CHECK (player_id = get_player_id(auth.uid()));

-- Deliberately NO UPDATE/DELETE policies for anyone: acceptance rows are
-- immutable evidence of what was accepted, when, and under which text hash.
