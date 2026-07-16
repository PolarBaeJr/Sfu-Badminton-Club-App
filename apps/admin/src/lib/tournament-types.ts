// Row and joined-row shapes for the admin tournament pages/tabs, derived from
// the generated Database type. The *With* types mirror the exact joined
// selects issued by the page-level data fetching (tournaments/page.tsx and
// tournaments/[id]/events/[eventId]/page.tsx).
import type { Database } from '@badminton/shared';

type Tables = Database['public']['Tables'];

export type TournamentRow = Tables['tournaments']['Row'];
export type TournamentEventRow = Tables['tournament_events']['Row'];
export type TournamentMatchRow = Tables['tournament_matches']['Row'];
export type TournamentParticipantRow = Tables['tournament_participants']['Row'];
export type TournamentPairRow = Tables['tournament_pairs']['Row'];

export type PlayerSummary = Pick<Tables['players']['Row'], 'id' | 'full_name' | 'avatar_url'>;

export type RatingsSummary = Pick<
  Tables['ratings']['Row'],
  | 'singles_elo'
  | 'doubles_elo'
  | 'singles_provisional'
  | 'doubles_provisional'
  | 'singles_matches_played'
  | 'doubles_matches_played'
>;

// Singles participant with the player (+ ratings) embed. Supabase may return
// the ratings embed as object-or-array — normalize with pickOne.
export type ParticipantWithPlayer = TournamentParticipantRow & {
  player: (PlayerSummary & { ratings: RatingsSummary | RatingsSummary[] | null }) | null;
};

// Doubles pair with both player embeds.
export type PairWithPlayers = TournamentPairRow & {
  player1: PlayerSummary | null;
  player2: PlayerSummary | null;
};

// A tab entry is a pair (doubles events) or a participant (singles events).
export type TournamentEntry = ParticipantWithPlayer | PairWithPlayers;

// Shape of one game inside tournament_matches.scores (stored as Json).
export type GameScore = { a: number; b: number };

export type RoundRobinStanding = {
  id: string;
  name: string;
  wins: number;
  losses: number;
  pf: number;
  pa: number;
};

// tournaments/page.tsx selects `*, tournament_events(count)`, with a
// fallback plain `*` select if the joined query fails.
export type TournamentWithEventCount = TournamentRow & {
  tournament_events?: { count: number }[] | { count: number } | null;
};
