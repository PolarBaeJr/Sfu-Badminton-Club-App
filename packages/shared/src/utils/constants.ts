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

// Clamp a rating to the allowed range.
//
// The bounds were hardcoded here and duplicated as LEAST(1500, GREATEST(100,…))
// in SQL, so raising the ceiling meant a migration AND a redeploy, in lockstep
// or the two engines would disagree. They now come from
// platform_settings.rating_defaults; the constants remain the fallback for any
// caller that has no settings to hand.
//
// An inverted or non-finite pair is ignored rather than honoured — max <= min
// collapses every rating to one value, and that must not be reachable from a
// settings typo.
export interface EloBounds {
  min?: number | null;
  max?: number | null;
}

export function resolveEloBounds(bounds?: EloBounds | null): { min: number; max: number } {
  // Number(null) is 0 and Number('') is 0, both finite — so an absent bound
  // would silently become a floor of zero rather than falling back. The SQL
  // side checks for NULL explicitly; this has to match it or the two engines
  // clamp differently.
  const min = toBound(bounds?.min);
  const max = toBound(bounds?.max);
  if (min === null || max === null || max <= min) {
    return { min: MIN_ELO, max: MAX_ELO };
  }
  return { min, max };
}

function toBound(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function clampElo(rating: number, bounds?: EloBounds | null): number {
  const { min, max } = resolveEloBounds(bounds);
  return Math.min(max, Math.max(min, rating));
}

export const CLUB_TIMEZONE = 'America/Vancouver';

// Session check-in window. session_checkin_open()
// (00008_richer_attendance.sql:56-58) is the enforcement source of truth, and
// it reads both values out of the platform_settings 'session_attendance' row
// on EVERY call. They are admin-editable at runtime, not constants.
//
// The pair below is a LAST-RESORT FALLBACK for callers that cannot reach the
// database — client components and pure formatters. Server callers should
// fetch the row and pass it through parseCheckinSettings(); see
// FALLBACK_CHECKIN_SETTINGS in session-window.ts.
//
// These track what prod is configured to today. That is a snapshot, not a
// contract: an admin editing the setting silently invalidates them. It has
// already bitten once — a client-only 'null' opening edge showed the Check In
// button for every upcoming session while the server (30 min) rejected it,
// fixed in 231b0af.
//
// Do NOT "restore" these to the 120 / null seeded by 00008. That seed only
// applied on first insert (ON CONFLICT DO NOTHING); prod has since been
// retuned away from it. Two stale tests asserted the seed values and were
// corrected in f677808 rather than the constants being reverted to match.
export const SESSION_DEFAULT_DURATION_MINUTES = 60;
// Check-in opens this many minutes before start (null = only a closing edge).
export const SESSION_CHECKIN_OPENS_MINUTES_BEFORE: number | null = 30;

// Shape of a session check-in QR token: randomBytes(24).toString('hex').
// The admin generator (getOrCreateSessionCheckinToken) and the player
// validator (checkInWithToken) must agree, so the pattern lives here rather
// than being inlined twice. Mirrors the calendar feed route's /^[0-9a-f]{48}$/.
export const CHECKIN_TOKEN_REGEX = /^[0-9a-f]{48}$/;

// Name of the Supabase auth cookie, pinned rather than derived.
//
// supabase-js builds it as `sb-<first hostname label>-auth-token` from
// NEXT_PUBLIC_SUPABASE_URL, so the session is silently tied to the domain: the
// current badminton.polardev.org yields "sb-badminton-auth-token", while
// sfubadminton.com would yield "sb-sfubadminton-auth-token". Changing that URL
// would therefore make every existing cookie unreadable and sign everyone out,
// re-triggering passkey verification with it.
//
// This value is exactly what the library derives today, so pinning it changes
// nothing now — and means the pending move off polardev.org becomes a plain
// config edit that sessions survive. Do not "tidy" the badminton- prefix: the
// string must keep matching cookies already in browsers.
export const AUTH_COOKIE_NAME = 'sb-badminton-auth-token';

export const PROVISIONAL_THRESHOLD = 8;

// Margin-of-victory bonus applied when a multi-game match ends in a sweep
// (2-0 / 3-0). Applies to both sides: the winner gains slightly more, the loser
// drops slightly more. Kept small on purpose — see getMarginMultiplier().
export const SWEEP_MARGIN_MULTIPLIER = 1.15;
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

// Per-format scoring rules: how many games the match is a best-of, the target a
// game is played to, and the deuce cap. Rally scoring: reach the target, but win
// by two — so at 20-20 play continues (22-20, 23-21, …) until the cap, where the
// next point takes it (30-29). 21-20 is therefore NOT a legal finish, while
// 30-29 is.
//
// NOTE: the 21-point cap of 30 is the BWF rule. The caps for the 15- and
// 11-point club formats are our own convention — adjust here if the club plays
// them differently; nothing else needs to change.
// One cap rule everywhere, preset or custom: target + 9, mirroring the BWF
// 21 -> 30. Earlier this file guessed different caps per format; a single rule
// is easier to reason about and is what the custom formats need anyway.
export function pointsCap(target: number): number {
  return target + 9;
}

export const CUSTOM_FORMAT_BOUNDS = {
  minGames: 1, maxGames: 7,   // best-of must be odd so a majority exists
  minPoints: 5, maxPoints: 30,
} as const;

/**
 * Is this a best-of a match could actually be decided by? An even best-of has
 * no majority, so it can end level and never resolve — the reason the CHECK in
 * migration 00031 demands an odd number. Typed into a form rather than picked
 * from a list, that is a mistake worth catching before the insert does.
 */
export function isLegalCustomGames(gamesPerMatch: number): boolean {
  const { minGames, maxGames } = CUSTOM_FORMAT_BOUNDS;
  return Number.isInteger(gamesPerMatch)
    && gamesPerMatch % 2 === 1
    && gamesPerMatch >= minGames
    && gamesPerMatch <= maxGames;
}

/** Companion to isLegalCustomGames for the points half of the shape. */
export function isLegalCustomPoints(pointsPerGame: number): boolean {
  const { minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;
  return Number.isInteger(pointsPerGame)
    && pointsPerGame >= minPoints
    && pointsPerGame <= maxPoints;
}

/**
 * The one line of help that sits under a typed "best of X to Y" pair: what is
 * wrong with it, or — once it is valid — the rule the scores will be judged
 * against, since the cap is not obvious from the target. Shared so every form
 * that lets the numbers be typed says the same thing.
 */
export function customFormatHint(gamesPerMatch: number, pointsPerGame: number): string {
  const { minGames, maxGames, minPoints, maxPoints } = CUSTOM_FORMAT_BOUNDS;
  if (!isLegalCustomGames(gamesPerMatch)) {
    return `Best of must be an odd number from ${minGames} to ${maxGames} — an even best-of can end level, so it could never be decided.`;
  }
  if (!isLegalCustomPoints(pointsPerGame)) {
    return `Points per game must be between ${minPoints} and ${maxPoints}.`;
  }
  return `A game is won by two clear points, or at ${pointsCap(pointsPerGame)}.`;
}

export const FORMAT_RULES: Record<MatchFormat, { bestOf: number; target: number; cap: number }> = {
  bo3_21:    { bestOf: 3, target: 21, cap: pointsCap(21) },
  single_21: { bestOf: 1, target: 21, cap: pointsCap(21) },
  single_15: { bestOf: 1, target: 15, cap: pointsCap(15) },
  single_11: { bestOf: 1, target: 11, cap: pointsCap(11) },
};

/**
 * Rules for a match that may define its own shape. Custom values win when
 * present; otherwise the preset applies. Mirrors effective_target/
 * effective_best_of in migration 00031.
 */
export function getRulesFor(
  format: AnyMatchFormat,
  gamesPerMatch?: number | null,
  pointsPerGame?: number | null,
): { bestOf: number; target: number; cap: number } {
  const preset = getFormatRules(format);
  const target = pointsPerGame ?? preset.target;
  return { bestOf: gamesPerMatch ?? preset.bestOf, target, cap: pointsCap(target) };
}

/** Elo weight for a custom shape — mirrors derived_format_weight (00031). */
export function derivedFormatWeight(bestOf: number, target: number): number {
  const raw = (target / 21) * (bestOf > 1 ? 1.25 : 1.0);
  return Math.min(1.5, Math.max(0.25, raw));
}

// Tournaments carry their own format enum with the same four shapes, so the
// rules are mapped rather than duplicated — one source of truth for what a
// legal score is, whether the match came from a challenge or a bracket.
export const TOURNAMENT_FORMAT_RULES: Record<TournamentMatchFormat, { bestOf: number; target: number; cap: number }> = {
  best_of_3_to_21: FORMAT_RULES.bo3_21,
  one_game_21:     FORMAT_RULES.single_21,
  one_game_15:     FORMAT_RULES.single_15,
  one_game_11:     FORMAT_RULES.single_11,
};

export type AnyMatchFormat = MatchFormat | TournamentMatchFormat;

export function getFormatRules(format: AnyMatchFormat): { bestOf: number; target: number; cap: number } {
  const table = { ...FORMAT_RULES, ...TOURNAMENT_FORMAT_RULES } as Record<
    string,
    { bestOf: number; target: number; cap: number } | undefined
  >;
  // Unknown format: fall back to the 21-point rules rather than throwing, so a
  // future enum member can never crash score entry before it's mapped here.
  return table[format] ?? FORMAT_RULES.single_21;
}

/** Highest score legally reachable in this format — the deuce cap. */
export function getMaxScoreForFormat(format: AnyMatchFormat): number {
  return getFormatRules(format).cap;
}

/**
 * Is this a legal way for a single game to end?
 *
 * Legal finishes, for target T and cap C:
 *  - exactly T, with the loser at most T-2      (21-19, 21-0)
 *  - above T but below C, winning by exactly 2  (22-20, 23-21, … 29-27)
 *  - at C, with the loser on C-2 or C-1         (30-28 win-by-two, 30-29 the cap)
 *
 * `timeExceeded` switches to the relaxed rules below — pass it only when the
 * exec has said the match was cut short (00047).
 */
export function isLegalGameScore(
  a: number,
  b: number,
  format: AnyMatchFormat,
  gamesPerMatch?: number | null,
  pointsPerGame?: number | null,
  timeExceeded?: boolean,
): boolean {
  if (timeExceeded) return isLegalTimeExceededScore(a, b, format, gamesPerMatch, pointsPerGame);
  const { target, cap } = getRulesFor(format, gamesPerMatch, pointsPerGame);
  const winner = Math.max(a, b);
  const loser = Math.min(a, b);
  if (a === b) return false;                       // a game must be won
  if (loser < 0 || winner > cap) return false;
  if (winner === target) return loser <= target - 2;
  if (winner > target && winner < cap) return winner - loser === 2;
  if (winner === cap) return loser >= cap - 2;
  return false;                                    // winner never reached target
}

/**
 * Is this a legal way for a game to have been STOPPED?
 *
 * Club sessions run to a clock, so the exec can call time mid-game and the
 * score at that moment is the result (00047). Such a game never reached the
 * target and owes nothing to the two-point margin — 15-2 in a game to 21 is
 * exactly what a cut-short game looks like — so both of those rules are off.
 *
 * What survives is everything that stays true no matter when play stopped:
 *  - not a tie: someone has to have been ahead for there to be a winner
 *  - no negatives
 *  - neither side above the cap: past the cap the game would already have
 *    ended on its own, so the clock could not have been what stopped it
 *
 * The cap is whatever this format's rules say (getRulesFor -> pointsCap), so a
 * custom 15-point event gets 24, not the 21-point 30.
 */
export function isLegalTimeExceededScore(
  a: number,
  b: number,
  format: AnyMatchFormat,
  gamesPerMatch?: number | null,
  pointsPerGame?: number | null,
): boolean {
  const { cap } = getRulesFor(format, gamesPerMatch, pointsPerGame);
  // Integers only. The strict path is pinned to whole numbers by its equalities
  // against target and cap; this one compares nothing but bounds, so without
  // the check a client posting 15.5 would sail through.
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === b) return false;                       // no winner, no result
  return Math.min(a, b) >= 0 && Math.max(a, b) <= cap;
}

/**
 * How many games a best-of-N match should contain, given who won each.
 * A match stops the moment someone clinches, so a best-of-3 is 2 games (2-0) or
 * 3 (2-1) — never 3-0, because game three would never have been played.
 */
export function isLegalGameCount(
  winnerGames: number,
  loserGames: number,
  format: AnyMatchFormat,
  gamesPerMatch?: number | null,
): boolean {
  const { bestOf } = getRulesFor(format, gamesPerMatch);
  const needed = Math.floor(bestOf / 2) + 1;
  if (winnerGames !== needed) return false;        // winner must reach exactly the clinch
  return loserGames <= needed - 1;                 // and no games played after it
}
