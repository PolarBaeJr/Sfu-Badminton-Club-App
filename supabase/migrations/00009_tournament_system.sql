-- =============================================
-- TOURNAMENT SYSTEM MIGRATION
-- Adds event-based tournament management with
-- multi-event support, check-in, brackets, and round robin
-- =============================================

-- Preserve existing tournament_participants data
ALTER TABLE tournament_participants RENAME TO legacy_tournament_participants;

-- =============================================
-- TOURNAMENT EVENTS
-- Each tournament can have multiple events
-- (e.g., Men's Singles + Women's Doubles in same tournament)
-- =============================================

CREATE TABLE tournament_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'mens_singles', 'womens_singles', 'open_singles',
    'mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles'
  )),
  format TEXT NOT NULL CHECK (format IN ('single_elimination', 'round_robin')),
  match_format TEXT NOT NULL DEFAULT 'best_of_3_to_21'
    CHECK (match_format IN ('best_of_3_to_21', 'one_game_21', 'one_game_15', 'one_game_11')),
  max_participants INT,
  seeding_method TEXT NOT NULL DEFAULT 'elo'
    CHECK (seeding_method IN ('elo', 'manual', 'random')),
  elo_multiplier DECIMAL(4,2) DEFAULT 1.25,
  placement_bonus_enabled BOOLEAN DEFAULT true,
  draw_locked BOOLEAN DEFAULT false,
  status TEXT NOT NULL DEFAULT 'registration'
    CHECK (status IN ('registration', 'checkin', 'bracket_generated', 'live', 'completed')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- TOURNAMENT PARTICIPANTS (Singles)
-- =============================================

CREATE TABLE tournament_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES tournament_events(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seed_number INT,
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'checked_in', 'withdrawn', 'disqualified', 'no_show')),
  checked_in_at TIMESTAMPTZ,
  checked_in_by UUID REFERENCES players(id),
  final_position INT,
  elo_before INT,
  elo_after INT,
  elo_change INT,
  points INT DEFAULT 0,
  added_by UUID REFERENCES players(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(event_id, player_id)
);

-- =============================================
-- TOURNAMENT PAIRS (Doubles)
-- =============================================

CREATE TABLE tournament_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES tournament_events(id) ON DELETE CASCADE,
  player1_id UUID NOT NULL REFERENCES players(id),
  player2_id UUID NOT NULL REFERENCES players(id),
  pair_name TEXT,
  seed_number INT,
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'checked_in', 'withdrawn', 'disqualified', 'no_show')),
  checked_in_at TIMESTAMPTZ,
  checked_in_by UUID REFERENCES players(id),
  final_position INT,
  combined_elo INT,
  points INT DEFAULT 0,
  added_by UUID REFERENCES players(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(event_id, player1_id, player2_id)
);

-- =============================================
-- TOURNAMENT MATCHES
-- Covers both singles and doubles matches
-- =============================================

CREATE TABLE tournament_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES tournament_events(id) ON DELETE CASCADE,
  round_number INT NOT NULL,
  round_name TEXT,
  bracket_position INT NOT NULL,
  match_number INT,

  -- Singles participants
  participant_a_id UUID REFERENCES tournament_participants(id),
  participant_b_id UUID REFERENCES tournament_participants(id),

  -- Doubles participants
  pair_a_id UUID REFERENCES tournament_pairs(id),
  pair_b_id UUID REFERENCES tournament_pairs(id),

  -- Result
  winner_participant_id UUID REFERENCES tournament_participants(id),
  winner_pair_id UUID REFERENCES tournament_pairs(id),
  loser_participant_id UUID REFERENCES tournament_participants(id),
  loser_pair_id UUID REFERENCES tournament_pairs(id),

  -- Scores stored as JSON array of games
  -- e.g., [{"a": 21, "b": 18}, {"a": 15, "b": 21}, {"a": 21, "b": 19}]
  scores JSONB,

  -- Progression — where winner goes next
  winner_to_match_id UUID REFERENCES tournament_matches(id),
  winner_to_position TEXT CHECK (winner_to_position IN ('a', 'b')),

  -- Scheduling
  court TEXT,
  scheduled_time TIMESTAMPTZ,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'live', 'completed', 'walkover', 'disputed', 'voided')),

  -- Special outcomes
  walkover_winner TEXT CHECK (walkover_winner IN ('a', 'b')),
  walkover_reason TEXT,

  -- Audit
  result_entered_by UUID REFERENCES players(id),
  result_entered_at TIMESTAMPTZ,
  is_bye BOOLEAN DEFAULT false,

  -- Notes
  notes TEXT,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- TOURNAMENT AUDIT LOG
-- =============================================

CREATE TABLE tournament_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID REFERENCES tournaments(id),
  event_id UUID REFERENCES tournament_events(id),
  match_id UUID REFERENCES tournament_matches(id),
  action TEXT NOT NULL,
  performed_by UUID REFERENCES players(id),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- INDEXES
-- =============================================

CREATE INDEX idx_tournament_events_tournament ON tournament_events(tournament_id);
CREATE INDEX idx_tournament_participants_event ON tournament_participants(event_id);
CREATE INDEX idx_tournament_participants_player ON tournament_participants(player_id);
CREATE INDEX idx_tournament_pairs_event ON tournament_pairs(event_id);
CREATE INDEX idx_tournament_matches_event ON tournament_matches(event_id);
CREATE INDEX idx_tournament_matches_round ON tournament_matches(event_id, round_number);
CREATE INDEX idx_tournament_audit_event ON tournament_audit_log(event_id);

-- =============================================
-- RLS (Row Level Security)
-- =============================================

ALTER TABLE tournament_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_audit_log ENABLE ROW LEVEL SECURITY;

-- Players can read everything
CREATE POLICY "Public read tournament_events" ON tournament_events FOR SELECT USING (true);
CREATE POLICY "Public read tournament_participants" ON tournament_participants FOR SELECT USING (true);
CREATE POLICY "Public read tournament_pairs" ON tournament_pairs FOR SELECT USING (true);
CREATE POLICY "Public read tournament_matches" ON tournament_matches FOR SELECT USING (true);
CREATE POLICY "Public read tournament_audit_log" ON tournament_audit_log FOR SELECT USING (true);

-- Only service role (admin app) can write
CREATE POLICY "Service write tournament_events" ON tournament_events FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write tournament_participants" ON tournament_participants FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write tournament_pairs" ON tournament_pairs FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write tournament_matches" ON tournament_matches FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write tournament_audit" ON tournament_audit_log FOR ALL USING (auth.role() = 'service_role');
