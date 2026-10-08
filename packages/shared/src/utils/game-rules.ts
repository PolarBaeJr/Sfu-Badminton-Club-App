// What a legal game and a legal match are, for any scoring a stage can choose:
// a target, win by two on or off, an optional cap, and a head start for either
// side. The fixed club formats are one case of this (legacyGameRules), and
// isLegalGameScore in constants.ts delegates here so there is one judge.
//
// Imports from constants and match-result are only used inside function bodies:
// constants imports this module back, and a top-level call would hit the cycle.

import { pointsCap } from './constants';
import { gamesNeededToWin, tallyGames } from './match-result';

export interface GameRules {
  target: number;
  winByTwo: boolean;
  /** The score that ends a deuce outright. null = no cap. Ignored when winByTwo is off. */
  cap: number | null;
  /** Points side A starts every game on (a head start). 0 = none. */
  startA: number;
  startB: number;
}

export interface MatchRules extends GameRules {
  bestOf: 1 | 3 | 5 | 7;
}

/**
 * Is this a legal way for one game to end?
 *
 * Scores are the displayed totals INCLUDING any head start, so a side that
 * started on 5 and never scored reads 5, and anything below its start is
 * impossible.
 *
 *  - win by two: the winner reaches the target two clear (21-19, or 23-21 past
 *    the target), or takes the cap with the loser on cap-1 or cap-2. Never past
 *    max(target, loser + 2) and never past the cap.
 *  - not win by two: the winner is on exactly the target, the loser anywhere
 *    below it (15-14 is a finish).
 */
export function isLegalGame(score: { a: number; b: number }, r: GameRules): boolean {
  const { a, b } = score;
  if (a < r.startA || b < r.startB) return false;
  if (a === b) return false;
  const winner = Math.max(a, b);
  const loser = Math.min(a, b);

  if (!r.winByTwo) return winner === r.target && loser < r.target;

  if (r.cap != null && winner > r.cap) return false;
  if (winner === r.target && loser <= r.target - 2) return true;
  if (r.cap != null && winner === r.cap) return loser >= r.cap - 2;
  if (winner > r.target) return winner - loser === 2;
  return false;
}

/**
 * A game the clock stopped before it finished: it still needs a winner, each
 * side is still at or above its start, and nobody is past where the game would
 * have ended anyway (the cap with win by two, the target without).
 */
export function isLegalCutShortGame(score: { a: number; b: number }, r: GameRules): boolean {
  const { a, b } = score;
  if (a < r.startA || b < r.startB || a === b) return false;
  const ceiling = r.winByTwo ? r.cap ?? Infinity : r.target;
  return Math.max(a, b) <= ceiling;
}

export type MatchValidation = { ok: true; winner: 'a' | 'b' } | { ok: false; error: string };

/**
 * A whole scoreline: every game legal under the same rules (a head start holds
 * in every game), no game after the match was decided, and somebody on exactly
 * the clinching number of games.
 *
 * cutShort judges each game by isLegalCutShortGame instead; the clinch rule is
 * unchanged, since a best-of-3 called at 1-0 still has no winner.
 */
export function validateMatch(
  games: ReadonlyArray<{ a: number; b: number }>,
  r: MatchRules,
  opts: { cutShort?: boolean; sideNames?: { a: string; b: string } } = {},
): MatchValidation {
  const names = opts.sideNames ?? { a: 'Side A', b: 'Side B' };
  const needed = gamesNeededToWin(r.bestOf);
  if (games.length === 0) return { ok: false, error: 'Enter the score of at least one game.' };

  let aWon = 0;
  let bWon = 0;
  for (const [i, g] of games.entries()) {
    if (aWon === needed || bWon === needed) {
      return { ok: false, error: `The match was already decided before game ${i + 1}.` };
    }
    // Integers only here. isLegalGame keeps the old strict path's behaviour,
    // which compared fractions without objecting; a new path has no such debt.
    if (!Number.isInteger(g.a) || !Number.isInteger(g.b)) {
      return { ok: false, error: `Game ${i + 1}: scores must be whole numbers.` };
    }
    // Below a head start is a typo of a different kind from an unfinished game,
    // and "15-4 is not a finished game" sends the exec looking at the wrong number.
    for (const side of ['a', 'b'] as const) {
      const start = side === 'a' ? r.startA : r.startB;
      if (g[side] < start) {
        return {
          ok: false,
          error: `Game ${i + 1}: ${names[side]} starts at ${start}, so their score cannot be below ${start}.`,
        };
      }
    }
    if (opts.cutShort ? !isLegalCutShortGame(g, r) : !isLegalGame(g, r)) {
      return {
        ok: false,
        error: opts.cutShort
          ? `Game ${i + 1}: ${g.a}-${g.b} is not possible even for a game cut short.`
          : `Game ${i + 1}: ${g.a}-${g.b} is not a finished game.`,
      };
    }
    if (g.a > g.b) aWon++;
    else bWon++;
  }

  const tally = tallyGames(games.map((g) => ({ side_a_score: g.a, side_b_score: g.b })));
  if (tally.winner == null || Math.max(tally.aGamesWon, tally.bGamesWon) !== needed) {
    return {
      ok: false,
      error: `The match is not finished. The winner needs ${needed} game${needed === 1 ? '' : 's'}.`,
    };
  }
  return { ok: true, winner: tally.winner };
}

/** The club's fixed formats: win by two, capped at target + 9, no head start. */
export function legacyGameRules(shape: { target: number }): GameRules {
  return { target: shape.target, winByTwo: true, cap: pointsCap(shape.target), startA: 0, startB: 0 };
}
