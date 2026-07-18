import type { MatchFormat, PlayerStatus, EventType, TournamentEventType, TournamentMatchFormat, TournamentEventStatus } from '../types/database';

export const PLAYER_STATUS_LABELS: Record<PlayerStatus, string> = {
  competitive: 'Competitive',
  recreational: 'Recreational',
  pending_approval: 'Pending Approval',
  suspended: 'Suspended',
};

export const MATCH_FORMAT_LABELS: Record<MatchFormat, string> = {
  bo3_21: 'Best of 3 to 21',
  single_21: '1 Game to 21',
  single_15: '1 Game to 15',
  single_11: '1 Game to 11',
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  rated_challenge: 'Rated Challenge',
  casual: 'Casual Match',
  tournament: 'Tournament Match',
  trial: 'Official Trial',
  admin_entered: 'Admin Entered',
};

export const MAX_ACTIVE_CHALLENGES = 3;
export const CHALLENGE_EXPIRY_HOURS = 72;
// Nominal starting rating. The ladder uses an affine-stretched scale: everyone
// starts at 400 and strong players climb toward ~1300. This is a 2x stretch of
// the classic 1200-nominal / 400-divisor ELO scale, rebased to 400 — see
// ELO_SCALE in the engine. Every rating and delta is exactly 2x the classic
// value minus 2000, so the underlying win-probability dynamics are unchanged.
export const DEFAULT_ELO = 400;
// Hard bounds on any rating. Enforced everywhere a rating is written — live
// match results, tournament placement bonuses, and admin manual edits — so no
// rating can exceed the top of the ladder or go negative.
export const MAX_ELO = 1500;
export const MIN_ELO = 100;

// Clamp a rating to the allowed [MIN_ELO, MAX_ELO] range.
export function clampElo(rating: number): number {
  return Math.min(MAX_ELO, Math.max(MIN_ELO, rating));
}

export const PROVISIONAL_THRESHOLD = 8;
export const MAX_RATED_PER_SESSION = 3;
export const MAX_REPEAT_OPPONENT_7DAYS = 2;
export const GRACE_PERIOD_MINUTES = 15;
export const LATE_WITHDRAWAL_HOURS = 24;
export const WALKOVER_REVIEW_HOURS = 48;
export const INACTIVITY_DAYS = 45;

// Absolute ELO point awards for tournament placement. Doubled from the classic
// 16/10/6/3 (singles) and 14/9/5/2 (doubles) to match the 2x-stretched scale.
export const PLACEMENT_BONUSES = {
  singles: { champion: 32, finalist: 20, semifinalist: 12, quarterfinalist: 6 },
  doubles: { champion: 28, finalist: 18, semifinalist: 10, quarterfinalist: 4 },
} as const;

export const COLORS = {
  primary: '#1A1A2E',
  accent: '#E94560',
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
  surface: '#0F3460',
  background: '#16213E',
} as const;

// =============================================
// Tournament Event System Constants
// =============================================

export const TOURNAMENT_EVENT_TYPE_LABELS: Record<TournamentEventType, string> = {
  mens_singles: "Men's Singles",
  womens_singles: "Women's Singles",
  open_singles: 'Open Singles',
  mens_doubles: "Men's Doubles",
  womens_doubles: "Women's Doubles",
  mixed_doubles: 'Mixed Doubles',
  open_doubles: 'Open Doubles',
};

export const TOURNAMENT_MATCH_FORMAT_LABELS: Record<TournamentMatchFormat, string> = {
  best_of_3_to_21: 'Best of 3 to 21',
  one_game_21: '1 Game to 21',
  one_game_15: '1 Game to 15',
  one_game_11: '1 Game to 11',
};

export const TOURNAMENT_EVENT_STATUS_LABELS: Record<TournamentEventStatus, string> = {
  registration: 'Registration',
  checkin: 'Check-In',
  bracket_generated: 'Bracket Generated',
  live: 'Live',
  completed: 'Completed',
};

export const TOURNAMENT_EVENT_STATUS_COLORS: Record<TournamentEventStatus, string> = {
  registration: '#3B82F6',
  checkin: '#F59E0B',
  bracket_generated: '#8B5CF6',
  live: '#10B981',
  completed: '#6B7280',
};

export function isDoublesEvent(eventType: TournamentEventType): boolean {
  return ['mens_doubles', 'womens_doubles', 'mixed_doubles', 'open_doubles'].includes(eventType);
}

export function getRoundName(roundNumber: number, totalRounds: number): string {
  const roundsFromEnd = totalRounds - roundNumber + 1;
  if (roundsFromEnd === 1) return 'Final';
  if (roundsFromEnd === 2) return 'Semi-Final';
  if (roundsFromEnd === 3) return 'Quarter-Final';
  const playersInRound = Math.pow(2, roundsFromEnd);
  return `Round of ${playersInRound}`;
}

export function getMaxGamesForFormat(matchFormat: TournamentMatchFormat): number {
  return matchFormat === 'best_of_3_to_21' ? 3 : 1;
}

export function nextPowerOf2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
