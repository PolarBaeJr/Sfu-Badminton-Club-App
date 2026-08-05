// Who won, derived from the game scores.
//
// The tournament bracket already worked this out for itself; the challenge form
// asked the submitter to pick a winner from a dropdown next to the scores they
// had just typed. That is a question the scores already answer, and letting a
// human answer it separately means the two can disagree — a mis-tapped dropdown
// records the wrong winner against a correct scoreline, and the rating change
// that follows is wrong in a way nobody spots until someone reads the ladder.
//
// One implementation, used by both.

export interface GameScore {
  side_a_score: number | string;
  side_b_score: number | string;
}

export interface MatchTally {
  aGamesWon: number;
  bGamesWon: number;
  /** null when the scores do not yet decide it — all blank, or level. */
  winner: 'a' | 'b' | null;
}

/**
 * Games are counted, not points: a 21-19, 15-21, 21-10 win is 2-1 regardless of
 * total points, and total points would hand the match to the loser of a
 * blowout-plus-two-squeakers.
 *
 * A drawn game (equal scores, including a blank 0-0) counts for neither side,
 * so trailing unplayed games in a best-of-three simply do not contribute.
 */
export function tallyGames(games: readonly GameScore[]): MatchTally {
  let aGamesWon = 0;
  let bGamesWon = 0;

  for (const g of games) {
    const a = toScore(g.side_a_score);
    const b = toScore(g.side_b_score);
    if (a > b) aGamesWon++;
    else if (b > a) bGamesWon++;
  }

  const winner = aGamesWon > bGamesWon ? 'a' : bGamesWon > aGamesWon ? 'b' : null;
  return { aGamesWon, bGamesWon, winner };
}

function toScore(value: number | string): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Convenience for callers that only need the side. */
export function deriveWinnerSide(games: readonly GameScore[]): 'a' | 'b' | null {
  return tallyGames(games).winner;
}
