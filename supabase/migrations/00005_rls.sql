-- ============================================================
-- 00005_rls.sql — Row Level Security Policies (final)
--
-- Consolidated baseline. WITH CHECK clauses are present on every
-- write policy that previously relied on application-layer
-- validation (defense-in-depth hardening).
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE walkovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_tournament_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE head_to_head_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE partnership_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE varsity_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE reliability_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournament_audit_log ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- PLAYERS
-- ============================================================

-- All authenticated users can read approved player public info
CREATE POLICY players_select ON players FOR SELECT TO authenticated
  USING (status != 'pending_approval' OR user_id = auth.uid() OR is_admin(auth.uid()));

-- Players can update own profile
CREATE POLICY players_update_own ON players FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Self-onboarding: a user may insert their own players row, but only with
-- status = 'pending_approval' and only for their own auth.uid(), so
-- onboarding can run with the regular (RLS-aware) Supabase client instead
-- of escaping to the service role key. Admin promotion still goes through
-- admin policies.
CREATE POLICY players_self_insert ON players FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND status = 'pending_approval'
    AND role = 'player'
  );

-- Admins can do anything
CREATE POLICY players_admin ON players FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- RATINGS
-- ============================================================

-- Anyone authenticated can read ratings
CREATE POLICY ratings_select ON ratings FOR SELECT TO authenticated USING (TRUE);

-- A user may insert their own ratings row (one per player; enforced by
-- UNIQUE on ratings.player_id). The check joins through players to confirm
-- ownership. Part of the self-onboarding path.
CREATE POLICY ratings_self_insert ON ratings FOR INSERT TO authenticated
  WITH CHECK (
    player_id IN (SELECT id FROM players WHERE user_id = auth.uid())
  );

-- Only system/admin can modify ratings (via functions)
CREATE POLICY ratings_admin ON ratings FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- SEASONS
-- ============================================================

CREATE POLICY seasons_select ON seasons FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY seasons_admin ON seasons FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- SESSIONS
-- ============================================================

CREATE POLICY sessions_select ON sessions FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY sessions_admin ON sessions FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- SESSION ATTENDANCE
-- ============================================================

CREATE POLICY attendance_select ON session_attendance FOR SELECT TO authenticated USING (TRUE);

-- Players can check themselves in
CREATE POLICY attendance_insert ON session_attendance FOR INSERT TO authenticated
  WITH CHECK (player_id = get_player_id(auth.uid()));

CREATE POLICY attendance_admin ON session_attendance FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- CHALLENGES
-- ============================================================

-- All can read challenges (for leaderboard context)
CREATE POLICY challenges_select ON challenges FOR SELECT TO authenticated USING (TRUE);

-- Players can create challenges
CREATE POLICY challenges_insert ON challenges FOR INSERT TO authenticated
  WITH CHECK (created_by = get_player_id(auth.uid()));

-- Creator can update own challenges (cancel); WITH CHECK ensures update
-- cannot reassign creator to another player
CREATE POLICY challenges_update_own ON challenges FOR UPDATE TO authenticated
  USING (created_by = get_player_id(auth.uid()))
  WITH CHECK (created_by = get_player_id(auth.uid()));

CREATE POLICY challenges_admin ON challenges FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- CHALLENGE PARTICIPANTS
-- ============================================================

CREATE POLICY cp_select ON challenge_participants FOR SELECT TO authenticated USING (TRUE);

-- Caller must be inserting their own row (or admin)
CREATE POLICY cp_insert ON challenge_participants FOR INSERT TO authenticated
  WITH CHECK (
    player_id = get_player_id(auth.uid()) OR is_admin(auth.uid())
  );

-- Players can update their own confirmation
CREATE POLICY cp_update_own ON challenge_participants FOR UPDATE TO authenticated
  USING (player_id = get_player_id(auth.uid()))
  WITH CHECK (player_id = get_player_id(auth.uid()));

CREATE POLICY cp_admin ON challenge_participants FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- MATCHES
-- ============================================================

CREATE POLICY matches_select ON matches FOR SELECT TO authenticated USING (TRUE);

-- Only the submitter (or admin) can insert
CREATE POLICY matches_insert ON matches FOR INSERT TO authenticated
  WITH CHECK (
    submitted_by = get_player_id(auth.uid()) OR is_admin(auth.uid())
  );

-- Participants/submitter/admin can update
CREATE POLICY matches_update ON matches FOR UPDATE TO authenticated
  USING (
    submitted_by = get_player_id(auth.uid()) OR
    id IN (SELECT match_id FROM match_participants WHERE player_id = get_player_id(auth.uid())) OR
    is_admin(auth.uid())
  )
  WITH CHECK (
    submitted_by = get_player_id(auth.uid()) OR
    id IN (SELECT match_id FROM match_participants WHERE player_id = get_player_id(auth.uid())) OR
    is_admin(auth.uid())
  );

CREATE POLICY matches_admin ON matches FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- MATCH PARTICIPANTS
-- ============================================================

CREATE POLICY mp_select ON match_participants FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY mp_admin ON match_participants FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- Must reference an existing match the caller submitted, or admin
CREATE POLICY mp_insert ON match_participants FOR INSERT TO authenticated
  WITH CHECK (
    is_admin(auth.uid()) OR
    match_id IN (SELECT id FROM matches WHERE submitted_by = get_player_id(auth.uid()))
  );

-- ============================================================
-- MATCH GAMES
-- ============================================================

CREATE POLICY mg_select ON match_games FOR SELECT TO authenticated USING (TRUE);

-- Same constraint as match_participants
CREATE POLICY mg_insert ON match_games FOR INSERT TO authenticated
  WITH CHECK (
    is_admin(auth.uid()) OR
    match_id IN (SELECT id FROM matches WHERE submitted_by = get_player_id(auth.uid()))
  );

CREATE POLICY mg_admin ON match_games FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- WALKOVERS
-- ============================================================

-- Involved players and admins can see walkovers
CREATE POLICY walkovers_select ON walkovers FOR SELECT TO authenticated
  USING (
    reported_by = get_player_id(auth.uid()) OR
    forfeit_player_id = get_player_id(auth.uid()) OR
    is_admin(auth.uid())
  );

CREATE POLICY walkovers_insert ON walkovers FOR INSERT TO authenticated
  WITH CHECK (reported_by = get_player_id(auth.uid()));

CREATE POLICY walkovers_admin ON walkovers FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- TOURNAMENTS
-- ============================================================

CREATE POLICY tournaments_select ON tournaments FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY tournaments_admin ON tournaments FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- LEGACY TOURNAMENT PARTICIPANTS
-- ============================================================

CREATE POLICY tp_select ON legacy_tournament_participants FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY tp_admin ON legacy_tournament_participants FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- DISPUTES
-- ============================================================

-- Involved players and admins
CREATE POLICY disputes_select ON disputes FOR SELECT TO authenticated
  USING (
    opened_by = get_player_id(auth.uid()) OR
    is_admin(auth.uid()) OR
    match_id IN (SELECT match_id FROM match_participants WHERE player_id = get_player_id(auth.uid()))
  );

CREATE POLICY disputes_insert ON disputes FOR INSERT TO authenticated
  WITH CHECK (opened_by = get_player_id(auth.uid()));

CREATE POLICY disputes_admin ON disputes FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

-- Players see only their own
CREATE POLICY notifications_select ON notifications FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()));

-- WITH CHECK: cannot reassign a notification to another player
CREATE POLICY notifications_update ON notifications FOR UPDATE TO authenticated
  USING (player_id = get_player_id(auth.uid()))
  WITH CHECK (player_id = get_player_id(auth.uid()));

CREATE POLICY notifications_admin ON notifications FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- AUDIT LOGS — Admin only
-- ============================================================

CREATE POLICY audit_select ON audit_logs FOR SELECT TO authenticated
  USING (is_admin(auth.uid()));

-- Only admins or service role can write (server actions use service role)
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO authenticated
  WITH CHECK (is_admin(auth.uid()));

-- ============================================================
-- HEAD TO HEAD STATS
-- ============================================================

CREATE POLICY h2h_select ON head_to_head_stats FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY h2h_admin ON head_to_head_stats FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- PARTNERSHIP STATS
-- ============================================================

CREATE POLICY ps_select ON partnership_stats FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY ps_admin ON partnership_stats FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- VARSITY NOTES — Admin/Coach only
-- ============================================================

CREATE POLICY vn_select ON varsity_notes FOR SELECT TO authenticated
  USING (is_admin_or_coach(auth.uid()));

CREATE POLICY vn_insert ON varsity_notes FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_coach(auth.uid()));

-- Update must keep coach/admin authorship
CREATE POLICY vn_update ON varsity_notes FOR UPDATE TO authenticated
  USING (is_admin_or_coach(auth.uid()))
  WITH CHECK (is_admin_or_coach(auth.uid()));

CREATE POLICY vn_admin ON varsity_notes FOR DELETE TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- SEASON SNAPSHOTS
-- ============================================================

CREATE POLICY ss_select ON season_snapshots FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY ss_admin ON season_snapshots FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- PLATFORM SETTINGS — Admin only write, all read
-- ============================================================

CREATE POLICY settings_select ON platform_settings FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY settings_admin ON platform_settings FOR ALL TO authenticated USING (is_admin(auth.uid()));

-- ============================================================
-- RELIABILITY METRICS
-- ============================================================

-- Players see own, admins see all
CREATE POLICY rm_select_own ON reliability_metrics FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()) OR is_admin(auth.uid()));

CREATE POLICY rm_admin ON reliability_metrics FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- ANNOUNCEMENTS
-- ============================================================

-- All authenticated users can read published announcements
CREATE POLICY announcements_select ON announcements FOR SELECT TO authenticated
  USING (status = 'published' OR is_admin(auth.uid()));

-- Only admins can create/update/delete
CREATE POLICY announcements_admin ON announcements FOR ALL TO authenticated
  USING (is_admin(auth.uid()));

-- ============================================================
-- ANNOUNCEMENT READS
-- ============================================================

-- Players can read and insert their own reads
CREATE POLICY ann_reads_select ON announcement_reads FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()));

CREATE POLICY ann_reads_insert ON announcement_reads FOR INSERT TO authenticated
  WITH CHECK (player_id = get_player_id(auth.uid()));

-- ============================================================
-- PUSH SUBSCRIPTIONS
-- ============================================================

-- Players manage their own subscriptions
CREATE POLICY push_sub_select ON push_subscriptions FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()) OR is_admin(auth.uid()));

CREATE POLICY push_sub_insert ON push_subscriptions FOR INSERT TO authenticated
  WITH CHECK (player_id = get_player_id(auth.uid()));

CREATE POLICY push_sub_update ON push_subscriptions FOR UPDATE TO authenticated
  USING (player_id = get_player_id(auth.uid()));

CREATE POLICY push_sub_delete ON push_subscriptions FOR DELETE TO authenticated
  USING (player_id = get_player_id(auth.uid()));

-- ============================================================
-- TOURNAMENT SYSTEM
-- ============================================================

-- Players can read everything except the audit log (admin-only:
-- the admin app uses the service role, which bypasses RLS; nothing
-- player-facing reads that table)
CREATE POLICY "Public read tournament_events" ON tournament_events FOR SELECT USING (true);
CREATE POLICY "Public read tournament_participants" ON tournament_participants FOR SELECT USING (true);
CREATE POLICY "Public read tournament_pairs" ON tournament_pairs FOR SELECT USING (true);
CREATE POLICY "Public read tournament_matches" ON tournament_matches FOR SELECT USING (true);
CREATE POLICY "Admin read tournament_audit_log" ON tournament_audit_log
  FOR SELECT USING (is_admin(auth.uid()));

-- Only service role (admin app) can write
CREATE POLICY "Service write tournament_events" ON tournament_events FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write tournament_participants" ON tournament_participants FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write tournament_pairs" ON tournament_pairs FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write tournament_matches" ON tournament_matches FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service write tournament_audit" ON tournament_audit_log FOR ALL USING (auth.role() = 'service_role');
