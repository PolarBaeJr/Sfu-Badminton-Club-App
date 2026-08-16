import { describe, it, expect } from 'vitest';
import {
  calculateExpected,
  calculateEloUpdate,
  calculateTeamRating,
  getFormatWeight,
  getEventMultiplier,
  getKFactor,
  previewEloChange,
  resolvedFormatWeight,
  eventEloMultiplier,
  eloWeightBreakdown,
  FORMAT_WEIGHTS,
  EVENT_MULTIPLIERS,
} from '../engine';
import type { RatingSettings } from '../engine';
import { knockoutLadderShape, POOL_LADDER_SHAPE } from '../../utils/tournament-phases';

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

  // ELO_SCALE is 800 (2x-stretched scale), so a 200-point gap is half the win
  // probability spread the classic 400 divisor gave.
  it('returns ~0.64 for a 200-point advantage', () => {
    const expected = calculateExpected(1400, 1200);
    expect(expected).toBeCloseTo(0.6401, 3);
  });

  it('returns ~0.76 for a 400-point advantage', () => {
    const expected = calculateExpected(1600, 1200);
    expect(expected).toBeCloseTo(0.7597, 3);
  });

  it('returns ~0.91 for an 800-point advantage', () => {
    const expected = calculateExpected(2000, 1200);
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
  // K-factors are doubled from the classic 40/24/32/18 to match ELO_SCALE=800.
  it('returns 80 for provisional singles', () => {
    expect(getKFactor('singles', true)).toBe(80);
  });

  it('returns 48 for established singles', () => {
    expect(getKFactor('singles', false)).toBe(48);
  });

  it('returns 64 for provisional doubles', () => {
    expect(getKFactor('doubles', true)).toBe(64);
  });

  it('returns 36 for established doubles', () => {
    expect(getKFactor('doubles', false)).toBe(36);
  });

  it('treats fewer than 8 matches as provisional regardless of flag', () => {
    expect(getKFactor('singles', false, 5)).toBe(80);
    expect(getKFactor('doubles', false, 7)).toBe(64);
  });

  it('treats 8+ matches as established when provisional flag is false', () => {
    expect(getKFactor('singles', false, 8)).toBe(48);
    expect(getKFactor('doubles', false, 10)).toBe(36);
  });

  it('treats player as provisional if flag is true even with many matches', () => {
    expect(getKFactor('singles', true, 100)).toBe(80);
    expect(getKFactor('doubles', true, 50)).toBe(64);
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

// ============================================================
// The preview is a PROMISE, and it has to be the ladder's own number
// ============================================================
//
// previewEloChange called getKFactor with no settings, so every figure a member
// saw before accepting a challenge came from the hardcoded fallbacks (80/48
// singles) while apply_match_result rated the match from
// platform_settings.rating_defaults (64/36 on production). The tests below
// assert EQUIVALENCE with what the engine would actually apply rather than any
// literal delta: a test asserting "80" would have passed against the bug and
// would fail the moment the club retunes a knob, which is exactly backwards.
describe('previewEloChange honours the configured rating settings', () => {
  // The live production row, shape and all. Values are only ever used to build
  // the expectation THROUGH the engine, never asserted against directly.
  const LIVE: RatingSettings = {
    max_elo: 3001,
    min_elo: 100,
    singles_k_provisional: 64,
    singles_k_established: 36,
    doubles_k_provisional: 64,
    doubles_k_established: 36,
    provisional_threshold: 8,
    sweep_margin_multiplier: 1.15,
  };

  /** What the rating path would write for this side, built from the same parts. */
  function applied(opts: {
    playerRating: number;
    opponentRating: number;
    matchType: 'singles' | 'doubles';
    provisional: boolean;
    matchesPlayed?: number;
    settings?: RatingSettings | null;
    format?: keyof typeof FORMAT_WEIGHTS;
    won: boolean;
  }) {
    return calculateEloUpdate({
      playerRating: opts.playerRating,
      opponentRating: opts.opponentRating,
      kFactor: getKFactor(opts.matchType, opts.provisional, opts.matchesPlayed, opts.settings),
      formatWeight: FORMAT_WEIGHTS[opts.format ?? 'single_21'],
      eventMultiplier: EVENT_MULTIPLIERS.rated_challenge,
      won: opts.won,
      bounds: opts.settings ? { min: opts.settings.min_elo, max: opts.settings.max_elo } : undefined,
    }).delta;
  }

  it('agrees with calculateEloUpdate for an established player', () => {
    const preview = previewEloChange(
      1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30, undefined, LIVE,
    );
    const base = { playerRating: 1200, opponentRating: 1150, matchType: 'singles' as const, provisional: false, matchesPlayed: 30, settings: LIVE };
    expect(preview.winDelta).toBe(applied({ ...base, won: true }));
    expect(preview.lossDelta).toBe(applied({ ...base, won: false }));
  });

  it('agrees with calculateEloUpdate for a provisional player', () => {
    const preview = previewEloChange(
      1200, 1150, 'bo3_21', 'rated_challenge', 'doubles', true, undefined, 2, undefined, LIVE,
    );
    const base = { playerRating: 1200, opponentRating: 1150, matchType: 'doubles' as const, provisional: true, matchesPlayed: 2, settings: LIVE, format: 'bo3_21' as const };
    expect(preview.winDelta).toBe(applied({ ...base, won: true }));
    expect(preview.lossDelta).toBe(applied({ ...base, won: false }));
  });

  // THE BUG, stated as the difference it made rather than as a number. On the
  // live row the established K is 36 against a fallback of 48, so a preview that
  // ignored settings overstated every established member's swing by a third.
  it('differs from the unconfigured preview whenever the club has retuned K', () => {
    const withSettings = previewEloChange(
      1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30, undefined, LIVE,
    );
    const withoutSettings = previewEloChange(
      1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30,
    );
    expect(withSettings.winDelta).not.toBe(withoutSettings.winDelta);
    // ...and the settings-aware one is the one getKFactor agrees with.
    expect(withSettings.winDelta).toBe(
      applied({ playerRating: 1200, opponentRating: 1150, matchType: 'singles', provisional: false, matchesPlayed: 30, settings: LIVE, won: true }),
    );
  });

  // 00127's off switch. Mirrors `v_provisional_k AND (...)` in
  // apply_match_result: with it off, a player who is provisional by BOTH tests
  // still takes the established K.
  it('honours provisional_k_enabled: false', () => {
    const off: RatingSettings = { ...LIVE, provisional_k_enabled: false };
    const preview = previewEloChange(
      1200, 1150, 'single_21', 'rated_challenge', 'singles', true, undefined, 0, undefined, off,
    );
    const established = previewEloChange(
      1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30, undefined, off,
    );
    expect(preview.winDelta).toBe(established.winDelta);
  });

  it('still applies provisional K when the switch is absent or true', () => {
    const on: RatingSettings = { ...LIVE, provisional_k_enabled: true };
    for (const settings of [LIVE, on]) {
      const provisional = previewEloChange(
        1200, 1150, 'single_21', 'rated_challenge', 'singles', true, undefined, 0, undefined, settings,
      );
      const established = previewEloChange(
        1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30, undefined, settings,
      );
      expect(provisional.winDelta).toBeGreaterThan(established.winDelta);
    }
  });

  // The threshold is a setting too, so a club that raised it must see the
  // placement K for longer. 30 matches is established at a threshold of 8 and
  // provisional at one of 50.
  it('reads provisional_threshold from settings', () => {
    const raised: RatingSettings = { ...LIVE, provisional_threshold: 50 };
    const atLive = previewEloChange(1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30, undefined, LIVE);
    const atRaised = previewEloChange(1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30, undefined, raised);
    expect(atRaised.winDelta).toBeGreaterThan(atLive.winDelta);
  });

  // The bounds come from the same row, and calculateEloUpdate derives the delta
  // FROM the clamped rating — so a preview that fell back to the MAX_ELO
  // constant would tell a 1495-rated member on a club with a ceiling of 3001
  // that they had almost nothing left to gain.
  it('clamps against the configured ceiling, not the constant', () => {
    const near = previewEloChange(1495, 1100, 'bo3_21', 'rated_challenge', 'singles', true, undefined, 0, undefined, LIVE);
    const clampedToConstant = previewEloChange(1495, 1100, 'bo3_21', 'rated_challenge', 'singles', true, undefined, 0);
    expect(near.winDelta).toBeGreaterThan(clampedToConstant.winDelta);
    expect(1495 + near.winDelta).toBeGreaterThan(1500);
  });

  // A settings read that failed hands down null, and the screen must still draw
  // a figure rather than NaN — the same degradation getKFactor already promises
  // field by field.
  it('falls back to the shipped defaults for null or undefined settings', () => {
    const withNull = previewEloChange(1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30, undefined, null);
    const withNothing = previewEloChange(1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30);
    expect(withNull).toEqual(withNothing);
    expect(Number.isFinite(withNull.winDelta)).toBe(true);
  });

  // A malformed row must not zero out or invert the preview: num() treats any
  // non-positive or non-numeric K as unset, and resolveEloBounds ignores an
  // inverted pair.
  it('degrades to the defaults on a malformed settings row', () => {
    const junk = {
      singles_k_established: 0,
      singles_k_provisional: 'sixty' as unknown as number,
      min_elo: 2000,
      max_elo: 100,
      provisional_threshold: null,
    } as RatingSettings;
    const preview = previewEloChange(1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30, undefined, junk);
    const defaults = previewEloChange(1200, 1150, 'single_21', 'rated_challenge', 'singles', false, undefined, 30);
    expect(preview).toEqual(defaults);
  });
});

// ============================================================
// What the console PRINTS is what the ladder APPLIES
// ============================================================
//
// resolvedFormatWeight is the whole of rateTournamentMatch's weight decision,
// lifted here so the bracket tab and Event Settings can show the number without
// keeping a second copy of the branch. The branch matters: the enum table and
// the derived formula DISAGREE on half the shapes, so a display that assumed
// either one would be wrong for every round on the other.
describe('resolvedFormatWeight', () => {
  it('weighs an inheriting round from the enum table', () => {
    expect(resolvedFormatWeight({ match_format: 'best_of_3_to_21' })).toBe(FORMAT_WEIGHTS.bo3_21);
    expect(resolvedFormatWeight({ match_format: 'one_game_21' })).toBe(FORMAT_WEIGHTS.single_21);
    expect(resolvedFormatWeight({ match_format: 'one_game_15' })).toBe(FORMAT_WEIGHTS.single_15);
    expect(resolvedFormatWeight({ match_format: 'one_game_11' })).toBe(FORMAT_WEIGHTS.single_11);
  });

  it('weighs a typed round from the formula, which is NOT the table', () => {
    // (target / 21) x 1.25 for a best-of, clamped to [0.25, 1.5].
    expect(resolvedFormatWeight({ match_format: 'best_of_3_to_21', games_per_match: 3, points_per_game: 21 }))
      .toBeCloseTo(1.25, 4);
    expect(resolvedFormatWeight({ match_format: 'best_of_3_to_21', games_per_match: 1, points_per_game: 21 }))
      .toBeCloseTo(1.0, 4);
    expect(resolvedFormatWeight({ match_format: 'best_of_3_to_21', games_per_match: 1, points_per_game: 15 }))
      .toBeCloseTo(15 / 21, 4);
    expect(resolvedFormatWeight({ match_format: 'best_of_3_to_21', games_per_match: 1, points_per_game: 11 }))
      .toBeCloseTo(11 / 21, 4);
  });

  // The number the owner asked about. A game to 11 is NOT the 0.25 clamp floor
  // — that floor is unreachable above a five-point target — so it is worth
  // pinning the two apart.
  it('puts a game to 11 near a half, nowhere near the 0.25 floor', () => {
    const eleven = resolvedFormatWeight({ match_format: 'best_of_3_to_21', games_per_match: 1, points_per_game: 11 });
    expect(eleven).toBeGreaterThan(0.5);
    expect(eleven).toBeLessThan(0.53);
  });

  it('falls back to the formula for a format the table has no row for', () => {
    expect(resolvedFormatWeight({ match_format: 'not_a_real_format' })).toBeCloseTo(1.0, 4);
  });

  it('rates the whole default ladder in ascending order', () => {
    const shape = (r: { games_per_match: number; points_per_game: number }) =>
      resolvedFormatWeight({ match_format: 'best_of_3_to_21', ...r });
    const rungs = [
      shape(POOL_LADDER_SHAPE),
      shape(knockoutLadderShape(2)),
      shape(knockoutLadderShape(1)),
      shape(knockoutLadderShape(0)),
    ];
    expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
    expect(shape(knockoutLadderShape(3))).toBe(shape(POOL_LADDER_SHAPE));
  });
});

describe('eventEloMultiplier', () => {
  // DECIMAL(4,2) arrives as a string over PostgREST.
  it('reads the string PostgREST hands back', () => {
    expect(eventEloMultiplier('1.25')).toBe(1.25);
    expect(eventEloMultiplier('0.80')).toBe(0.8);
  });

  it('reproduces the rating path’s fallbacks exactly, 0 included', () => {
    expect(eventEloMultiplier(null)).toBe(1.25);
    expect(eventEloMultiplier(undefined)).toBe(1.25);
    expect(eventEloMultiplier('')).toBe(1.25);
    expect(eventEloMultiplier('rubbish')).toBe(1.25);
    // `|| 1.25`, not `?? 1.25` — an explicit 0 is read as unset by
    // rateTournamentMatch, so it has to be read as unset here too or the screen
    // would promise an unrated round the engine still rates.
    expect(eventEloMultiplier(0)).toBe(1.25);
  });
});

describe('eloWeightBreakdown', () => {
  it('multiplies the round’s weight by the event’s multiplier', () => {
    const b = eloWeightBreakdown(
      { match_format: 'best_of_3_to_21', games_per_match: 1, points_per_game: 11 },
      '1.25',
    );
    expect(b.weight).toBeCloseTo(11 / 21, 4);
    expect(b.multiplier).toBe(1.25);
    expect(b.product).toBeCloseTo((11 / 21) * 1.25, 4);
    expect(b.short).toBe('0.52 × 1.25 = 0.65×');
  });

  it('agrees with the engine: the product IS the factor applied to the K', () => {
    const shape = { match_format: 'best_of_3_to_21', games_per_match: 1, points_per_game: 15 };
    const b = eloWeightBreakdown(shape, 1.15);
    const viaEngine = calculateEloUpdate({
      playerRating: 1200,
      opponentRating: 1200,
      kFactor: 48,
      formatWeight: b.weight,
      eventMultiplier: b.multiplier,
      won: true,
    });
    // Equal ratings, so (actual - expected) is exactly 0.5.
    expect(viaEngine.delta).toBe(Math.round(48 * b.product * 0.5));
  });
});
