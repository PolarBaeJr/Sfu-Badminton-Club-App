import { describe, it, expect } from 'vitest';
import {
  tallyGames,
  deriveWinnerSide,
  gamesNeededToWin,
  initialScoreSlots,
  trimUnplayedGames,
  validateGamesForRules,
} from '../match-result';
import { getRulesFor } from '../constants';

const g = (a: number | string, b: number | string) => ({ side_a_score: a, side_b_score: b });

describe('tallyGames', () => {
  it('counts games won, not points', () => {
    // B scores more total points (19+21+10 = 50 vs 21+15+21 = 57 for A... A wins
    // on games regardless). The point is that games decide it.
    const t = tallyGames([g(21, 19), g(15, 21), g(21, 10)]);
    expect(t).toEqual({ aGamesWon: 2, bGamesWon: 1, winner: 'a' });
  });

  it('gives the match to the side that took more games even after a blowout loss', () => {
    // A loses one game 0-21 but wins two narrow ones. Summing points would hand
    // the match to B, which would be wrong.
    expect(deriveWinnerSide([g(21, 19), g(0, 21), g(21, 19)])).toBe('a');
  });

  it('ignores unplayed trailing games in a best-of-three', () => {
    const t = tallyGames([g(21, 15), g(21, 12), g('', '')]);
    expect(t).toEqual({ aGamesWon: 2, bGamesWon: 0, winner: 'a' });
  });

  it('returns no winner when nothing has been entered', () => {
    expect(deriveWinnerSide([g('', ''), g('', '')])).toBeNull();
    expect(deriveWinnerSide([])).toBeNull();
  });

  it('returns no winner while the games are level', () => {
    // 1-1 in a best-of-three: undecided, and must not be submittable.
    expect(deriveWinnerSide([g(21, 15), g(18, 21)])).toBeNull();
  });

  it('treats a drawn game as won by neither side', () => {
    expect(tallyGames([g(21, 21)])).toEqual({ aGamesWon: 0, bGamesWon: 0, winner: null });
  });

  it('accepts string scores from form inputs', () => {
    expect(deriveWinnerSide([g('21', '15')])).toBe('a');
    expect(deriveWinnerSide([g('15', '21')])).toBe('b');
  });

  it('treats junk and blanks as zero rather than NaN', () => {
    // A blank or non-numeric field must not poison the comparison into NaN,
    // which would silently make every winner null.
    expect(deriveWinnerSide([g('abc', '21')])).toBe('b');
    expect(deriveWinnerSide([g(21, '')])).toBe('a');
  });
});

describe('gamesNeededToWin', () => {
  it('is a majority of the best-of', () => {
    expect([1, 3, 5, 7].map(gamesNeededToWin)).toEqual([1, 2, 3, 4]);
  });
});

describe('initialScoreSlots', () => {
  it('opens with the fewest games that could decide the match', () => {
    expect([1, 3, 5, 7].map((n) => initialScoreSlots(n).length)).toEqual([1, 2, 3, 4]);
  });

  it('numbers blank rows from 1', () => {
    expect(initialScoreSlots(3)).toEqual([
      { game_number: 1, side_a_score: '', side_b_score: '' },
      { game_number: 2, side_a_score: '', side_b_score: '' },
    ]);
  });
});

describe('trimUnplayedGames', () => {
  it('drops trailing rows where both sides are blank', () => {
    expect(trimUnplayedGames([g('21', '15'), g('21', '19'), g('', ''), g('', '')])).toEqual([
      g('21', '15'),
      g('21', '19'),
    ]);
  });

  it('keeps a half-filled trailing row and a blank row in the middle', () => {
    expect(trimUnplayedGames([g('21', '15'), g('', ''), g('21', '')])).toHaveLength(3);
  });

  it('returns nothing when every row is blank', () => {
    expect(trimUnplayedGames([g('', ''), g(' ', '')])).toEqual([]);
  });
});

describe('validateGamesForRules', () => {
  const bo1 = getRulesFor('single_21');
  const bo5 = getRulesFor('bo3_21', 5, 21);

  it('rejects 21-20: a game is won by two', () => {
    const res = validateGamesForRules([g(21, 20)], bo1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe('Game 1: 21-20 is not a finished game. Win by two, or at 30.');
  });

  it('accepts 30-29 at the cap and rejects 31-29 past it', () => {
    expect(validateGamesForRules([g(30, 29)], bo1).ok).toBe(true);
    expect(validateGamesForRules([g(31, 29)], bo1).ok).toBe(false);
  });

  it('accepts a 3-0 sweep in a best of 5', () => {
    expect(validateGamesForRules([g(21, 10), g(21, 12), g(21, 19)], bo5).ok).toBe(true);
  });

  it('accepts a 3-2 in a best of 5', () => {
    expect(validateGamesForRules([g(21, 10), g(10, 21), g(21, 19), g(19, 21), g(22, 20)], bo5).ok).toBe(true);
  });

  it('rejects a 3-2 with a sixth game', () => {
    const res = validateGamesForRules(
      [g(21, 10), g(10, 21), g(21, 19), g(19, 21), g(22, 20), g(21, 5)],
      bo5,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe('A best of 5 stops at 3 games won.');
  });

  it('rejects a game played after someone clinched', () => {
    const res = validateGamesForRules([g(21, 10), g(21, 12), g(21, 19), g(5, 21)], bo5);
    expect(res.ok).toBe(false);
  });

  it('rejects a match nobody has won yet', () => {
    expect(validateGamesForRules([g(21, 10), g(10, 21)], bo5).ok).toBe(false);
    expect(validateGamesForRules([], bo5).ok).toBe(false);
  });

  it('judges each game against its own target', () => {
    const to11 = getRulesFor('bo3_21', 1, 11);
    expect(validateGamesForRules([g(11, 9)], to11).ok).toBe(true);
    expect(validateGamesForRules([g(20, 19)], to11).ok).toBe(true);
    expect(validateGamesForRules([g(21, 19)], to11).ok).toBe(false);
  });

  it('writes its messages without an em dash', () => {
    const results = [
      validateGamesForRules([g(21, 20)], bo1),
      validateGamesForRules([g(21, 10), g(10, 21)], bo5),
      validateGamesForRules([g(21, 10), g(21, 12), g(21, 19), g(5, 21)], bo5),
      validateGamesForRules([], bo5),
    ];
    for (const res of results) {
      if (!res.ok) expect(res.message).not.toContain('\u2014');
    }
  });
});
