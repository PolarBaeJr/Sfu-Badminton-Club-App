import { describe, it, expect } from 'vitest';
import { tallyGames, deriveWinnerSide } from '../match-result';

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
