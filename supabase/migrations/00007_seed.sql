-- ============================================================
-- 00007_seed.sql — Development seed data
-- ============================================================

-- Season
INSERT INTO seasons (id, name, start_date, end_date, active_flag) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Spring 2026', '2026-01-15', '2026-04-30', TRUE);

-- Players (16 total: 2 admin, 1 coach, 12 players + 1 pending)
-- Note: user_id left NULL for dev seed; link to auth.users in real setup

INSERT INTO players (id, full_name, email, status, role, eligibility_flag, active_flag, onboarding_completed) VALUES
  -- Admins
  ('b0000000-0000-0000-0000-000000000001', 'Alex Chen', 'alex.chen@sfu.ca', 'eligible_competitive', 'admin', TRUE, TRUE, TRUE),
  ('b0000000-0000-0000-0000-000000000002', 'Jordan Lee', 'jordan.lee@sfu.ca', 'eligible_competitive', 'admin', TRUE, TRUE, TRUE),
  -- Coach
  ('b0000000-0000-0000-0000-000000000003', 'Coach Williams', 'coach.williams@sfu.ca', 'competitive_associate', 'coach_executive', FALSE, TRUE, TRUE),
  -- Eligible Competitive
  ('b0000000-0000-0000-0000-000000000004', 'Sarah Park', 'sarah.park@sfu.ca', 'eligible_competitive', 'player', TRUE, TRUE, TRUE),
  ('b0000000-0000-0000-0000-000000000005', 'David Kim', 'david.kim@sfu.ca', 'eligible_competitive', 'player', TRUE, TRUE, TRUE),
  -- Competitive Associate
  ('b0000000-0000-0000-0000-000000000006', 'Mike Johnson', 'mike.j@sfu.ca', 'competitive_associate', 'player', FALSE, TRUE, TRUE),
  ('b0000000-0000-0000-0000-000000000007', 'Emily Zhang', 'emily.z@sfu.ca', 'competitive_associate', 'player', FALSE, TRUE, TRUE),
  -- Recreational
  ('b0000000-0000-0000-0000-000000000008', 'Tom Wilson', 'tom.w@sfu.ca', 'recreational', 'player', FALSE, TRUE, TRUE),
  ('b0000000-0000-0000-0000-000000000009', 'Lisa Brown', 'lisa.b@sfu.ca', 'recreational', 'player', FALSE, TRUE, TRUE),
  ('b0000000-0000-0000-0000-000000000010', 'James Taylor', 'james.t@sfu.ca', 'recreational', 'player', FALSE, TRUE, TRUE),
  -- Alumni/External
  ('b0000000-0000-0000-0000-000000000011', 'Chris Wong', 'chris.w@gmail.com', 'alumni_external', 'player', FALSE, TRUE, TRUE),
  ('b0000000-0000-0000-0000-000000000012', 'Anna Liu', 'anna.l@gmail.com', 'alumni_external', 'player', FALSE, TRUE, TRUE),
  -- Suspended
  ('b0000000-0000-0000-0000-000000000013', 'Ryan Scott', 'ryan.s@sfu.ca', 'suspended', 'player', FALSE, TRUE, TRUE),
  -- Inactive
  ('b0000000-0000-0000-0000-000000000014', 'Olivia Martin', 'olivia.m@sfu.ca', 'inactive', 'player', FALSE, FALSE, TRUE),
  -- Pending
  ('b0000000-0000-0000-0000-000000000015', 'New Player', 'new@sfu.ca', 'pending_approval', 'player', FALSE, TRUE, FALSE);

-- Ratings
INSERT INTO ratings (player_id, singles_elo, doubles_elo, singles_matches_played, doubles_matches_played, singles_provisional, doubles_provisional, singles_k_factor, doubles_k_factor, singles_wins, singles_losses, doubles_wins, doubles_losses) VALUES
  ('b0000000-0000-0000-0000-000000000001', 1640, 1580, 25, 18, FALSE, FALSE, 24, 18, 18, 7, 13, 5),
  ('b0000000-0000-0000-0000-000000000002', 1560, 1520, 22, 15, FALSE, FALSE, 24, 18, 15, 7, 10, 5),
  ('b0000000-0000-0000-0000-000000000003', 1480, 1450, 20, 12, FALSE, FALSE, 24, 18, 12, 8, 8, 4),
  ('b0000000-0000-0000-0000-000000000004', 1520, 1490, 18, 14, FALSE, FALSE, 24, 18, 13, 5, 10, 4),
  ('b0000000-0000-0000-0000-000000000005', 1500, 1470, 16, 10, FALSE, FALSE, 24, 18, 11, 5, 7, 3),
  ('b0000000-0000-0000-0000-000000000006', 1420, 1390, 14, 9, FALSE, FALSE, 24, 18, 8, 6, 5, 4),
  ('b0000000-0000-0000-0000-000000000007', 1380, 1350, 12, 8, FALSE, FALSE, 24, 18, 6, 6, 4, 4),
  ('b0000000-0000-0000-0000-000000000008', 1300, 1280, 10, 6, FALSE, FALSE, 24, 18, 4, 6, 3, 3),
  ('b0000000-0000-0000-0000-000000000009', 1280, 1260, 9, 5, FALSE, FALSE, 24, 18, 3, 6, 2, 3),
  ('b0000000-0000-0000-0000-000000000010', 1250, 1230, 5, 3, TRUE, TRUE, 40, 32, 2, 3, 1, 2),
  ('b0000000-0000-0000-0000-000000000011', 1400, 1420, 15, 12, FALSE, FALSE, 24, 18, 9, 6, 8, 4),
  ('b0000000-0000-0000-0000-000000000012', 1360, 1340, 11, 7, FALSE, FALSE, 24, 18, 5, 6, 3, 4),
  ('b0000000-0000-0000-0000-000000000013', 1180, 1200, 3, 0, TRUE, TRUE, 40, 32, 0, 3, 0, 0),
  ('b0000000-0000-0000-0000-000000000014', 1320, 1300, 8, 4, FALSE, TRUE, 24, 32, 4, 4, 2, 2);

-- Reliability Metrics
INSERT INTO reliability_metrics (player_id) VALUES
  ('b0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000003'),
  ('b0000000-0000-0000-0000-000000000004'),
  ('b0000000-0000-0000-0000-000000000005'),
  ('b0000000-0000-0000-0000-000000000006'),
  ('b0000000-0000-0000-0000-000000000007'),
  ('b0000000-0000-0000-0000-000000000008'),
  ('b0000000-0000-0000-0000-000000000009'),
  ('b0000000-0000-0000-0000-000000000010'),
  ('b0000000-0000-0000-0000-000000000011'),
  ('b0000000-0000-0000-0000-000000000012'),
  ('b0000000-0000-0000-0000-000000000013'),
  ('b0000000-0000-0000-0000-000000000014');

-- Session
INSERT INTO sessions (id, season_id, name, date, location, host_player_id, status) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Tuesday Practice', '2026-03-24', 'SFU Gym A', 'b0000000-0000-0000-0000-000000000001', 'open');

-- Session Attendance (8 players)
INSERT INTO session_attendance (session_id, player_id) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002'),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004'),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000005'),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000006'),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000008'),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000011'),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000012');

-- Challenges (3 proposed, 2 accepted)
INSERT INTO challenges (id, type, rated_flag, format, event_type, session_id, created_by, status, expires_at) VALUES
  -- Proposed
  ('d0000000-0000-0000-0000-000000000001', 'singles', TRUE, 'single_21', 'rated_challenge', 'c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004', 'proposed', NOW() + INTERVAL '72 hours'),
  ('d0000000-0000-0000-0000-000000000002', 'singles', TRUE, 'bo3_21', 'rated_challenge', 'c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000006', 'proposed', NOW() + INTERVAL '72 hours'),
  ('d0000000-0000-0000-0000-000000000003', 'doubles', TRUE, 'single_21', 'rated_challenge', 'c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'proposed', NOW() + INTERVAL '72 hours'),
  -- Accepted
  ('d0000000-0000-0000-0000-000000000004', 'singles', TRUE, 'single_21', 'rated_challenge', 'c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000005', 'accepted', NOW() + INTERVAL '72 hours'),
  ('d0000000-0000-0000-0000-000000000005', 'singles', TRUE, 'bo3_21', 'rated_challenge', 'c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000011', 'accepted', NOW() + INTERVAL '72 hours');

-- Challenge Participants
INSERT INTO challenge_participants (challenge_id, player_id, role, team_side, confirmation_status) VALUES
  -- Challenge 1: Sarah vs David
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004', 'challenger', 'a', 'accepted'),
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000005', 'opponent', 'b', 'pending'),
  -- Challenge 2: Mike vs Tom
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000006', 'challenger', 'a', 'accepted'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000008', 'opponent', 'b', 'pending'),
  -- Challenge 3: Alex+Sarah vs Jordan+David (doubles)
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 'challenger', 'a', 'accepted'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000004', 'partner', 'a', 'pending'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', 'opponent', 'b', 'pending'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000005', 'opponent_partner', 'b', 'pending'),
  -- Challenge 4: David vs Mike (accepted)
  ('d0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000005', 'challenger', 'a', 'accepted'),
  ('d0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000006', 'opponent', 'b', 'accepted'),
  -- Challenge 5: Chris vs Anna (accepted)
  ('d0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000011', 'challenger', 'a', 'accepted'),
  ('d0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000012', 'opponent', 'b', 'accepted');

-- Completed Matches (5 rated singles)
-- Match 1: Alex (1640) beat Sarah (1520) — single_21
INSERT INTO matches (id, challenge_id, session_id, season_id, match_type, event_type, rated_flag, format, format_weight, event_multiplier, completed_flag, winner_side, score_summary, played_at, result_status) VALUES
  ('e0000000-0000-0000-0000-000000000001', NULL, 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'singles', 'rated_challenge', TRUE, 'single_21', 1.00, 1.00, TRUE, 'a', '21-18', '2026-03-24 14:00:00+00', 'confirmed');

INSERT INTO match_participants (match_id, player_id, team_side, pre_rating, post_rating, rating_delta, points_scored, points_allowed, games_won, games_lost, win_flag) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'a', 1640, 1649, 9, 21, 18, 1, 0, TRUE),
  ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004', 'b', 1520, 1511, -9, 18, 21, 0, 1, FALSE);

INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score) VALUES
  ('e0000000-0000-0000-0000-000000000001', 1, 21, 18);

-- Match 2: David (1500) beat Emily (1380) — bo3_21
INSERT INTO matches (id, challenge_id, session_id, season_id, match_type, event_type, rated_flag, format, format_weight, event_multiplier, completed_flag, winner_side, score_summary, played_at, result_status) VALUES
  ('e0000000-0000-0000-0000-000000000002', NULL, 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'singles', 'rated_challenge', TRUE, 'bo3_21', 1.25, 1.00, TRUE, 'a', '21-15, 18-21, 21-17', '2026-03-24 15:00:00+00', 'confirmed');

INSERT INTO match_participants (match_id, player_id, team_side, pre_rating, post_rating, rating_delta, points_scored, points_allowed, games_won, games_lost, win_flag) VALUES
  ('e0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000005', 'a', 1500, 1511, 11, 60, 53, 2, 1, TRUE),
  ('e0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000007', 'b', 1380, 1369, -11, 53, 60, 1, 2, FALSE);

INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score) VALUES
  ('e0000000-0000-0000-0000-000000000002', 1, 21, 15),
  ('e0000000-0000-0000-0000-000000000002', 2, 18, 21),
  ('e0000000-0000-0000-0000-000000000002', 3, 21, 17);

-- Match 3: Chris (1400) beat Tom (1300) — single_21
INSERT INTO matches (id, challenge_id, session_id, season_id, match_type, event_type, rated_flag, format, format_weight, event_multiplier, completed_flag, winner_side, score_summary, played_at, result_status) VALUES
  ('e0000000-0000-0000-0000-000000000003', NULL, 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'singles', 'rated_challenge', TRUE, 'single_21', 1.00, 1.00, TRUE, 'a', '21-16', '2026-03-24 15:30:00+00', 'confirmed');

INSERT INTO match_participants (match_id, player_id, team_side, pre_rating, post_rating, rating_delta, points_scored, points_allowed, games_won, games_lost, win_flag) VALUES
  ('e0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000011', 'a', 1400, 1410, 10, 21, 16, 1, 0, TRUE),
  ('e0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000008', 'b', 1300, 1290, -10, 16, 21, 0, 1, FALSE);

INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score) VALUES
  ('e0000000-0000-0000-0000-000000000003', 1, 21, 16);

-- Match 4: Jordan (1560) beat Mike (1420) — single_15
INSERT INTO matches (id, challenge_id, session_id, season_id, match_type, event_type, rated_flag, format, format_weight, event_multiplier, completed_flag, winner_side, score_summary, played_at, result_status) VALUES
  ('e0000000-0000-0000-0000-000000000004', NULL, 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'singles', 'rated_challenge', TRUE, 'single_15', 0.75, 1.00, TRUE, 'a', '15-11', '2026-03-24 16:00:00+00', 'confirmed');

INSERT INTO match_participants (match_id, player_id, team_side, pre_rating, post_rating, rating_delta, points_scored, points_allowed, games_won, games_lost, win_flag) VALUES
  ('e0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', 'a', 1560, 1565, 5, 15, 11, 1, 0, TRUE),
  ('e0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000006', 'b', 1420, 1415, -5, 11, 15, 0, 1, FALSE);

INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score) VALUES
  ('e0000000-0000-0000-0000-000000000004', 1, 15, 11);

-- Match 5: Anna (1360) beat Lisa (1280) — single_21
INSERT INTO matches (id, challenge_id, session_id, season_id, match_type, event_type, rated_flag, format, format_weight, event_multiplier, completed_flag, winner_side, score_summary, played_at, result_status) VALUES
  ('e0000000-0000-0000-0000-000000000005', NULL, 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'singles', 'rated_challenge', TRUE, 'single_21', 1.00, 1.00, TRUE, 'a', '21-14', '2026-03-24 16:30:00+00', 'confirmed');

INSERT INTO match_participants (match_id, player_id, team_side, pre_rating, post_rating, rating_delta, points_scored, points_allowed, games_won, games_lost, win_flag) VALUES
  ('e0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000012', 'a', 1360, 1371, 11, 21, 14, 1, 0, TRUE),
  ('e0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000009', 'b', 1280, 1269, -11, 14, 21, 0, 1, FALSE);

INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score) VALUES
  ('e0000000-0000-0000-0000-000000000005', 1, 21, 14);

-- Disputed match (Match 6)
INSERT INTO matches (id, challenge_id, session_id, season_id, match_type, event_type, rated_flag, format, format_weight, event_multiplier, completed_flag, winner_side, score_summary, played_at, result_status) VALUES
  ('e0000000-0000-0000-0000-000000000006', NULL, 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'singles', 'rated_challenge', TRUE, 'single_21', 1.00, 1.00, TRUE, 'a', '21-19', '2026-03-24 17:00:00+00', 'disputed');

INSERT INTO match_participants (match_id, player_id, team_side, pre_rating, points_scored, points_allowed, games_won, games_lost) VALUES
  ('e0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000004', 'a', 1520, 21, 19, 1, 0),
  ('e0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000006', 'b', 1420, 19, 21, 0, 1);

INSERT INTO match_games (match_id, game_number, side_a_score, side_b_score) VALUES
  ('e0000000-0000-0000-0000-000000000006', 1, 21, 19);

INSERT INTO disputes (match_id, opened_by, reason_category, description, status) VALUES
  ('e0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000006', 'score_wrong', 'Score was actually 21-20 not 21-19', 'open');

-- Walkover (no-show, pending)
INSERT INTO walkovers (id, challenge_id, reported_by, forfeit_player_id, walkover_type, reported_at, status) VALUES
  ('f0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000006', 'no_show', NOW(), 'pending');

-- Head to head stats for completed matches
INSERT INTO head_to_head_stats (player_a_id, player_b_id, match_type, total_matches, player_a_wins, player_b_wins, player_a_points, player_b_points, last_played_at) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004', 'singles', 1, 1, 0, 21, 18, '2026-03-24 14:00:00+00'),
  ('b0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000007', 'singles', 1, 1, 0, 60, 53, '2026-03-24 15:00:00+00'),
  ('b0000000-0000-0000-0000-000000000008', 'b0000000-0000-0000-0000-000000000011', 'singles', 1, 0, 1, 16, 21, '2026-03-24 15:30:00+00'),
  ('b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000006', 'singles', 1, 1, 0, 15, 11, '2026-03-24 16:00:00+00'),
  ('b0000000-0000-0000-0000-000000000009', 'b0000000-0000-0000-0000-000000000012', 'singles', 1, 0, 1, 14, 21, '2026-03-24 16:30:00+00');

-- Announcements (3: 1 info, 1 warning, 1 event)
INSERT INTO announcements (id, title, body, type, author_id, pinned, send_push, target_audience, status, created_at) VALUES
  ('aa000000-0000-0000-0000-000000000001', 'Welcome to Spring 2026 Season!', 'The new season has officially started. Check in to sessions and start challenging players to climb the rankings. Good luck to everyone!', 'info', 'b0000000-0000-0000-0000-000000000001', TRUE, TRUE, 'all', 'published', '2026-01-15 10:00:00+00'),
  ('aa000000-0000-0000-0000-000000000002', 'Court Booking Changes', 'Due to facility maintenance, courts 3 and 4 will be unavailable next week (March 30 - April 3). Please plan accordingly.', 'warning', 'b0000000-0000-0000-0000-000000000001', FALSE, TRUE, 'all', 'published', '2026-03-23 09:00:00+00'),
  ('aa000000-0000-0000-0000-000000000003', 'Spring Tournament Registration Open', 'Registration is now open for the Spring Internal Tournament on April 12. Sign up through the tournaments page. Eligible competitive players only.', 'event', 'b0000000-0000-0000-0000-000000000002', FALSE, TRUE, 'eligible_only', 'published', '2026-03-25 12:00:00+00');
