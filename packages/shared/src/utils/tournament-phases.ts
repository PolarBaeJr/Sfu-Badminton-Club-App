// ============================================================
// The two things a pool-to-bracket event needs everybody to agree on (00107)
// ============================================================
//
// WHICH PHASE AN EVENT IS IN, and WHAT SHAPE A MATCH IS PLAYED TO. Both are
// answered here, in one pure module, because the alternative is what the
// console had before: a dozen `status === 'live'` comparisons and a dozen
// `event.games_per_match` reads scattered across two apps, each of which is
// individually easy to get right and collectively impossible to keep in step.
// A predicate that is wrong in ONE of those places produces a format that
// cannot record a score, or a dialog that accepts a game the server refuses.
//
// Nothing here touches the database. The admin app's actions and the player
// app's read paths both import these, which is the point.

import type {
  TournamentEventFormat,
  TournamentEventStatus,
  TournamentMatchFormat,
  TournamentMatchPhase,
} from '../types/database';
import type { EventMatchShape } from './constants';
import { eventHasDraw } from './tournament-withdrawal';

// ============================================================
// The format
// ============================================================

export const TOURNAMENT_EVENT_FORMAT_LABELS: Record<TournamentEventFormat, string> = {
  single_elimination: 'Single Elimination',
  round_robin: 'Round Robin',
  pool_to_bracket: 'Round Robin + Knockout',
};

/**
 * A short answer to "what happens in this event", for the create form.
 */
export const TOURNAMENT_EVENT_FORMAT_HINTS: Record<TournamentEventFormat, string> = {
  single_elimination: 'One knockout draw. Lose once and you are out.',
  round_robin: 'Everybody plays everybody, optionally split into groups. No knockout.',
  pool_to_bracket:
    'A round robin first, then the qualifiers go straight into a knockout — in this same event. '
    + 'Nobody re-enters and nobody checks in twice.',
};

/** True for the format that plays a pool and then a knockout in one event. */
export function isPoolToBracket(format: string | null | undefined): boolean {
  return format === 'pool_to_bracket';
}

/**
 * Does this format's draw end in a bracket whose placement decides the result?
 *
 * The question `format !== 'round_robin'` was being used for this all over the
 * console, which was correct while there were two formats and is wrong now:
 * pool_to_bracket is BOTH, and the half that decides the placings is the
 * knockout. Every one of those comparisons was replaced with this.
 */
export function endsInKnockout(format: string | null | undefined): boolean {
  return format === 'single_elimination' || format === 'pool_to_bracket';
}

/** Does this format play a round robin at some point? */
export function playsRoundRobin(format: string | null | undefined): boolean {
  return format === 'round_robin' || format === 'pool_to_bracket';
}

// ============================================================
// The status machine
// ============================================================

/**
 * The statuses an event of this format passes through, in order.
 *
 * pool_to_bracket inserts its pool half in the middle and leaves the knockout
 * half exactly where it was:
 *
 *   registration -> checkin -> pool_generated -> pool_live
 *                -> bracket_generated -> live -> completed
 *
 * Two extra states rather than one, because one cannot express both "the pool
 * is drawn and has not started" and "the pool is being played" without
 * borrowing a knockout state for a pool — which would put the same state twice
 * in one path and stop `live` answering which phase is running.
 */
export function statusStepsFor(format: string | null | undefined): TournamentEventStatus[] {
  return isPoolToBracket(format)
    ? ['registration', 'checkin', 'pool_generated', 'pool_live', 'bracket_generated', 'live', 'completed']
    : ['registration', 'checkin', 'bracket_generated', 'live', 'completed'];
}

/**
 * The one forward step from `status`, or null at the end of the line.
 *
 * Derived from statusStepsFor rather than written out a second time, so the
 * stepper the exec sees and the transitions the server allows cannot drift.
 */
export function nextStatusFor(
  format: string | null | undefined,
  status: string | null | undefined,
): TournamentEventStatus | null {
  const steps = statusStepsFor(format);
  const i = steps.indexOf(status as TournamentEventStatus);
  return i < 0 || i === steps.length - 1 ? null : steps[i + 1]!;
}

/**
 * WHICH PHASE IS CURRENT, from the status alone.
 *
 * `null` before anything is drawn. This is what tells the generators which half
 * to build, the tabs which half to show, and the standings which matches to
 * tally — one function, so they cannot disagree.
 */
export function currentPhase(
  format: string | null | undefined,
  status: string | null | undefined,
): TournamentMatchPhase | null {
  if (!isPoolToBracket(format)) return null;
  if (status === 'pool_generated' || status === 'pool_live') return 'pool';
  if (status === 'bracket_generated' || status === 'live' || status === 'completed') return 'bracket';
  return null;
}

/**
 * The phase a match belongs to, for an event of this format.
 *
 * A single_elimination or round_robin event writes NULL — it has one phase, so
 * naming it would put a value in the column that nothing reads and that the
 * uniqueness index would then have to account for.
 */
export function phaseValueFor(
  format: string | null | undefined,
  phase: TournamentMatchPhase,
): TournamentMatchPhase | null {
  return isPoolToBracket(format) ? phase : null;
}

/**
 * IS THE EVENT UNDER WAY — i.e. may a result be recorded against it?
 *
 * THE SINGLE HIGHEST-RISK PREDICATE IN THE FEATURE. `enterMatchResultImpl`
 * refuses anything but `status === 'live'`, and pool matches are played at
 * `pool_live`. Left as it was, a pool_to_bracket event would generate its pool,
 * go live, and then refuse every score anybody tried to enter — the format
 * would be dead end to end on a one-word condition that no type check and no
 * unit test of the generators would catch. Every such comparison in the two
 * apps now goes through this.
 */
export function eventIsPlaying(status: string | null | undefined): boolean {
  return status === 'live' || status === 'pool_live';
}

/**
 * Drawn, and not yet finalised — where a redraw of the current phase is offered.
 *
 * Built on eventHasDraw (tournament-withdrawal.ts) rather than on a second list
 * of statuses, because "a draw exists" is one question and it already had an
 * owner. That function is where the two pool statuses were added.
 */
export function eventIsRedrawable(status: string | null | undefined): boolean {
  return eventHasDraw(status) && status !== 'completed';
}

// ============================================================
// The shape a single match is played to (00108)
// ============================================================

/** The three columns a match may carry to override its event's shape. */
export interface MatchShapeOverride {
  match_format?: TournamentMatchFormat | string | null;
  games_per_match?: number | null;
  points_per_game?: number | null;
}

/**
 * WHAT SHAPE IS THIS MATCH PLAYED TO — the one answer both the score dialog and
 * the server must use.
 *
 * The chain is match -> event -> the enum preset, and it is resolved PER FIELD
 * rather than all-or-nothing because that is already how the layer below
 * behaves: getRulesFor takes `points_per_game ?? preset.target` and
 * `games_per_match ?? preset.bestOf` independently, and effective_target /
 * effective_best_of do the same in SQL (00031). A fourth composition rule here
 * would be a second way for the two engines to disagree about whether 21-19 is
 * a legal game.
 *
 * A match with all three NULL — every match written before 00108 — resolves to
 * exactly the event shape it resolves to today. That is what makes this safe to
 * put on every call site at once.
 */
export function resolveMatchShape(
  match: MatchShapeOverride | null | undefined,
  event: EventMatchShape,
): EventMatchShape {
  return {
    match_format: (match?.match_format ?? event.match_format) as TournamentMatchFormat | string,
    games_per_match: match?.games_per_match ?? event.games_per_match ?? null,
    points_per_game: match?.points_per_game ?? event.points_per_game ?? null,
  };
}

/** True when this match overrides its event rather than inheriting it. */
export function hasOwnMatchShape(match: MatchShapeOverride | null | undefined): boolean {
  return match != null
    && (match.match_format != null || match.games_per_match != null || match.points_per_game != null);
}

// ============================================================
// The ladder — how the club actually plays
// ============================================================
//
// "we play round robin 11s then play single elim first round 11s, quarter 15s
// semis 21s finals and third place games best to 3 21s".
//
// ANCHORED FROM THE FINAL BACKWARDS, NOT FROM ROUND ONE FORWARDS, and that is
// the whole reason this is a function rather than a table keyed by round
// number. A 4-entry draw is semi-final then final; anchoring forwards would
// call its semi-final "round 1" and play it to 11, which is not what anybody
// described. Anchored backwards, every draw size degrades correctly on its own:
// a 4-draw gets 21 then best-of-3, an 8-draw gets 15/21/best-of-3, a 32-draw
// gets 11 for its first two rounds.
//
// THE THIRD-PLACE PLAYOFF GETS THE FINAL'S SHAPE. It shares round_number with
// the final (00080) and is held out of the round sequence by every index and
// every reader, so it is passed explicitly rather than looked up — a plan keyed
// by round number would have had no key for it and it would have fallen back to
// the event default, which is both the wrong answer and an invisible one.

/** One rung of the ladder: how far from the final, and what it is played to. */
export interface RoundShape {
  games_per_match: number;
  points_per_game: number;
}

const LADDER_FINAL: RoundShape = { games_per_match: 3, points_per_game: 21 };
const LADDER_SEMI: RoundShape = { games_per_match: 1, points_per_game: 21 };
const LADDER_QUARTER: RoundShape = { games_per_match: 1, points_per_game: 15 };
const LADDER_EARLY: RoundShape = { games_per_match: 1, points_per_game: 11 };

/** The pool half is played to 11, same as the knockout's early rounds. */
export const POOL_LADDER_SHAPE: RoundShape = LADDER_EARLY;

/**
 * The default shape for a knockout round, counted back from the final.
 *
 * @param roundsFromFinal 0 for the final, 1 for the semi-final, and so on.
 */
export function knockoutLadderShape(roundsFromFinal: number): RoundShape {
  if (roundsFromFinal <= 0) return LADDER_FINAL;
  if (roundsFromFinal === 1) return LADDER_SEMI;
  if (roundsFromFinal === 2) return LADDER_QUARTER;
  return LADDER_EARLY;
}

/**
 * The whole ladder for a draw of `totalRounds`, keyed by round_number.
 *
 * Returned as a map rather than applied here because the caller — draw
 * generation — is the only thing that knows which rows are in which round, and
 * because it also has to stamp the third-place playoff, which has no round of
 * its own. `thirdPlace` is that shape, and it is the final's by construction.
 */
export function knockoutLadder(totalRounds: number): {
  byRound: Map<number, RoundShape>;
  thirdPlace: RoundShape;
} {
  const byRound = new Map<number, RoundShape>();
  for (let round = 1; round <= totalRounds; round++) {
    byRound.set(round, knockoutLadderShape(totalRounds - round));
  }
  return { byRound, thirdPlace: LADDER_FINAL };
}
