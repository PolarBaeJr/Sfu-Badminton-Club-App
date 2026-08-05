import { describe, it, expect } from 'vitest';
import { getKFactor, calculateEloUpdate } from '../engine';
import { clampElo, resolveEloBounds, MIN_ELO, MAX_ELO } from '../../utils/constants';

// These knobs are edited in the admin Settings screen. Six of the seven were
// wired to nothing before migration 00041 — the form saved them and the engine
// went on using hardcoded numbers. The risk in fixing that is the opposite
// failure: a malformed settings row silently freezing or wrecking every rating.
// Everything here checks the degrade-to-default path.

describe('getKFactor with settings', () => {
  it('uses configured K-factors', () => {
    const s = { singles_k_provisional: 20, singles_k_established: 10 };
    expect(getKFactor('singles', true, 0, s)).toBe(20);
    expect(getKFactor('singles', false, 99, s)).toBe(10);
  });

  it('falls back to the hardcoded defaults when unset', () => {
    expect(getKFactor('singles', true, 0)).toBe(80);
    expect(getKFactor('singles', false, 99)).toBe(48);
    expect(getKFactor('doubles', true, 0)).toBe(64);
    expect(getKFactor('doubles', false, 99)).toBe(36);
  });

  it('ignores a zero or negative K rather than freezing every rating', () => {
    // A K of 0 makes every delta 0 — the ladder stops responding to results
    // entirely, and nothing in the UI would say why.
    expect(getKFactor('singles', true, 0, { singles_k_provisional: 0 })).toBe(80);
    expect(getKFactor('singles', true, 0, { singles_k_provisional: -5 })).toBe(80);
  });

  it('ignores non-numeric settings', () => {
    expect(getKFactor('singles', true, 0, { singles_k_provisional: 'abc' as never })).toBe(80);
    expect(getKFactor('singles', true, 0, { singles_k_provisional: null })).toBe(80);
  });

  it('respects a configured provisional threshold', () => {
    const s = { provisional_threshold: 2, singles_k_provisional: 99, singles_k_established: 11 };
    expect(getKFactor('singles', false, 1, s)).toBe(99); // still provisional
    expect(getKFactor('singles', false, 2, s)).toBe(11); // established at the threshold
  });
});

describe('rating bounds', () => {
  it('uses configured bounds', () => {
    expect(clampElo(5000, { min: 100, max: 3000 })).toBe(3000);
    expect(clampElo(50, { min: 100, max: 3000 })).toBe(100);
  });

  it('falls back when bounds are absent, non-numeric, or inverted', () => {
    // max <= min collapses every rating to one value. A settings typo must not
    // be able to do that.
    expect(resolveEloBounds({ min: 900, max: 50 })).toEqual({ min: MIN_ELO, max: MAX_ELO });
    expect(resolveEloBounds({ min: null, max: 3000 })).toEqual({ min: MIN_ELO, max: MAX_ELO });
    expect(resolveEloBounds(null)).toEqual({ min: MIN_ELO, max: MAX_ELO });
  });
});

describe('the cap is lossy, and the tests should say so', () => {
  it('gives the winner a reduced delta at the ceiling while the loser drops in full', () => {
    // This is why the ceiling matters: rating leaves the ladder and none is
    // created. Raising max_elo is now a settings change, not a migration.
    const win = calculateEloUpdate({
      playerRating: 1480, opponentRating: 1480, kFactor: 80,
      formatWeight: 1.25, eventMultiplier: 1.0, won: true,
      bounds: { min: 100, max: 1500 },
    });
    const loss = calculateEloUpdate({
      playerRating: 1480, opponentRating: 1480, kFactor: 80,
      formatWeight: 1.25, eventMultiplier: 1.0, won: false,
      bounds: { min: 100, max: 1500 },
    });
    expect(win.delta).toBe(20);   // clamped from +50
    expect(loss.delta).toBe(-50); // full drop
    expect(win.delta + loss.delta).toBeLessThan(0); // net rating destroyed
  });

  it('gives the full delta once the ceiling is raised', () => {
    const win = calculateEloUpdate({
      playerRating: 1480, opponentRating: 1480, kFactor: 80,
      formatWeight: 1.25, eventMultiplier: 1.0, won: true,
      bounds: { min: 100, max: 3000 },
    });
    expect(win.delta).toBe(50);
  });
});
