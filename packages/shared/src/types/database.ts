// Generated types matching the SQL schema

export type PlayerStatus =
  | 'competitive'
  | 'recreational'
  | 'pending_approval'
  | 'suspended';

export type UserRole = 'player' | 'admin';

export type MatchFormat = 'bo3_21' | 'single_21' | 'single_15' | 'single_11';

export type MatchTypeEnum = 'singles' | 'doubles';

export type EventType = 'rated_challenge' | 'casual' | 'tournament' | 'trial' | 'admin_entered';

export type ChallengeStatus =
  | 'proposed'
  | 'partially_confirmed'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'completed'
  | 'disputed'
  | 'walkover_pending'
  | 'walkover_confirmed';

export type ParticipantRole = 'challenger' | 'opponent' | 'partner' | 'opponent_partner';

export type TeamSide = 'a' | 'b';

export type ConfirmationStatus = 'pending' | 'accepted' | 'rejected';

export type ResultStatus =
  | 'pending_submission'
  | 'pending_confirmation'
  | 'confirmed'
  | 'disputed'
  | 'voided'
  | 'walkover'
  | 'incomplete';

export type SessionStatus = 'open' | 'closed';

export type TournamentScope = 'open' | 'eligible_only';
export type TournamentType = 'internal' | 'open_official' | 'invitational';
export type TournamentFormat = 'singles' | 'doubles' | 'mixed_event';
export type TournamentStatus = 'draft' | 'active' | 'completed' | 'archived';

export type DisputeReason =
  | 'score_wrong'
  | 'winner_wrong'
  | 'format_wrong'
  | 'incomplete'
  | 'abuse'
  | 'rules_violation'
  | 'other';

export type DisputeStatus = 'open' | 'under_review' | 'resolved';
export type DisputeResolution = 'accepted' | 'edited' | 'voided' | 'converted_to_casual';

export type WalkoverType = 'withdrawal' | 'no_show';
export type WalkoverStatus = 'pending' | 'confirmed' | 'rejected';

export type NotificationType =
  | 'challenge_received'
  | 'challenge_accepted'
  | 'challenge_rejected'
  | 'challenge_expired'
  | 'challenge_cancelled'
  | 'result_pending'
  | 'result_confirmed'
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'rank_changed'
  | 'session_reminder'
  | 'walkover_reported'
  | 'walkover_confirmed'
  | 'opponent_withdrew'
  | 'admin_alert'
  | 'general'
  | 'tournament_bracket_published'
  | 'tournament_match_ready'
  | 'tournament_match_result'
  | 'tournament_event_completed'
  | 'tournament_checkin_open';

// Table row types
export type AnnouncementType = 'info' | 'warning' | 'urgent' | 'event';
export type AnnouncementStatus = 'draft' | 'published';
export type AnnouncementAudience = 'all' | 'competitive' | 'recreational' | 'eligible_only';

export interface Player {
  id: string;
  user_id: string | null;
  full_name: string;
  display_name: string | null;
  email: string;
  phone: string | null;
  status: PlayerStatus;
  role: UserRole;
  active_flag: boolean;
  is_exec: boolean;
  fee_exempt: boolean;
  is_banned: boolean;
  banned_at: string | null;
  banned_by: string | null;
  ban_reason: string | null;
  onboarding_completed: boolean;
  avatar_url: string | null;
  bio: string | null;
  exec_title: string | null;
  waiver_reset_at: string | null;
  joined_at: string;
  last_active_at: string;
  created_at: string;
  updated_at: string;
}

export interface Rating {
  id: string;
  player_id: string;
  singles_elo: number;
  doubles_elo: number;
  singles_matches_played: number;
  doubles_matches_played: number;
  singles_provisional: boolean;
  doubles_provisional: boolean;
  singles_k_factor: number;
  doubles_k_factor: number;
  singles_wins: number;
  singles_losses: number;
  doubles_wins: number;
  doubles_losses: number;
  singles_points_scored: number;
  singles_points_allowed: number;
  doubles_points_scored: number;
  doubles_points_allowed: number;
  singles_games_won: number;
  singles_games_lost: number;
  doubles_games_won: number;
  doubles_games_lost: number;
  current_singles_streak: number;
  best_singles_streak: number;
  current_doubles_streak: number;
  best_doubles_streak: number;
  created_at: string;
  updated_at: string;
}

export interface Season {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  active_flag: boolean;
  competitive_fee_cents: number;
  recreational_fee_cents: number;
  created_at: string;
  updated_at: string;
}

export type SessionGroup = 'competitive' | 'recreational' | 'all';

export type AttendanceStatus = 'checked_in' | 'present' | 'no_show' | 'excused';

export type SessionIntent = 'going' | 'declined';

export interface Session {
  id: string;
  season_id: string | null;
  name: string | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  location: string;
  host_player_id: string | null;
  status: SessionStatus;
  track: SessionGroup;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionAttendance {
  id: string;
  session_id: string;
  player_id: string;
  checked_in_at: string;
  status: AttendanceStatus;
  marked_by: string | null;
  marked_at: string | null;
}

export interface Challenge {
  id: string;
  type: MatchTypeEnum;
  rated_flag: boolean;
  format: MatchFormat;
  event_type: EventType;
  session_id: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  created_by: string;
  status: ChallengeStatus;
  note: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface ChallengeParticipant {
  id: string;
  challenge_id: string;
  player_id: string;
  role: ParticipantRole;
  team_side: TeamSide;
  confirmation_status: ConfirmationStatus;
  responded_at: string | null;
}

export interface Match {
  id: string;
  challenge_id: string | null;
  tournament_id: string | null;
  session_id: string | null;
  season_id: string | null;
  match_type: MatchTypeEnum;
  event_type: EventType;
  rated_flag: boolean;
  format: MatchFormat;
  format_weight: number;
  event_multiplier: number;
  completed_flag: boolean;
  winner_side: TeamSide | null;
  score_summary: string | null;
  played_at: string | null;
  submitted_by: string | null;
  confirmed_by: string | null;
  result_status: ResultStatus;
  walkover_type: WalkoverType | null;
  forfeit_player_id: string | null;
  notice_hours: number | null;
  elo_weight_override: number | null;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatchParticipant {
  id: string;
  match_id: string;
  player_id: string;
  team_side: TeamSide;
  pre_rating: number;
  post_rating: number | null;
  rating_delta: number | null;
  points_scored: number;
  points_allowed: number;
  games_won: number;
  games_lost: number;
  win_flag: boolean | null;
}

export interface MatchGame {
  id: string;
  match_id: string;
  game_number: number;
  side_a_score: number;
  side_b_score: number;
}

export interface Walkover {
  id: string;
  challenge_id: string;
  match_id: string | null;
  reported_by: string;
  forfeit_player_id: string;
  walkover_type: WalkoverType;
  notice_hours: number | null;
  reported_at: string;
  grace_period_ends_at: string | null;
  admin_confirmed_by: string | null;
  admin_confirmed_at: string | null;
  admin_notes: string | null;
  status: WalkoverStatus;
  elo_penalty_applied: boolean;
  created_at: string;
  updated_at: string;
}

export interface Tournament {
  id: string;
  season_id: string | null;
  name: string;
  scope: TournamentScope;
  type: TournamentType;
  format: TournamentFormat;
  start_date: string;
  end_date: string | null;
  bracket_size: number;
  event_multiplier: number;
  placement_bonus_enabled: boolean;
  status: TournamentStatus;
  suspended_at: string | null;
  suspension_reason: string | null;
  waiver_text: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TournamentParticipant {
  id: string;
  tournament_id: string;
  player_id: string;
  partner_id: string | null;
  seed: number | null;
  placement: number | null;
  bonus_applied: number;
}

export interface Dispute {
  id: string;
  match_id: string;
  opened_by: string;
  reason_category: DisputeReason;
  description: string;
  status: DisputeStatus;
  resolution_type: DisputeResolution | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  player_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  read_flag: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AuditLog {
  id: string;
  actor_id: string | null;
  action_type: string;
  target_type: string;
  target_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

export interface HeadToHeadStat {
  id: string;
  player_a_id: string;
  player_b_id: string;
  match_type: MatchTypeEnum;
  total_matches: number;
  player_a_wins: number;
  player_b_wins: number;
  player_a_points: number;
  player_b_points: number;
  last_played_at: string | null;
  updated_at: string;
}

export interface PartnershipStat {
  id: string;
  player_a_id: string;
  player_b_id: string;
  matches_played: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_points_scored: number;
  total_points_conceded: number;
  avg_elo_delta: number;
  last_played_at: string | null;
  updated_at: string;
}

export interface VarsityNote {
  id: string;
  player_id: string;
  author_id: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface SeasonSnapshot {
  id: string;
  player_id: string;
  season_id: string;
  final_singles_elo: number;
  final_doubles_elo: number;
  singles_rank: number | null;
  doubles_rank: number | null;
  singles_matches_played: number;
  doubles_matches_played: number;
  singles_wins: number;
  singles_losses: number;
  doubles_wins: number;
  doubles_losses: number;
  captured_at: string;
}

export interface PlatformSetting {
  key: string;
  value: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string;
}

export interface ReliabilityMetrics {
  id: string;
  player_id: string;
  challenges_issued: number;
  challenges_accepted: number;
  challenges_rejected: number;
  challenges_expired: number;
  matches_completed: number;
  no_shows: number;
  late_cancellations: number;
  early_withdrawals: number;
  walkovers_received: number;
  avg_confirmation_minutes: number;
  dispute_involvement_count: number;
  walkover_flag: boolean;
  updated_at: string;
}

export interface ClubFee {
  id: string;
  player_id: string | null;
  manual_name: string | null;
  season_id: string;
  amount_cents: number | null;
  paid_at: string | null;
  marked_by: string | null;
  method: string | null;
  created_at: string;
}

export interface ReinstatementFee {
  id: string;
  player_id: string;
  amount_cents: number | null;
  paid_at: string | null;
  marked_by: string | null;
  method: string | null;
  ban_reason: string | null;
  created_at: string;
}

export interface TournamentFeeTier {
  id: string;
  tournament_id: string;
  name: string;
  amount_cents: number;
  is_default: boolean;
  sort_order: number;
  created_at: string;
}

export interface TournamentFee {
  id: string;
  tournament_id: string;
  player_id: string;
  tier_id: string | null;
  amount_cents: number | null;
  paid_at: string | null;
  marked_by: string | null;
  method: string | null;
  created_at: string;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  author_id: string | null;
  pinned: boolean;
  send_push: boolean;
  target_audience: AnnouncementAudience;
  expires_at: string | null;
  status: AnnouncementStatus;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementRead {
  id: string;
  announcement_id: string;
  player_id: string;
  read_at: string;
}

export interface PushSubscription {
  id: string;
  player_id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  user_agent: string | null;
  active: boolean;
  created_at: string;
}

export type WaiverDocument = 'waiver' | 'code_of_conduct' | 'terms_of_use' | 'privacy_policy';

export interface LegalDocument {
  document: WaiverDocument;
  version: string;
  content: string;
  reacceptance_required_since: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface WaiverAcceptance {
  id: string;
  player_id: string;
  document: WaiverDocument;
  version: string;
  accepted_at: string;
  age_attestation: boolean;
  user_agent: string | null;
}

export interface EventWaiverAcceptance {
  id: string;
  player_id: string;
  tournament_id: string;
  waiver_hash: string;
  accepted_at: string;
  user_agent: string | null;
}

// Joined/view types
export interface PlayerWithRating extends Player {
  ratings: Rating;
}

export interface ChallengeWithParticipants extends Challenge {
  challenge_participants: (ChallengeParticipant & { player: Player })[];
  creator: Player;
}

export interface MatchWithDetails extends Match {
  match_participants: (MatchParticipant & { player: Player })[];
  match_games: MatchGame[];
}

// =============================================
// Tournament Event System Types
// =============================================

export type TournamentEventType =
  | 'mens_singles'
  | 'womens_singles'
  | 'open_singles'
  | 'mens_doubles'
  | 'womens_doubles'
  | 'mixed_doubles'
  | 'open_doubles';

export type TournamentEventFormat = 'single_elimination' | 'round_robin';

export type TournamentMatchFormat = 'best_of_3_to_21' | 'one_game_21' | 'one_game_15' | 'one_game_11';

export type TournamentSeedingMethod = 'elo' | 'manual' | 'random';

export type TournamentEventStatus = 'registration' | 'checkin' | 'bracket_generated' | 'live' | 'completed';

export type TournamentParticipantStatus = 'registered' | 'checked_in' | 'withdrawn' | 'disqualified' | 'no_show';

export type TournamentMatchStatus = 'pending' | 'ready' | 'live' | 'completed' | 'walkover' | 'disputed' | 'voided';

export interface TournamentEvent {
  id: string;
  tournament_id: string;
  event_type: TournamentEventType;
  format: TournamentEventFormat;
  match_format: TournamentMatchFormat;
  max_participants: number | null;
  seeding_method: TournamentSeedingMethod;
  elo_multiplier: number;
  placement_bonus_enabled: boolean;
  draw_locked: boolean;
  status: TournamentEventStatus;
  created_at: string;
  updated_at: string;
}

export interface TournamentEventParticipant {
  id: string;
  event_id: string;
  player_id: string;
  seed_number: number | null;
  status: TournamentParticipantStatus;
  checked_in_at: string | null;
  checked_in_by: string | null;
  final_position: number | null;
  elo_before: number | null;
  elo_after: number | null;
  elo_change: number | null;
  points: number;
  added_by: string | null;
  notes: string | null;
  created_at: string;
}

export interface TournamentPair {
  id: string;
  event_id: string;
  player1_id: string;
  player2_id: string;
  pair_name: string | null;
  seed_number: number | null;
  status: TournamentParticipantStatus;
  checked_in_at: string | null;
  checked_in_by: string | null;
  final_position: number | null;
  combined_elo: number | null;
  points: number;
  added_by: string | null;
  notes: string | null;
  created_at: string;
}

export interface TournamentMatch {
  id: string;
  event_id: string;
  round_number: number;
  round_name: string | null;
  bracket_position: number;
  match_number: number | null;
  participant_a_id: string | null;
  participant_b_id: string | null;
  pair_a_id: string | null;
  pair_b_id: string | null;
  winner_participant_id: string | null;
  winner_pair_id: string | null;
  loser_participant_id: string | null;
  loser_pair_id: string | null;
  scores: Array<{ a: number; b: number }> | null;
  winner_to_match_id: string | null;
  winner_to_position: 'a' | 'b' | null;
  court: string | null;
  scheduled_time: string | null;
  status: TournamentMatchStatus;
  walkover_winner: 'a' | 'b' | null;
  walkover_reason: string | null;
  result_entered_by: string | null;
  result_entered_at: string | null;
  is_bye: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TournamentAuditEntry {
  id: string;
  tournament_id: string | null;
  event_id: string | null;
  match_id: string | null;
  action: string;
  performed_by: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

// Joined types for tournament events
export interface TournamentEventParticipantWithPlayer extends TournamentEventParticipant {
  player: Player;
}

export interface TournamentPairWithPlayers extends TournamentPair {
  player1: Player;
  player2: Player;
}

export interface TournamentMatchWithParticipants extends TournamentMatch {
  participant_a: TournamentEventParticipantWithPlayer | null;
  participant_b: TournamentEventParticipantWithPlayer | null;
  pair_a: TournamentPairWithPlayers | null;
  pair_b: TournamentPairWithPlayers | null;
}
