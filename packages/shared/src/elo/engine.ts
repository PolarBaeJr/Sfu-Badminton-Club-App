import type { MatchFormat, EventType } from '../types/database';
import { clampElo, DEFAULT_ELO, PROVISIONAL_THRESHOLD, SWEEP_MARGIN_MULTIPLIER, derivedFormatWeight, type EloBounds } from '../utils/constants';

export const FORMAT_WEIGHTS: Record<MatchFormat, number> = {
  bo3_21: 1.25,
  single_21: 1.0,
  single_15: 0.75,
  single_11: 0.5,
};

// Logistic divisor for the win-probability curve. The classic ELO value is 400;
// this ladder uses 800 to stretch the rating spread 2x (nominal 400, top ~1300).
// A rating gap of ELO_SCALE means the higher player wins ~91% of the time.
export const ELO_SCALE = 800;

export const EVENT_MULTIPLIERS: Record<EventType, number> = {
  rated_challenge: 1.0,
  trial: 1.15,
  tournament: 1.15,
  admin_entered: 1.0,
  casual: 0.0,
};

export interface EloCalcInput {
  playerRating: number;
  opponentRating: number;
  kFactor: number;
  formatWeight: number;
  eventMultiplier: number;
  won: boolean;
  eloWeightOverride?: number;
  /** Margin-of-victory scaling — see getMarginMultiplier(). Defaults to 1.0. */
  marginMultiplier?: number;
  /** Configured rating range; falls back to [MIN_ELO, MAX_ELO] when absent. */
  bounds?: EloBounds | null;
}

export interface EloCalcResult {
  newRating: number;
  delta: number;
  expected: number;
}

export function calculateExpected(playerRating: number, opponentRating: number): number {
  return 1.0 / (1.0 + Math.pow(10, (opponentRating - playerRating) / ELO_SCALE));
}

// Margin-of-victory scaling, deliberately coarse: a clean sweep counts slightly
// more than a match that went the distance, and nothing else does.
//
// Scaling by GAMES rather than points is a safety decision, not a modelling one.
// Scores here are self-reported and confirmed by the opponent, so any factor
// that rewards a bigger margin also rewards inflating one — points-based
// scaling would make forged scorelines directly profitable and give players a
// reason to run the score up on a weaker clubmate. Sweep-vs-not is a single bit
// of information: nearly worthless to manipulate, but still enough to separate
// "beat them twice cleanly" from "scraped through in three".
//
// Single-game formats have no margin to speak of and are always 1.0.
// `sweepMultiplier` comes from platform_settings.rating_defaults
// (sweep_margin_multiplier) so admins can tune it; the constant is only the
// fallback. Bounded to [1, 2] to match get_margin_multiplier() in SQL — a
// malformed setting must not scale every rating change arbitrarily.
export function getMarginMultiplier(
  gamesWon: number,
  gamesLost: number,
  sweepMultiplier: number = SWEEP_MARGIN_MULTIPLIER,
): number {
  const total = gamesWon + gamesLost;
  if (total < 2) return 1.0;                      // single-game format
  if (gamesWon > 0 && gamesLost > 0) return 1.0;  // went the distance
  const m = Number.isFinite(sweepMultiplier) ? sweepMultiplier : SWEEP_MARGIN_MULTIPLIER;
  return Math.min(2.0, Math.max(1.0, m));         // clean sweep, either side
}

// JS Math.round breaks ties toward +Infinity (-34.5 -> -34) while Postgres
// ROUND() breaks them away from zero (-34.5 -> -35). Both engines rate real
// matches — SQL for challenges, this one for tournaments — so a disagreement
// means the same scoreline moves ratings differently depending on where it was
// played, and a winner/loser pair can differ by a point (leaking rating into
// the ladder). Match Postgres.
function roundHalfAwayFromZero(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

export function calculateEloUpdate(input: EloCalcInput): EloCalcResult {
  const actual = input.won ? 1.0 : 0.0;
  const expected = calculateExpected(input.playerRating, input.opponentRating);
  const weight = input.eloWeightOverride ?? 1.0;
  const margin = input.marginMultiplier ?? 1.0;
  const rawDelta = roundHalfAwayFromZero(
    input.kFactor * input.formatWeight * input.eventMultiplier * weight * margin * (actual - expected)
  );

  // Clamp the resulting rating to [MIN_ELO, MAX_ELO], then derive the delta from
  // the clamped rating so newRating and delta stay consistent at the bounds.
  const newRating = clampElo(input.playerRating + rawDelta, input.bounds);
  const delta = newRating - input.playerRating;

  return {
    newRating,
    delta,
    expected,
  };
}

export function getFormatWeight(format: MatchFormat): number {
  return FORMAT_WEIGHTS[format];
}

export function getEventMultiplier(eventType: EventType): number {
  return EVENT_MULTIPLIERS[eventType];
}

/**
 * Configured K-factors and provisional threshold, from
 * platform_settings.rating_defaults. Every field is optional; anything missing
 * or non-numeric falls back to the hardcoded default, so a malformed settings
 * row degrades to today's behaviour rather than zeroing out rating movement.
 */
export interface RatingSettings {
  provisional_threshold?: number | null;
  singles_k_provisional?: number | null;
  singles_k_established?: number | null;
  doubles_k_provisional?: number | null;
  doubles_k_established?: number | null;
  min_elo?: number | null;
  max_elo?: number | null;
  // Sweep bonus, read by getMarginMultiplier(). Present here because the SQL
  // side reads it out of the SAME platform_settings row
  // (get_margin_multiplier() selects value->>'sweep_margin_multiplier'), and a
  // caller that fetches rating_defaults for the K-factors has already paid for
  // it — leaving it off the type is how the TS engine ended up defaulting the
  // multiplier to 1.0 while SQL applied 1.15 to the identical scoreline.
  sweep_margin_multiplier?: number | null;
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  // A K of 0 would freeze every rating, so it is treated as unset rather than
  // honoured — same reasoning as the SQL side's bounds check.
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getKFactor(
  matchType: 'singles' | 'doubles',
  provisional: boolean,
  matchesPlayed?: number,
  settings?: RatingSettings | null,
): number {
  // Provisional threshold: fewer than PROVISIONAL_THRESHOLD matches = provisional
  // K-factor. Uses the shared constant so tuning it can't silently drift from
  // the rest of the app.
  const threshold = num(settings?.provisional_threshold, PROVISIONAL_THRESHOLD);
  const isProvisional = provisional || (matchesPlayed !== undefined && matchesPlayed < threshold);
  // Defaults are doubled from the classic 40/24 (singles) and 32/18 (doubles)
  // to match the 2x-stretched ELO_SCALE — this keeps each delta the same
  // fraction of the scale, so convergence speed and volatility are unchanged.
  // They are now only defaults; the live values come from settings.
  if (matchType === 'singles') {
    return isProvisional
      ? num(settings?.singles_k_provisional, 80)
      : num(settings?.singles_k_established, 48);
  }
  return isProvisional
    ? num(settings?.doubles_k_provisional, 64)
    : num(settings?.doubles_k_established, 36);
}

export function calculateTeamRating(ratings: number[]): number {
  // Guard against an empty team — dividing by 0 yields NaN, which would poison
  // any downstream rating write.
  if (ratings.length === 0) return DEFAULT_ELO;
  return Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length);
}

export function previewEloChange(
  playerRating: number,
  opponentRating: number,
  format: MatchFormat,
  eventType: EventType,
  matchType: 'singles' | 'doubles',
  provisional: boolean,
  eloWeightOverride?: number,
  matchesPlayed?: number,
  // Custom shape ("best of X to Y"): when present the weight is derived rather
  // than looked up. Without this the preview passed a format the table has no
  // entry for, so the weight came back undefined and every figure rendered NaN.
  custom?: { gamesPerMatch: number; pointsPerGame: number },
): { winDelta: number; lossDelta: number } {
  const k = getKFactor(matchType, provisional, matchesPlayed);
  const fw = custom
    ? derivedFormatWeight(custom.gamesPerMatch, custom.pointsPerGame)
    : (getFormatWeight(format) ?? FORMAT_WEIGHTS.single_21);
  const em = getEventMultiplier(eventType);

  const winResult = calculateEloUpdate({
    playerRating,
    opponentRating,
    kFactor: k,
    formatWeight: fw,
    eventMultiplier: em,
    won: true,
    eloWeightOverride,
  });

  const lossResult = calculateEloUpdate({
    playerRating,
    opponentRating,
    kFactor: k,
    formatWeight: fw,
    eventMultiplier: em,
    won: false,
    eloWeightOverride,
  });

  return { winDelta: winResult.delta, lossDelta: lossResult.delta };
}
