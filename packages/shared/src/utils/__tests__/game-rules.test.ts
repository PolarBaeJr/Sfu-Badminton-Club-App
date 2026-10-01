import { describe, expect, it } from 'vitest';
import { isLegalGameScore, pointsCap } from '../constants';
import { isLegalGame, legacyGameRules, validateMatch, type GameRules, type MatchRules } from '../game-rules';
import { validateGamesForRules } from '../match-result';

// The strict path of isLegalGameScore exactly as it stood before it delegated
// to isLegalGame, kept here as the reference the refactor is measured against.
function oldStrictLegal(a: number, b: number, target: number): boolean {
  const cap = pointsCap(target);
  const winner = Math.max(a, b);
  const loser = Math.min(a, b);
  if (a === b) return false;
  if (loser < 0 || winner > cap) return false;
  if (winner === target) return loser <= target - 2;
  if (winner > target && winner < cap) return winner - loser === 2;
  if (winner === cap) return loser >= cap - 2;
  return false;
}

describe('isLegalGameScore still judges exactly as before', () => {
  const entryPoints: Array<{ label: string; target: number; call: (a: number, b: number) => boolean }> = [
    { label: 'single_11', target: 11, call: (a, b) => isLegalGameScore(a, b, 'single_11') },
    { label: 'one_game_15', target: 15, call: (a, b) => isLegalGameScore(a, b, 'one_game_15') },
    { label: 'single_21', target: 21, call: (a, b) => isLegalGameScore(a, b, 'single_21') },
    { label: 'single_21 typed to 15', target: 15, call: (a, b) => isLegalGameScore(a, b, 'single_21', 1, 15) },
    { label: 'bo3_21 typed to 11', target: 11, call: (a, b) => isLegalGameScore(a, b, 'bo3_21', 3, 11) },
  ];

  for (const { label, target, call } of entryPoints) {
    it(`${label}: every score from -1 to 40 on both sides`, () => {
      const mismatches: string[] = [];
      for (let a = -1; a <= 40; a++) {
        for (let b = -1; b <= 40; b++) {
          if (call(a, b) !== oldStrictLegal(a, b, target)) mismatches.push(`${a}-${b}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('isLegalGame over legacyGameRules agrees with the reference for 11, 15 and 21', () => {
    for (const target of [11, 15, 21]) {
      const rules = legacyGameRules({ target });
      for (let a = -1; a <= 40; a++) {
        for (let b = -1; b <= 40; b++) {
          expect(isLegalGame({ a, b }, rules)).toBe(oldStrictLegal(a, b, target));
        }
      }
    }
  });

  it('the time-exceeded rule is untouched', () => {
    expect(isLegalGameScore(15, 2, 'single_21', 1, 21, true)).toBe(true);
    expect(isLegalGameScore(21, 2, 'single_21', 1, 15, true)).toBe(false);
  });
});

describe('legacyGameRules', () => {
  it('is win by two with the target + 9 cap and no head start', () => {
    expect(legacyGameRules({ target: 21 })).toEqual({ target: 21, winByTwo: true, cap: 30, startA: 0, startB: 0 });
  });
});

describe('isLegalGame with a head start', () => {
  // Side A starts on 5 in a game to 15, win by two off, no cap.
  const r: GameRules = { target: 15, winByTwo: false, cap: null, startA: 5, startB: 0 };

  it('accepts finishes at or above each side\'s start', () => {
    expect(isLegalGame({ a: 15, b: 12 }, r)).toBe(true);
    expect(isLegalGame({ a: 15, b: 0 }, r)).toBe(true);
    expect(isLegalGame({ a: 5, b: 15 }, r)).toBe(true);
    expect(isLegalGame({ a: 14, b: 15 }, r)).toBe(true);
  });

  it('refuses a side below the points it started with', () => {
    expect(isLegalGame({ a: 4, b: 15 }, r)).toBe(false);
  });

  it('the start applies whichever side holds it', () => {
    const rb: GameRules = { ...r, startA: 0, startB: 5 };
    expect(isLegalGame({ a: 15, b: 5 }, rb)).toBe(true);
    expect(isLegalGame({ a: 15, b: 4 }, rb)).toBe(false);
    expect(isLegalGame({ a: 0, b: 15 }, rb)).toBe(true);
  });

  it('a side with no head start may still finish on 0', () => {
    expect(isLegalGame({ a: 15, b: 0 }, r)).toBe(true);
    expect(isLegalGame({ a: 0, b: 15 }, r)).toBe(false);
  });

  it('works with win by two and a cap', () => {
    const r2: GameRules = { target: 21, winByTwo: true, cap: 30, startA: 5, startB: 0 };
    expect(isLegalGame({ a: 21, b: 19 }, r2)).toBe(true);
    expect(isLegalGame({ a: 5, b: 21 }, r2)).toBe(true);
    expect(isLegalGame({ a: 4, b: 21 }, r2)).toBe(false);
    expect(isLegalGame({ a: 30, b: 29 }, r2)).toBe(true);
    expect(isLegalGame({ a: 31, b: 29 }, r2)).toBe(false);
  });
});

describe('isLegalGame without win by two', () => {
  const r: GameRules = { target: 15, winByTwo: false, cap: null, startA: 0, startB: 0 };

  it('the first to the target wins, however close', () => {
    expect(isLegalGame({ a: 15, b: 14 }, r)).toBe(true);
    expect(isLegalGame({ a: 14, b: 15 }, r)).toBe(true);
    expect(isLegalGame({ a: 15, b: 0 }, r)).toBe(true);
  });

  it('nobody plays past the target', () => {
    expect(isLegalGame({ a: 16, b: 14 }, r)).toBe(false);
    expect(isLegalGame({ a: 14, b: 13 }, r)).toBe(false);
    expect(isLegalGame({ a: 15, b: 15 }, r)).toBe(false);
  });
});

describe('isLegalGame win by two without a cap', () => {
  const r: GameRules = { target: 21, winByTwo: true, cap: null, startA: 0, startB: 0 };

  it('deuce runs on until somebody is two clear', () => {
    expect(isLegalGame({ a: 21, b: 19 }, r)).toBe(true);
    expect(isLegalGame({ a: 35, b: 33 }, r)).toBe(true);
    expect(isLegalGame({ a: 21, b: 20 }, r)).toBe(false);
    expect(isLegalGame({ a: 35, b: 32 }, r)).toBe(false);
  });
});

describe('validateMatch', () => {
  const bo1: MatchRules = { bestOf: 1, target: 15, winByTwo: false, cap: null, startA: 0, startB: 0 };
  const bo3: MatchRules = { bestOf: 3, target: 21, winByTwo: true, cap: 30, startA: 0, startB: 0 };

  it('a one-game match is one legal game', () => {
    expect(validateMatch([{ a: 15, b: 14 }], bo1)).toEqual({ ok: true, winner: 'a' });
    expect(validateMatch([{ a: 9, b: 15 }], bo1)).toEqual({ ok: true, winner: 'b' });
    expect(validateMatch([{ a: 16, b: 14 }], bo1).ok).toBe(false);
    expect(validateMatch([], bo1).ok).toBe(false);
    expect(validateMatch([{ a: 15, b: 3 }, { a: 15, b: 3 }], bo1).ok).toBe(false);
  });

  it('a best of three needs two games and stops there', () => {
    expect(validateMatch([{ a: 21, b: 10 }, { a: 21, b: 19 }], bo3)).toEqual({ ok: true, winner: 'a' });
    expect(validateMatch([{ a: 21, b: 10 }, { a: 10, b: 21 }, { a: 28, b: 30 }], bo3))
      .toEqual({ ok: true, winner: 'b' });
    expect(validateMatch([{ a: 21, b: 10 }], bo3).ok).toBe(false);
    expect(validateMatch([{ a: 21, b: 10 }, { a: 21, b: 10 }, { a: 21, b: 10 }], bo3).ok).toBe(false);
    expect(validateMatch([{ a: 21, b: 10 }, { a: 21, b: 20 }], bo3).ok).toBe(false);
  });

  it('a head start holds in every game of the match', () => {
    const hs: MatchRules = { ...bo3, startA: 5 };
    expect(validateMatch([{ a: 21, b: 10 }, { a: 5, b: 21 }, { a: 21, b: 15 }], hs).ok).toBe(true);
    expect(validateMatch([{ a: 21, b: 10 }, { a: 4, b: 21 }, { a: 21, b: 15 }], hs).ok).toBe(false);
  });

  it('refuses fractional scores', () => {
    expect(validateMatch([{ a: 15, b: 13.5 }], bo1).ok).toBe(false);
  });

  it('says a score below a head start is below the head start, not unfinished', () => {
    const hs: MatchRules = { ...bo1, startB: 5 };
    expect(validateMatch([{ a: 15, b: 4 }], hs)).toEqual({
      ok: false,
      error: 'Game 1: Side B starts at 5, so their score cannot be below 5.',
    });
    expect(validateMatch([{ a: 15, b: 4 }], hs, { cutShort: true })).toEqual({
      ok: false,
      error: 'Game 1: Side B starts at 5, so their score cannot be below 5.',
    });
    const both: MatchRules = { ...bo3, startA: 3 };
    expect(validateMatch([{ a: 21, b: 10 }, { a: 2, b: 21 }], both, { sideNames: { a: 'Team Kestrel', b: 'Team Heron' } }))
      .toEqual({ ok: false, error: 'Game 2: Team Kestrel starts at 3, so their score cannot be below 3.' });
  });

  it('keeps the unfinished-game message for a score at or above the head start', () => {
    const hs: MatchRules = { ...bo1, startB: 5 };
    expect(validateMatch([{ a: 14, b: 5 }], hs)).toEqual({ ok: false, error: 'Game 1: 14-5 is not a finished game.' });
  });
});

describe('validateGamesForRules with a head start', () => {
  const g = (a: number, b: number) => ({ side_a_score: String(a), side_b_score: String(b) });
  const bo1 = { bestOf: 1, target: 21, cap: 30 };

  it('defaults to no head start', () => {
    expect(validateGamesForRules([g(21, 0)], bo1).ok).toBe(true);
  });

  it('refuses a side below its start', () => {
    expect(validateGamesForRules([g(21, 0)], bo1, { a: 0, b: 3 }).ok).toBe(false);
    expect(validateGamesForRules([g(21, 0)], bo1, { a: 0, b: 3 })).toEqual({
      ok: false,
      message: 'Game 1: Side B starts at 3, so their score cannot be below 3.',
    });
    expect(validateGamesForRules([g(21, 3)], bo1, { a: 0, b: 3 }).ok).toBe(true);
  });
});
