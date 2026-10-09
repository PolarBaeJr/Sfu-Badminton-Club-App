import { isLegalGameCount, pointsCap } from './constants';
import { isLegalGame } from './game-rules';

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

/** Games a side must win to take a best-of-N: 2 of 3, 3 of 5, 4 of 7. */
export function gamesNeededToWin(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

export interface ScoreSlot {
  game_number: number;
  side_a_score: string;
  side_b_score: string;
}

/**
 * The blank rows a score form opens with: the fewest games that could decide
 * the match. More are added only while nobody has clinched.
 */
export function initialScoreSlots(bestOf: number): ScoreSlot[] {
  const count = Math.max(1, gamesNeededToWin(bestOf));
  return Array.from({ length: count }, (_, i) => ({
    game_number: i + 1,
    side_a_score: '',
    side_b_score: '',
  }));
}

function isBlank(value: number | string): boolean {
  return typeof value === 'string' && value.trim() === '';
}

/** Drops trailing rows where both sides are blank: games that were never played. */
export function trimUnplayedGames<T extends GameScore>(slots: readonly T[]): T[] {
  let end = slots.length;
  while (end > 0) {
    const last = slots[end - 1];
    if (!last || !isBlank(last.side_a_score) || !isBlank(last.side_b_score)) break;
    end--;
  }
  return slots.slice(0, end);
}

export type GamesValidation = { ok: true } | { ok: false; message: string };

/**
 * Judges a whole scoreline against the match's own rules: every game a legal
 * finish for its target and cap, no game played after someone clinched, and
 * the winner on exactly the clinching number of games. `starts` is a head
 * start each side begins every game on; scores include it.
 */
export function validateGamesForRules(
  games: readonly GameScore[],
  rules: { bestOf: number; target: number; cap: number },
  starts: { a: number; b: number } = { a: 0, b: 0 },
): GamesValidation {
  const { bestOf, target, cap } = rules;
  const needed = gamesNeededToWin(bestOf);
  const stopsAt = bestOf > 1
    ? `A best of ${bestOf} stops at ${needed} games won.`
    : 'A one-game match is a single game.';

  if (games.length === 0) return { ok: false, message: 'Enter the score of at least one game.' };
  if (games.length > bestOf) return { ok: false, message: stopsAt };

  let aWon = 0;
  let bWon = 0;
  for (const [i, game] of games.entries()) {
    const a = toScore(game.side_a_score);
    const b = toScore(game.side_b_score);
    if (aWon === needed || bWon === needed) return { ok: false, message: stopsAt };
    if (a < starts.a) return { ok: false, message: `Game ${i + 1}: Side A starts at ${starts.a}, so their score cannot be below ${starts.a}.` };
    if (b < starts.b) return { ok: false, message: `Game ${i + 1}: Side B starts at ${starts.b}, so their score cannot be below ${starts.b}.` };
    // The cap judged is pointsCap(target), as before; rules.cap only words the message.
    const legal = isLegalGame(
      { a, b },
      { target, winByTwo: true, cap: pointsCap(target), startA: starts.a, startB: starts.b },
    );
    if (!legal) {
      return {
        ok: false,
        message: `Game ${i + 1}: ${a}-${b} is not a finished game. Win by two, or at ${cap}.`,
      };
    }
    if (a > b) aWon++;
    else bWon++;
  }

  const winnerGames = Math.max(aWon, bWon);
  const loserGames = Math.min(aWon, bWon);
  if (!isLegalGameCount(winnerGames, loserGames, 'single_21', bestOf)) {
    return {
      ok: false,
      message: `The match is not finished. The winner needs ${needed} game${needed === 1 ? '' : 's'}.`,
    };
  }
  return { ok: true };
}
