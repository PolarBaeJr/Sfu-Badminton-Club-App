import type { MatchFormat, EventType } from '../types/database';
import { clampElo, DEFAULT_ELO, PROVISIONAL_THRESHOLD } from '../utils/constants';

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
}

export interface EloCalcResult {
  newRating: number;
  delta: number;
  expected: number;
}

export function calculateExpected(playerRating: number, opponentRating: number): number {
  return 1.0 / (1.0 + Math.pow(10, (opponentRating - playerRating) / ELO_SCALE));
}

export function calculateEloUpdate(input: EloCalcInput): EloCalcResult {
  const actual = input.won ? 1.0 : 0.0;
  const expected = calculateExpected(input.playerRating, input.opponentRating);
  const weight = input.eloWeightOverride ?? 1.0;
  const rawDelta = Math.round(
    input.kFactor * input.formatWeight * input.eventMultiplier * weight * (actual - expected)
  );

  // Clamp the resulting rating to [MIN_ELO, MAX_ELO], then derive the delta from
  // the clamped rating so newRating and delta stay consistent at the bounds.
  const newRating = clampElo(input.playerRating + rawDelta);
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

export function getKFactor(
  matchType: 'singles' | 'doubles',
  provisional: boolean,
  matchesPlayed?: number
): number {
  // Provisional threshold: fewer than PROVISIONAL_THRESHOLD matches = provisional
  // K-factor. Uses the shared constant so tuning it can't silently drift from
  // the rest of the app.
  const isProvisional = provisional || (matchesPlayed !== undefined && matchesPlayed < PROVISIONAL_THRESHOLD);
  // K-factors are doubled from the classic 40/24 (singles) and 32/18 (doubles)
  // to match the 2x-stretched ELO_SCALE — this keeps each delta the same
  // fraction of the scale, so convergence speed and volatility are unchanged.
  if (matchType === 'singles') {
    return isProvisional ? 80 : 48;
  }
  return isProvisional ? 64 : 36;
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
  matchesPlayed?: number
): { winDelta: number; lossDelta: number } {
  const k = getKFactor(matchType, provisional, matchesPlayed);
  const fw = getFormatWeight(format);
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
