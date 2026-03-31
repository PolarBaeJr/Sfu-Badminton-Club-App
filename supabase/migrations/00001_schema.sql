-- ============================================================
-- 00001_schema.sql — All tables with constraints and foreign keys
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUM TYPES
-- ============================================================

CREATE TYPE player_status AS ENUM (
  'eligible_competitive',
  'competitive_associate',
  'recreational',
  'alumni_external',
  'suspended',
  'inactive',
  'pending_approval'
);

CREATE TYPE user_role AS ENUM (
  'player',
  'moderator',
  'admin',
  'coach_executive'
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

CREATE TYPE tournament_status AS ENUM ('draft', 'active', 'completed');

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
  'general'
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

-- Tournament Participants
CREATE TABLE tournament_participants (
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

CREATE INDEX idx_push_subscriptions_player ON push_subscriptions(player_id) WHERE active = TRUE;
CREATE INDEX idx_announcements_status ON announcements(status, created_at DESC);
CREATE INDEX idx_announcement_reads_player ON announcement_reads(player_id);
