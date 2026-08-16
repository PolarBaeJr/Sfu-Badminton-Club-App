import { describe, it, expect } from 'vitest';
import { getKFactor, calculateEloUpdate, calculateExpected } from '../engine';
import {
  clampElo,
  resolveEloBounds,
  skillTierElo,
  isSkillTier,
  DEFAULT_ELO,
  MIN_ELO,
  MAX_ELO,
} from '../../utils/constants';

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

// The 00127 switch. It must be OFF-able without touching any other knob, and —
// far more important — it must be impossible to turn off BY ACCIDENT: a missing
// key, a null, or a string has to read as "on", because every database that
// existed before 00127 has no such key and must keep today's behaviour.
describe('the provisional-K switch', () => {
  const s = {
    provisional_threshold: 8,
    singles_k_provisional: 64,
    singles_k_established: 36,
    doubles_k_provisional: 64,
    doubles_k_established: 36,
  };

  it('uses the established K for everyone when switched off', () => {
    const off = { ...s, provisional_k_enabled: false };
    // Both the stored flag and the under-threshold count are overridden.
    expect(getKFactor('singles', true, 0, off)).toBe(36);
    expect(getKFactor('singles', false, 1, off)).toBe(36);
    expect(getKFactor('doubles', true, 0, off)).toBe(36);
  });

  it('leaves provisional K applying when switched on', () => {
    const on = { ...s, provisional_k_enabled: true };
    expect(getKFactor('singles', true, 0, on)).toBe(64);
    expect(getKFactor('singles', false, 99, on)).toBe(36);
  });

  it('treats an absent key as ON, so a pre-00127 database is unchanged', () => {
    expect(getKFactor('singles', true, 0, s)).toBe(64);
  });

  it('treats a malformed value as ON rather than silently disabling the switch', () => {
    // Only an explicit `false` counts. Anything else degrades to today's
    // behaviour — the same convention num() follows for the numeric knobs, and
    // the reason the engine reads `!== false` rather than testing truthiness.
    expect(getKFactor('singles', true, 0, { ...s, provisional_k_enabled: null })).toBe(64);
    expect(getKFactor('singles', true, 0, { ...s, provisional_k_enabled: undefined })).toBe(64);
    expect(getKFactor('singles', true, 0, { ...s, provisional_k_enabled: 'no' as never })).toBe(64);
    // A STRING 'false' is not a boolean false. It reads as on — which is the
    // safe direction, and the reason the admin form stores a real boolean.
    expect(getKFactor('singles', true, 0, { ...s, provisional_k_enabled: 'false' as never })).toBe(64);
  });
});

// The skill tiers (00127). Every assertion here is about the screen and the
// seed agreeing: skillTierElo is what the onboarding page PRINTS, and
// apply_skill_tier_seed is what the database WRITES, so a disagreement means a
// member is told one number and given another.
describe('skillTierElo', () => {
  it('falls back to the shipped tier values when nothing is configured', () => {
    expect(skillTierElo('beginner', null)).toBe(400);
    expect(skillTierElo('intermediate', null)).toBe(800);
    expect(skillTierElo('advanced', null)).toBe(1200);
  });

  it('beginner is DEFAULT_ELO, so that tier is a no-op', () => {
    // The reason 00127 backfills nothing: every existing member already sits
    // exactly where a new Beginner lands.
    expect(skillTierElo('beginner', null)).toBe(DEFAULT_ELO);
  });

  it('is 400 apart, which is half of ELO_SCALE on this ladder', () => {
    const b = skillTierElo('beginner', null);
    const i = skillTierElo('intermediate', null);
    const a = skillTierElo('advanced', null);
    expect(i - b).toBe(400);
    expect(a - i).toBe(400);
    // One tier apart the favourite is expected to win ~76%, and
    // beginner-vs-advanced (a full ELO_SCALE of 800) ~91%. These are the odds
    // the tier separation is claiming; if ELO_SCALE ever moves, this is the
    // test that should fail rather than the claim quietly becoming false.
    expect(calculateExpected(i, b)).toBeCloseTo(0.76, 2);
    expect(calculateExpected(a, b)).toBeCloseTo(0.91, 2);
  });

  it('uses the configured values over the fallbacks', () => {
    const s = { tier_intermediate_elo: 900, tier_advanced_elo: 1400 };
    expect(skillTierElo('intermediate', s)).toBe(900);
    expect(skillTierElo('advanced', s)).toBe(1400);
  });

  it('ignores a zero, negative or non-numeric tier value', () => {
    // Mirrors num() in the engine, and the non-positive guard
    // apply_skill_tier_seed applies AROUND rating_setting_int (00127) — the
    // helper itself returns 0 for a configured 0, since 0 casts fine. A tier
    // that seeds rating 0 is a typo, not an intention, and if the two sides
    // ever disagree a member is shown one number and given another.
    expect(skillTierElo('advanced', { tier_advanced_elo: 0 })).toBe(1200);
    expect(skillTierElo('advanced', { tier_advanced_elo: -50 })).toBe(1200);
    expect(skillTierElo('advanced', { tier_advanced_elo: 'high' })).toBe(1200);
    expect(skillTierElo('advanced', { tier_advanced_elo: null })).toBe(1200);
  });

  it('clamps to the configured ladder, like every other rating write', () => {
    // An admin who sets a tier above the ceiling gets the ceiling — the number
    // the seed would actually write, so the screen cannot promise a rating
    // outside the ladder.
    expect(skillTierElo('advanced', { tier_advanced_elo: 5000 }, { min: 100, max: 3001 })).toBe(3001);
    expect(skillTierElo('beginner', { tier_beginner_elo: 10 }, { min: 100, max: 3001 })).toBe(100);
  });
});

describe('isSkillTier', () => {
  it('accepts exactly the three tiers and nothing else', () => {
    expect(isSkillTier('beginner')).toBe(true);
    expect(isSkillTier('intermediate')).toBe(true);
    expect(isSkillTier('advanced')).toBe(true);
    // The guard the server action uses before sending a tier to the SECURITY
    // DEFINER seed. Anything it lets through reaches the database.
    expect(isSkillTier('expert')).toBe(false);
    expect(isSkillTier('')).toBe(false);
    expect(isSkillTier(null)).toBe(false);
    expect(isSkillTier(undefined)).toBe(false);
    expect(isSkillTier(1200)).toBe(false);
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
