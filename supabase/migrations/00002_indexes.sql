-- ============================================================
-- 00002_indexes.sql — Performance indexes
-- ============================================================

-- Players
CREATE INDEX idx_players_status ON players(status);
CREATE INDEX idx_players_eligibility ON players(eligibility_flag);
CREATE INDEX idx_players_active ON players(active_flag);
CREATE INDEX idx_players_user_id ON players(user_id);
CREATE INDEX idx_players_role ON players(role);
CREATE INDEX idx_players_last_active ON players(last_active_at);

-- Ratings (leaderboard sorts)
CREATE INDEX idx_ratings_singles_elo ON ratings(singles_elo DESC);
CREATE INDEX idx_ratings_doubles_elo ON ratings(doubles_elo DESC);
CREATE INDEX idx_ratings_player ON ratings(player_id);

-- Sessions
CREATE INDEX idx_sessions_date ON sessions(date);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_season ON sessions(season_id);

-- Session Attendance
CREATE INDEX idx_attendance_session ON session_attendance(session_id);
CREATE INDEX idx_attendance_player ON session_attendance(player_id);

-- Challenges
CREATE INDEX idx_challenges_status ON challenges(status);
CREATE INDEX idx_challenges_created_by ON challenges(created_by);
CREATE INDEX idx_challenges_session ON challenges(session_id);
CREATE INDEX idx_challenges_expires ON challenges(expires_at);
CREATE INDEX idx_challenges_created_at ON challenges(created_at);

-- Challenge Participants
CREATE INDEX idx_challenge_parts_challenge ON challenge_participants(challenge_id);
CREATE INDEX idx_challenge_parts_player ON challenge_participants(player_id);
CREATE INDEX idx_challenge_parts_status ON challenge_participants(confirmation_status);

-- Matches
CREATE INDEX idx_matches_played_at ON matches(played_at);
CREATE INDEX idx_matches_result_status ON matches(result_status);
CREATE INDEX idx_matches_match_type ON matches(match_type);
CREATE INDEX idx_matches_session ON matches(session_id);
CREATE INDEX idx_matches_tournament ON matches(tournament_id);
CREATE INDEX idx_matches_challenge ON matches(challenge_id);
CREATE INDEX idx_matches_season ON matches(season_id);
CREATE INDEX idx_matches_rated ON matches(rated_flag);
CREATE INDEX idx_matches_created_at ON matches(created_at);

-- One match per challenge (double-submission guard used by
-- apps/player/src/lib/actions/matches.ts).
CREATE UNIQUE INDEX matches_challenge_id_unique
  ON matches(challenge_id) WHERE challenge_id IS NOT NULL;

-- Match Participants
CREATE INDEX idx_match_parts_match ON match_participants(match_id);
CREATE INDEX idx_match_parts_player ON match_participants(player_id);
CREATE INDEX idx_match_parts_player_match ON match_participants(player_id, match_id);

-- Match Games
CREATE INDEX idx_match_games_match ON match_games(match_id);

-- Walkovers
CREATE INDEX idx_walkovers_challenge ON walkovers(challenge_id);
CREATE INDEX idx_walkovers_status ON walkovers(status);
CREATE INDEX idx_walkovers_forfeit ON walkovers(forfeit_player_id);

-- Tournaments
CREATE INDEX idx_tournaments_season ON tournaments(season_id);
CREATE INDEX idx_tournaments_status ON tournaments(status);

-- Legacy Tournament Participants
CREATE INDEX idx_tournament_parts_tournament ON legacy_tournament_participants(tournament_id);
CREATE INDEX idx_tournament_parts_player ON legacy_tournament_participants(player_id);

-- Disputes
CREATE INDEX idx_disputes_match ON disputes(match_id);
CREATE INDEX idx_disputes_status ON disputes(status);
CREATE INDEX idx_disputes_opened_by ON disputes(opened_by);

-- Notifications
CREATE INDEX idx_notifications_player ON notifications(player_id);
CREATE INDEX idx_notifications_read ON notifications(player_id, read_flag);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);

-- Audit Logs
CREATE INDEX idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX idx_audit_action ON audit_logs(action_type);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- Head to Head
CREATE INDEX idx_h2h_players ON head_to_head_stats(player_a_id, player_b_id);
CREATE INDEX idx_h2h_type ON head_to_head_stats(match_type);

-- Partnership Stats
CREATE INDEX idx_partnership_players ON partnership_stats(player_a_id, player_b_id);

-- Season Snapshots
CREATE INDEX idx_snapshots_season ON season_snapshots(season_id);
CREATE INDEX idx_snapshots_player ON season_snapshots(player_id);

-- Reliability
CREATE INDEX idx_reliability_player ON reliability_metrics(player_id);
CREATE INDEX idx_reliability_noshows ON reliability_metrics(no_shows);

-- Club Fees (fee-collection list is filtered by period)
CREATE INDEX idx_club_fees_period ON club_fees(period);

-- Announcements / Push Subscriptions
CREATE INDEX idx_push_subscriptions_player ON push_subscriptions(player_id) WHERE active = TRUE;
CREATE INDEX idx_announcements_status ON announcements(status, created_at DESC);
CREATE INDEX idx_announcement_reads_player ON announcement_reads(player_id);

-- Tournament system
CREATE INDEX idx_tournament_events_tournament ON tournament_events(tournament_id);
CREATE INDEX idx_tournament_participants_event ON tournament_participants(event_id);
CREATE INDEX idx_tournament_participants_player ON tournament_participants(player_id);
CREATE INDEX idx_tournament_pairs_event ON tournament_pairs(event_id);
CREATE INDEX idx_tournament_matches_event ON tournament_matches(event_id);
CREATE INDEX idx_tournament_matches_round ON tournament_matches(event_id, round_number);
CREATE INDEX idx_tournament_audit_event ON tournament_audit_log(event_id);

-- Composite indexes for tournament filter hot paths.
--
-- Many tournament server actions filter rows by `event_id` AND `status` (or
-- `final_position`). The single-column event_id indexes already exist, but
-- Postgres still has to scan every row in the matched event to apply the
-- secondary predicate. These composites let the planner satisfy both
-- predicates from the index alone, which matters for finalize / leaderboard
-- / list pages on large events.

-- Singles participants — used by:
--   apps/admin/src/lib/tournament-actions.ts (capacity checks, finalize loops)
--   apps/admin/src/app/tournaments/[id]/page.tsx (per-event count aggregation)
CREATE INDEX idx_tournament_participants_event_status
  ON tournament_participants(event_id, status);

CREATE INDEX idx_tournament_participants_event_final_position
  ON tournament_participants(event_id, final_position)
  WHERE final_position IS NOT NULL;

-- Doubles pairs — same access pattern as participants.
CREATE INDEX idx_tournament_pairs_event_status
  ON tournament_pairs(event_id, status);

CREATE INDEX idx_tournament_pairs_event_final_position
  ON tournament_pairs(event_id, final_position)
  WHERE final_position IS NOT NULL;

-- Matches — finalize() filters by event_id + status to find unfinished matches,
-- and the bracket UI filters by event_id + round_number (already covered by
-- idx_tournament_matches_round). Add an event+status composite for the rest.
CREATE INDEX idx_tournament_matches_event_status
  ON tournament_matches(event_id, status);
