import type { MatchFormat, EventType } from '../types/database';

export const FORMAT_WEIGHTS: Record<MatchFormat, number> = {
  bo3_21: 1.25,
  single_21: 1.0,
  single_15: 0.75,
  single_11: 0.5,
};

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
  return 1.0 / (1.0 + Math.pow(10, (opponentRating - playerRating) / 400));
}

export function calculateEloUpdate(input: EloCalcInput): EloCalcResult {
  const actual = input.won ? 1.0 : 0.0;
  const expected = calculateExpected(input.playerRating, input.opponentRating);
  const weight = input.eloWeightOverride ?? 1.0;
  const delta = Math.round(
    input.kFactor * input.formatWeight * input.eventMultiplier * weight * (actual - expected)
  );

  return {
    newRating: input.playerRating + delta,
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
  // Provisional threshold: < 8 matches = provisional K-factor
  const isProvisional = provisional || (matchesPlayed !== undefined && matchesPlayed < 8);
  if (matchType === 'singles') {
    return isProvisional ? 40 : 24;
  }
  return isProvisional ? 32 : 18;
}

export function calculateDelta(
  playerRating: number,
  opponentRating: number,
  kFactor: number,
  formatWeight: number,
  eventMultiplier: number,
  won: boolean
): number {
  const expected = calculateExpected(playerRating, opponentRating);
  const actual = won ? 1.0 : 0.0;
  return Math.round(kFactor * formatWeight * eventMultiplier * (actual - expected));
}

export function calculateTeamRating(ratings: number[]): number {
  return Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length);
}

export function previewEloChange(
  playerRating: number,
  opponentRating: number,
  format: MatchFormat,
  eventType: EventType,
  matchType: 'singles' | 'doubles',
  provisional: boolean,
  eloWeightOverride?: number
): { winDelta: number; lossDelta: number } {
  const k = getKFactor(matchType, provisional);
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
