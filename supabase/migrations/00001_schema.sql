-- ============================================================
-- 00001_schema.sql — Extensions, enums, and all tables
--
-- Consolidated baseline (squash of the former 00001-00022 chain).
-- Enums carry their FINAL values (post-00011 simplification and
-- 00010 tournament notification additions); tables include all
-- later column additions (tournament_matches.elo_snapshot, etc.).
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUM TYPES
-- ============================================================

CREATE TYPE player_status AS ENUM (
  'competitive',
  'recreational',
  'pending_approval',
  'suspended'
);

CREATE TYPE user_role AS ENUM (
  'player',
  'admin'
);

CREATE TYPE match_format AS ENUM (
  'bo3_21',
  'single_21',
  'single_15',
  'single_11'
);

CREATE TYPE match_type_enum AS ENUM (
  'singles',
  'doubles'
);

CREATE TYPE event_type_enum AS ENUM (
  'rated_challenge',
  'casual',
  'tournament',
  'trial',
  'admin_entered'
);

CREATE TYPE challenge_status AS ENUM (
  'proposed',
  'partially_confirmed',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
  'completed',
  'disputed',
  'walkover_pending',
  'walkover_confirmed'
);

CREATE TYPE participant_role AS ENUM (
  'challenger',
  'opponent',
  'partner',
  'opponent_partner'
);

CREATE TYPE team_side AS ENUM ('a', 'b');

CREATE TYPE confirmation_status AS ENUM (
  'pending',
  'accepted',
  'rejected'
);

CREATE TYPE result_status AS ENUM (
  'pending_submission',
  'pending_confirmation',
  'confirmed',
  'disputed',
  'voided',
  'walkover',
  'incomplete'
);

CREATE TYPE session_status AS ENUM ('open', 'closed');

CREATE TYPE tournament_scope AS ENUM ('open', 'eligible_only');

CREATE TYPE tournament_type AS ENUM ('internal', 'open_official', 'invitational');

CREATE TYPE tournament_format AS ENUM ('singles', 'doubles', 'mixed_event');

CREATE TYPE tournament_status AS ENUM ('draft', 'active', 'completed', 'archived');

CREATE TYPE dispute_reason AS ENUM (
  'score_wrong',
  'winner_wrong',
  'format_wrong',
  'incomplete',
  'abuse',
  'rules_violation',
  'other'
);

CREATE TYPE dispute_status AS ENUM ('open', 'under_review', 'resolved');

CREATE TYPE dispute_resolution AS ENUM (
  'accepted',
  'edited',
  'voided',
  'converted_to_casual'
);

CREATE TYPE walkover_type AS ENUM ('withdrawal', 'no_show');

CREATE TYPE walkover_status AS ENUM ('pending', 'confirmed', 'rejected');

CREATE TYPE notification_type AS ENUM (
  'challenge_received',
  'challenge_accepted',
  'challenge_rejected',
  'challenge_expired',
  'challenge_cancelled',
  'result_pending',
  'result_confirmed',
  'dispute_opened',
  'dispute_resolved',
  'rank_changed',
  'session_reminder',
  'walkover_reported',
  'walkover_confirmed',
  'opponent_withdrew',
  'admin_alert',
  'general',
  'tournament_bracket_published',
  'tournament_match_ready',
  'tournament_match_result',
  'tournament_event_completed',
  'tournament_checkin_open'
);

-- ============================================================
-- TABLES
-- ============================================================

-- Players table (extends auth.users)
CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  full_name TEXT NOT NULL,
  display_name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  status player_status NOT NULL DEFAULT 'pending_approval',
  role user_role NOT NULL DEFAULT 'player',
  eligibility_flag BOOLEAN NOT NULL DEFAULT FALSE,
  active_flag BOOLEAN NOT NULL DEFAULT TRUE,
  -- Club-admin markers (no effect on gameplay, ratings, or leaderboards):
  -- is_exec = member of the club executive team; fee_exempt = contributes
  -- enough to be exempted from the club fee. Both exclude the player from
  -- the fee-collection list.
  is_exec BOOLEAN NOT NULL DEFAULT FALSE,
  fee_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  banned_at TIMESTAMPTZ,
  banned_by UUID REFERENCES players(id),
  ban_reason TEXT,
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_url TEXT,
  bio TEXT,
  profile_visibility TEXT NOT NULL DEFAULT 'public',
  hide_from_leaderboard BOOLEAN NOT NULL DEFAULT FALSE,
  show_activity_status BOOLEAN NOT NULL DEFAULT TRUE,
  notification_preferences JSONB NOT NULL DEFAULT '{}',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ratings table (one row per player)
CREATE TABLE ratings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  singles_elo INTEGER NOT NULL DEFAULT 1200,
  doubles_elo INTEGER NOT NULL DEFAULT 1200,
  singles_matches_played INTEGER NOT NULL DEFAULT 0,
  doubles_matches_played INTEGER NOT NULL DEFAULT 0,
  singles_provisional BOOLEAN NOT NULL DEFAULT TRUE,
  doubles_provisional BOOLEAN NOT NULL DEFAULT TRUE,
  singles_k_factor INTEGER NOT NULL DEFAULT 40,
  doubles_k_factor INTEGER NOT NULL DEFAULT 32,
  singles_wins INTEGER NOT NULL DEFAULT 0,
  singles_losses INTEGER NOT NULL DEFAULT 0,
  doubles_wins INTEGER NOT NULL DEFAULT 0,
  doubles_losses INTEGER NOT NULL DEFAULT 0,
  singles_points_scored INTEGER NOT NULL DEFAULT 0,
  singles_points_allowed INTEGER NOT NULL DEFAULT 0,
  doubles_points_scored INTEGER NOT NULL DEFAULT 0,
  doubles_points_allowed INTEGER NOT NULL DEFAULT 0,
  singles_games_won INTEGER NOT NULL DEFAULT 0,
  singles_games_lost INTEGER NOT NULL DEFAULT 0,
  doubles_games_won INTEGER NOT NULL DEFAULT 0,
  doubles_games_lost INTEGER NOT NULL DEFAULT 0,
  current_singles_streak INTEGER NOT NULL DEFAULT 0,
  best_singles_streak INTEGER NOT NULL DEFAULT 0,
  current_doubles_streak INTEGER NOT NULL DEFAULT 0,
  best_doubles_streak INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seasons
CREATE TABLE seasons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  active_flag BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  season_id UUID REFERENCES seasons(id) ON DELETE SET NULL,
  name TEXT,
  date DATE NOT NULL,
  location TEXT NOT NULL,
  host_player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  status session_status NOT NULL DEFAULT 'open',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session Attendance
CREATE TABLE session_attendance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, player_id)
);

-- Challenges
CREATE TABLE challenges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type match_type_enum NOT NULL,
  rated_flag BOOLEAN NOT NULL DEFAULT TRUE,
  format match_format NOT NULL DEFAULT 'single_21',
  event_type event_type_enum NOT NULL DEFAULT 'rated_challenge',
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  scheduled_date DATE,
  scheduled_time TIME,
  created_by UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status challenge_status NOT NULL DEFAULT 'proposed',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Challenge Participants
CREATE TABLE challenge_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role participant_role NOT NULL,
  team_side team_side NOT NULL,
  confirmation_status confirmation_status NOT NULL DEFAULT 'pending',
  responded_at TIMESTAMPTZ,
  UNIQUE(challenge_id, player_id)
);

-- Tournaments
CREATE TABLE tournaments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  season_id UUID REFERENCES seasons(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  scope tournament_scope NOT NULL DEFAULT 'open',
  type tournament_type NOT NULL DEFAULT 'internal',
  format tournament_format NOT NULL DEFAULT 'singles',
  start_date DATE NOT NULL,
  end_date DATE,
  bracket_size INTEGER DEFAULT 8,
  event_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.15,
  placement_bonus_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status tournament_status NOT NULL DEFAULT 'draft',
  created_by UUID REFERENCES players(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Legacy Tournament Participants
-- Pre-event-system participant table (originally named
-- tournament_participants, renamed when the event-based tournament
-- system replaced it). Still read/written by the admin app's legacy
-- tournament management (apps/admin/src/lib/actions.ts).
CREATE TABLE legacy_tournament_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  partner_id UUID REFERENCES players(id) ON DELETE SET NULL,
  seed INTEGER,
  placement INTEGER,
  bonus_applied INTEGER DEFAULT 0,
  UNIQUE(tournament_id, player_id)
);

-- Matches
CREATE TABLE matches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID REFERENCES challenges(id) ON DELETE SET NULL,
  tournament_id UUID REFERENCES tournaments(id) ON DELETE SET NULL,
  session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  season_id UUID REFERENCES seasons(id) ON DELETE SET NULL,
  match_type match_type_enum NOT NULL,
  event_type event_type_enum NOT NULL DEFAULT 'rated_challenge',
  rated_flag BOOLEAN NOT NULL DEFAULT TRUE,
  format match_format NOT NULL DEFAULT 'single_21',
  format_weight NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  event_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  completed_flag BOOLEAN NOT NULL DEFAULT FALSE,
  winner_side team_side,
  score_summary TEXT,
  played_at TIMESTAMPTZ,
  submitted_by UUID REFERENCES players(id) ON DELETE SET NULL,
  confirmed_by UUID REFERENCES players(id) ON DELETE SET NULL,
  result_status result_status NOT NULL DEFAULT 'pending_submission',
  walkover_type walkover_type,
  forfeit_player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  notice_hours INTEGER,
  elo_weight_override NUMERIC(4,2),
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Match Participants
CREATE TABLE match_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_side team_side NOT NULL,
  pre_rating INTEGER NOT NULL DEFAULT 1200,
  post_rating INTEGER,
  rating_delta INTEGER,
  points_scored INTEGER NOT NULL DEFAULT 0,
  points_allowed INTEGER NOT NULL DEFAULT 0,
  games_won INTEGER NOT NULL DEFAULT 0,
  games_lost INTEGER NOT NULL DEFAULT 0,
  win_flag BOOLEAN,
  UNIQUE(match_id, player_id)
);

-- Match Games (per-game scores)
CREATE TABLE match_games (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  game_number INTEGER NOT NULL,
  side_a_score INTEGER NOT NULL DEFAULT 0,
  side_b_score INTEGER NOT NULL DEFAULT 0,
  UNIQUE(match_id, game_number)
);

-- Walkovers
CREATE TABLE walkovers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  match_id UUID REFERENCES matches(id) ON DELETE SET NULL,
  reported_by UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  forfeit_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  walkover_type walkover_type NOT NULL,
  notice_hours INTEGER,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  grace_period_ends_at TIMESTAMPTZ,
  admin_confirmed_by UUID REFERENCES players(id) ON DELETE SET NULL,
  admin_confirmed_at TIMESTAMPTZ,
  admin_notes TEXT,
  status walkover_status NOT NULL DEFAULT 'pending',
  elo_penalty_applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Disputes
CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  opened_by UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reason_category dispute_reason NOT NULL,
  description TEXT NOT NULL,
  status dispute_status NOT NULL DEFAULT 'open',
  resolution_type dispute_resolution,
  resolution_note TEXT,
  resolved_by UUID REFERENCES players(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Notifications
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read_flag BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit Logs
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID REFERENCES players(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Head to Head Stats
CREATE TABLE head_to_head_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_a_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_b_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_type match_type_enum NOT NULL,
  total_matches INTEGER NOT NULL DEFAULT 0,
  player_a_wins INTEGER NOT NULL DEFAULT 0,
  player_b_wins INTEGER NOT NULL DEFAULT 0,
  player_a_points INTEGER NOT NULL DEFAULT 0,
  player_b_points INTEGER NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(player_a_id, player_b_id, match_type),
  CHECK (player_a_id < player_b_id)
);

-- Partnership Stats
CREATE TABLE partnership_stats (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_a_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_b_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  matches_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  win_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  total_points_scored INTEGER NOT NULL DEFAULT 0,
  total_points_conceded INTEGER NOT NULL DEFAULT 0,
  avg_elo_delta NUMERIC(6,2) NOT NULL DEFAULT 0,
  last_played_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(player_a_id, player_b_id),
  CHECK (player_a_id < player_b_id)
);

-- Varsity Notes
CREATE TABLE varsity_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Season Snapshots
CREATE TABLE season_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season_id UUID NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  final_singles_elo INTEGER NOT NULL,
  final_doubles_elo INTEGER NOT NULL,
  singles_rank INTEGER,
  doubles_rank INTEGER,
  singles_matches_played INTEGER NOT NULL DEFAULT 0,
  doubles_matches_played INTEGER NOT NULL DEFAULT 0,
  singles_wins INTEGER NOT NULL DEFAULT 0,
  singles_losses INTEGER NOT NULL DEFAULT 0,
  doubles_wins INTEGER NOT NULL DEFAULT 0,
  doubles_losses INTEGER NOT NULL DEFAULT 0,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(player_id, season_id)
);

-- Platform Settings
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES players(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reliability Metrics (per player)
CREATE TABLE reliability_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  challenges_issued INTEGER NOT NULL DEFAULT 0,
  challenges_accepted INTEGER NOT NULL DEFAULT 0,
  challenges_rejected INTEGER NOT NULL DEFAULT 0,
  challenges_expired INTEGER NOT NULL DEFAULT 0,
  matches_completed INTEGER NOT NULL DEFAULT 0,
  no_shows INTEGER NOT NULL DEFAULT 0,
  late_cancellations INTEGER NOT NULL DEFAULT 0,
  early_withdrawals INTEGER NOT NULL DEFAULT 0,
  walkovers_received INTEGER NOT NULL DEFAULT 0,
  avg_confirmation_minutes NUMERIC(8,2) NOT NULL DEFAULT 0,
  dispute_involvement_count INTEGER NOT NULL DEFAULT 0,
  walkover_flag BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Terms — billing periods (e.g. '2026 Summer') that club fees attach to.
CREATE TABLE terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL UNIQUE,
  season TEXT NOT NULL CHECK (season IN ('Spring','Summer','Fall')),
  year INTEGER NOT NULL,
  default_fee_cents INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(season, year)
);

-- Club Fees — one row per (player, term) tracking club-fee payment.
-- Purely administrative: no effect on gameplay, ratings, or leaderboards.
CREATE TABLE club_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  term_id UUID NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  amount_cents INTEGER,
  paid_at TIMESTAMPTZ,
  marked_by UUID REFERENCES players(id),
  method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(player_id, term_id)
);

-- Reinstatement Fees — one-off fees charged to lift a player ban.
CREATE TABLE reinstatement_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount_cents INTEGER,
  paid_at TIMESTAMPTZ,
  marked_by UUID REFERENCES players(id),
  method TEXT,
  ban_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Announcements
CREATE TYPE announcement_type AS ENUM ('info', 'warning', 'urgent', 'event');
CREATE TYPE announcement_status AS ENUM ('draft', 'published');
CREATE TYPE announcement_audience AS ENUM ('all', 'competitive', 'recreational', 'eligible_only');

CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  type announcement_type NOT NULL DEFAULT 'info',
  author_id UUID REFERENCES players(id),
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  send_push BOOLEAN NOT NULL DEFAULT TRUE,
  target_audience announcement_audience NOT NULL DEFAULT 'all',
  expires_at TIMESTAMPTZ,
  status announcement_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE announcement_reads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  announcement_id UUID NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (announcement_id, player_id)
);

-- Push Subscriptions
CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================
-- TOURNAMENT SYSTEM
-- Event-based tournament management with
-- multi-event support, check-in, brackets, and round robin
-- =============================================

-- Tournament Events — each tournament can have multiple events
-- (e.g., Men's Singles + Women's Doubles in same tournament)
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

-- Tournament Participants (Singles)
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

-- Tournament Pairs (Doubles)
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

-- Tournament Fee Tiers — per-tournament fee options (e.g. member vs guest).
CREATE TABLE tournament_fee_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tournament_id, name)
);

-- Tournament Fees — one row per (tournament, player) tracking entry-fee payment.
CREATE TABLE tournament_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  tier_id UUID REFERENCES tournament_fee_tiers(id) ON DELETE SET NULL,
  amount_cents INTEGER,
  paid_at TIMESTAMPTZ,
  marked_by UUID REFERENCES players(id),
  method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tournament_id, player_id)
);

-- Tournament Matches — covers both singles and doubles matches
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
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- Elo snapshot captured when a match result is applied, so that undoMatchResult
  -- and editMatchResult can perfectly reverse Elo changes (including doubles).
  -- Shape: {"players":[{"player_id":"...","discipline":"singles|doubles","before":1234,"after":1245,"delta":11}], ...}
  elo_snapshot JSONB
);

-- Tournament Audit Log
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
