import { describe, it, expect } from 'vitest';
import {
  calculateExpected,
  calculateEloUpdate,
  calculateDelta,
  calculateTeamRating,
  getFormatWeight,
  getEventMultiplier,
  getKFactor,
  previewEloChange,
  FORMAT_WEIGHTS,
  EVENT_MULTIPLIERS,
} from '../engine';

describe('calculateExpected', () => {
  it('returns 0.5 for equal ratings', () => {
    expect(calculateExpected(1200, 1200)).toBeCloseTo(0.5);
  });

  it('returns higher expectation for higher-rated player', () => {
    const expected = calculateExpected(1400, 1200);
    expect(expected).toBeGreaterThan(0.5);
    expect(expected).toBeLessThan(1.0);
  });

  it('returns lower expectation for lower-rated player', () => {
    const expected = calculateExpected(1200, 1400);
    expect(expected).toBeGreaterThan(0.0);
    expect(expected).toBeLessThan(0.5);
  });

  it('produces complementary expectations for both players', () => {
    const e1 = calculateExpected(1200, 1400);
    const e2 = calculateExpected(1400, 1200);
    expect(e1 + e2).toBeCloseTo(1.0);
  });

  it('returns ~0.76 for a 200-point advantage', () => {
    const expected = calculateExpected(1400, 1200);
    expect(expected).toBeCloseTo(0.7597, 3);
  });

  it('returns ~0.91 for a 400-point advantage', () => {
    const expected = calculateExpected(1600, 1200);
    expect(expected).toBeCloseTo(0.9091, 3);
  });
});

describe('calculateEloUpdate', () => {
  it('increases rating on win', () => {
    const result = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    expect(result.delta).toBeGreaterThan(0);
    expect(result.newRating).toBe(1200 + result.delta);
  });

  it('decreases rating on loss', () => {
    const result = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: false,
    });
    expect(result.delta).toBeLessThan(0);
    expect(result.newRating).toBe(1200 + result.delta);
  });

  it('gives equal and opposite deltas for equal-rated players', () => {
    const win = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    const loss = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: false,
    });
    expect(win.delta + loss.delta).toBe(0);
  });

  it('awards fewer points for beating a weaker opponent', () => {
    const beatWeaker = calculateEloUpdate({
      playerRating: 1400,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    const beatEqual = calculateEloUpdate({
      playerRating: 1400,
      opponentRating: 1400,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    expect(beatWeaker.delta).toBeLessThan(beatEqual.delta);
  });

  it('penalizes more for losing to a weaker opponent', () => {
    const loseToWeaker = calculateEloUpdate({
      playerRating: 1400,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: false,
    });
    const loseToEqual = calculateEloUpdate({
      playerRating: 1400,
      opponentRating: 1400,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: false,
    });
    expect(Math.abs(loseToWeaker.delta)).toBeGreaterThan(Math.abs(loseToEqual.delta));
  });

  it('scales delta by format weight', () => {
    const standard = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    const bo3 = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.25,
      eventMultiplier: 1.0,
      won: true,
    });
    expect(bo3.delta).toBeGreaterThan(standard.delta);
  });

  it('scales delta by event multiplier', () => {
    const rated = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    const tournament = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.15,
      won: true,
    });
    expect(tournament.delta).toBeGreaterThan(rated.delta);
  });

  it('applies eloWeightOverride when provided', () => {
    const normal = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    const halfWeight = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
      eloWeightOverride: 0.5,
    });
    expect(halfWeight.delta).toBeLessThan(normal.delta);
  });

  it('returns expected probability in result', () => {
    const result = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    expect(result.expected).toBeCloseTo(0.5);
  });

  it('produces zero delta for casual events (multiplier=0)', () => {
    const result = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1400,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 0.0,
      won: true,
    });
    expect(result.delta).toBe(0);
    expect(result.newRating).toBe(1200);
  });
});

describe('calculateDelta', () => {
  it('matches calculateEloUpdate delta for the same inputs', () => {
    const delta = calculateDelta(1200, 1400, 24, 1.0, 1.0, true);
    const update = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1400,
      kFactor: 24,
      formatWeight: 1.0,
      eventMultiplier: 1.0,
      won: true,
    });
    expect(delta).toBe(update.delta);
  });

  it('returns a positive value on win', () => {
    expect(calculateDelta(1200, 1200, 24, 1.0, 1.0, true)).toBeGreaterThan(0);
  });

  it('returns a negative value on loss', () => {
    expect(calculateDelta(1200, 1200, 24, 1.0, 1.0, false)).toBeLessThan(0);
  });
});

describe('calculateTeamRating', () => {
  it('returns the average of two ratings', () => {
    expect(calculateTeamRating([1200, 1400])).toBe(1300);
  });

  it('rounds to nearest integer', () => {
    expect(calculateTeamRating([1200, 1401])).toBe(1301);
  });

  it('handles a single rating', () => {
    expect(calculateTeamRating([1500])).toBe(1500);
  });

  it('handles three ratings', () => {
    expect(calculateTeamRating([1200, 1300, 1500])).toBe(1333);
  });
});

describe('getFormatWeight', () => {
  it('returns 1.25 for bo3_21', () => {
    expect(getFormatWeight('bo3_21')).toBe(1.25);
  });

  it('returns 1.0 for single_21', () => {
    expect(getFormatWeight('single_21')).toBe(1.0);
  });

  it('returns 0.75 for single_15', () => {
    expect(getFormatWeight('single_15')).toBe(0.75);
  });

  it('returns 0.5 for single_11', () => {
    expect(getFormatWeight('single_11')).toBe(0.5);
  });

  it('matches FORMAT_WEIGHTS constant', () => {
    expect(getFormatWeight('bo3_21')).toBe(FORMAT_WEIGHTS.bo3_21);
    expect(getFormatWeight('single_21')).toBe(FORMAT_WEIGHTS.single_21);
    expect(getFormatWeight('single_15')).toBe(FORMAT_WEIGHTS.single_15);
    expect(getFormatWeight('single_11')).toBe(FORMAT_WEIGHTS.single_11);
  });
});

describe('getEventMultiplier', () => {
  it('returns 1.0 for rated_challenge', () => {
    expect(getEventMultiplier('rated_challenge')).toBe(1.0);
  });

  it('returns 0.0 for casual', () => {
    expect(getEventMultiplier('casual')).toBe(0.0);
  });

  it('returns 1.15 for tournament', () => {
    expect(getEventMultiplier('tournament')).toBe(1.15);
  });

  it('returns 1.15 for trial', () => {
    expect(getEventMultiplier('trial')).toBe(1.15);
  });

  it('returns 1.0 for admin_entered', () => {
    expect(getEventMultiplier('admin_entered')).toBe(1.0);
  });

  it('matches EVENT_MULTIPLIERS constant', () => {
    expect(getEventMultiplier('casual')).toBe(EVENT_MULTIPLIERS.casual);
    expect(getEventMultiplier('tournament')).toBe(EVENT_MULTIPLIERS.tournament);
  });
});

describe('getKFactor', () => {
  it('returns 40 for provisional singles', () => {
    expect(getKFactor('singles', true)).toBe(40);
  });

  it('returns 24 for established singles', () => {
    expect(getKFactor('singles', false)).toBe(24);
  });

  it('returns 32 for provisional doubles', () => {
    expect(getKFactor('doubles', true)).toBe(32);
  });

  it('returns 18 for established doubles', () => {
    expect(getKFactor('doubles', false)).toBe(18);
  });

  it('treats fewer than 8 matches as provisional regardless of flag', () => {
    expect(getKFactor('singles', false, 5)).toBe(40);
    expect(getKFactor('doubles', false, 7)).toBe(32);
  });

  it('treats 8+ matches as established when provisional flag is false', () => {
    expect(getKFactor('singles', false, 8)).toBe(24);
    expect(getKFactor('doubles', false, 10)).toBe(18);
  });

  it('treats player as provisional if flag is true even with many matches', () => {
    expect(getKFactor('singles', true, 100)).toBe(40);
    expect(getKFactor('doubles', true, 50)).toBe(32);
  });
});

describe('previewEloChange', () => {
  it('returns positive winDelta and negative lossDelta', () => {
    const preview = previewEloChange(1200, 1200, 'single_21', 'rated_challenge', 'singles', false);
    expect(preview.winDelta).toBeGreaterThan(0);
    expect(preview.lossDelta).toBeLessThan(0);
  });

  it('produces symmetric deltas for equal-rated players', () => {
    const preview = previewEloChange(1200, 1200, 'single_21', 'rated_challenge', 'singles', false);
    expect(preview.winDelta + preview.lossDelta).toBe(0);
  });

  it('produces larger deltas for provisional players', () => {
    const established = previewEloChange(1200, 1200, 'single_21', 'rated_challenge', 'singles', false);
    const provisional = previewEloChange(1200, 1200, 'single_21', 'rated_challenge', 'singles', true);
    expect(provisional.winDelta).toBeGreaterThan(established.winDelta);
  });

  it('produces larger deltas for bo3 format', () => {
    const single = previewEloChange(1200, 1200, 'single_21', 'rated_challenge', 'singles', false);
    const bo3 = previewEloChange(1200, 1200, 'bo3_21', 'rated_challenge', 'singles', false);
    expect(bo3.winDelta).toBeGreaterThan(single.winDelta);
  });

  it('produces zero deltas for casual events', () => {
    const preview = previewEloChange(1200, 1400, 'single_21', 'casual', 'singles', false);
    // Use === to treat -0 and +0 as equal (Object.is, used by toBe, distinguishes them).
    expect(preview.winDelta === 0).toBe(true);
    expect(preview.lossDelta === 0).toBe(true);
  });

  it('applies eloWeightOverride', () => {
    const normal = previewEloChange(1200, 1200, 'single_21', 'rated_challenge', 'singles', false);
    const half = previewEloChange(1200, 1200, 'single_21', 'rated_challenge', 'singles', false, 0.5);
    expect(Math.abs(half.winDelta)).toBeLessThan(Math.abs(normal.winDelta));
  });

  it('produces smaller win delta for an upset (beating stronger opponent expected)', () => {
    const preview = previewEloChange(1200, 1600, 'single_21', 'rated_challenge', 'singles', false);
    expect(preview.winDelta).toBeGreaterThan(0);
    expect(preview.winDelta).toBeGreaterThan(12);
  });
});
