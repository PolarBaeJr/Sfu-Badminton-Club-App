/**
 * Shape contracts for the tournament-event detail components. These types
 * mirror the joined Supabase rows fetched in
 * `tournaments/[id]/events/[eventId]/page.tsx` and consumed by the tab
 * components (BracketTab, CheckInTab, LeaderboardTab, ParticipantsTab,
 * ResultsTab, RoundRobinTab, EventControlCenter).
 *
 * Properties are nullable / optional where the underlying Supabase select
 * may return them as null. Avoid `as any` in tab components — extend these
 * types instead.
 */

export interface PlayerLite {
  id: string;
  full_name: string;
  avatar_url?: string | null;
  // Some queries join the ratings row; expose as optional to keep accessors safe.
  ratings?: { singles_elo: number | null } | { singles_elo: number | null }[] | null;
  [key: string]: unknown;
}

export interface TournamentEvent {
  id: string;
  tournament_id: string;
  name: string;
  format: string;
  status: string;
  event_type?: string | null;
  match_format?: string | null;
  max_participants?: number | null;
  draw_locked?: boolean | null;
  bracket_size?: number | null;
  starts_at?: string | null;
  notes?: string | null;
  created_at?: string | null;
}

export interface TournamentParticipant {
  id: string;
  event_id: string;
  player_id: string;
  status: string;
  seed_number?: number | null;
  checked_in_at?: string | null;
  withdrew_at?: string | null;
  final_position?: number | null;
  points?: number | null;
  elo_change?: number | null;
  elo_before?: number | null;
  elo_after?: number | null;
  player1?: PlayerLite | null;
  player?: PlayerLite | null;
}

export interface TournamentPair {
  id: string;
  event_id: string;
  player1_id: string;
  player2_id: string;
  status: string;
  seed_number?: number | null;
  checked_in_at?: string | null;
  final_position?: number | null;
  points?: number | null;
  elo_change?: number | null;
  elo_before?: number | null;
  elo_after?: number | null;
  combined_elo?: number | null;
  player1?: PlayerLite | null;
  player2?: PlayerLite | null;
  pair_name?: string | null;
}

export type TournamentEntry = TournamentParticipant | TournamentPair;

export interface TournamentGameScore {
  game_number?: number;
  a: number;
  b: number;
}

export interface TournamentMatch {
  id: string;
  event_id: string;
  round_number?: number | null;
  match_number?: number | null;
  match_index_in_round?: number | null;
  bracket_position?: number | null;
  round_name?: string | null;
  court?: string | null;
  is_bye?: boolean | null;
  status: string;
  winner_side?: 'a' | 'b' | null;
  scores?: TournamentGameScore[] | null;
  side_a_participant_id?: string | null;
  side_b_participant_id?: string | null;
  side_a_pair_id?: string | null;
  side_b_pair_id?: string | null;
  side_a_label?: string | null;
  side_b_label?: string | null;
  // Convenience joins commonly used in admin tabs
  participant_a_id?: string | null;
  participant_b_id?: string | null;
  pair_a_id?: string | null;
  pair_b_id?: string | null;
  winner_participant_id?: string | null;
  winner_pair_id?: string | null;
  scheduled_at?: string | null;
  completed_at?: string | null;
}

export interface TournamentStanding {
  participant_id?: string | null;
  pair_id?: string | null;
  wins: number;
  losses: number;
  points_for?: number | null;
  points_against?: number | null;
  points_diff?: number | null;
  rank?: number | null;
}

/**
 * Base props every tournament tab receives. Tabs that need the bracket
 * matches additionally extend with `TournamentMatchTabProps`.
 */
export interface TournamentTabProps {
  event: TournamentEvent;
  participants: TournamentParticipant[];
  pairs: TournamentPair[];
  isDoubles: boolean;
}

export interface TournamentMatchTabProps extends TournamentTabProps {
  matches: TournamentMatch[];
}

/**
 * Extended props for the EventControlCenter and ParticipantsTab, which
 * additionally receive the full club roster + tournament shell for invite
 * dialogs and admin actions.
 */
export interface TournamentAdminTabProps extends TournamentMatchTabProps {
  tournament: { id: string; name?: string | null; status?: string | null; [key: string]: unknown };
  allPlayers: PlayerLite[];
}
