// ============================================================
// THE DRAW AS A LIST OF ROUNDS (the phone fallback in both apps)
// ============================================================
//
// A converging draw is 2R-1 columns wide, which is a worse sideways drag on a
// 390px screen than the chart it replaced. So below 768px both apps show the
// same draw as one collapsible list per round instead: the player app in
// DrawRounds (Draw.tsx), the console in BracketTab. The grouping and the rule
// for which round opens are written once here so the two lists cannot come to
// disagree about what a phone opens on.
//
// Nothing in here touches React, the DOM or the database.

import type { DrawInputMatch, DrawNode } from './bracket-layout';

export interface DrawRound<M extends DrawInputMatch> {
  roundNumber: number;
  nodes: Array<DrawNode<M>>;
}

/**
 * THE SHORTEST DRAW THAT OPENS WHOLE. Three rounds is at most seven matches;
 * collapsing that buys nothing and costs a reader two taps, so an eight-entry
 * event opens every round.
 */
export const ALL_OPEN_MAX_ROUNDS = 3;

/**
 * The layout's nodes grouped by round, rounds in play order. Within a round the
 * top half comes first and then the bottom, each in draw order: the same order
 * the cards appear down the chart's two columns.
 *
 * Callers pass the layout of the TREE only. The third-place playoff is not in
 * it and is listed after the rounds by each app on its own.
 */
export function groupDrawRounds<M extends DrawInputMatch>(
  layout: { nodes: Array<DrawNode<M>> },
): Array<DrawRound<M>> {
  const rounds: Array<DrawRound<M>> = [];
  for (const node of layout.nodes) {
    const found = rounds.find((r) => r.roundNumber === node.roundNumber);
    if (found) found.nodes.push(node);
    else rounds.push({ roundNumber: node.roundNumber, nodes: [node] });
  }
  rounds.sort((a, b) => a.roundNumber - b.roundNumber);
  for (const r of rounds) {
    r.nodes.sort((a, b) => a.match.bracket_position - b.match.bracket_position);
  }
  return rounds;
}

/**
 * WHICH ROUND OPENS. A 128-entrant draw is 127 matches, and every one of them
 * stacked open is a list nobody scrolls to the bottom of: the first round alone
 * is 64 rows, so "the final" is 3,000px below the fold on the one screen that
 * has the least of it.
 *
 * The rule is "the round somebody is here for", in three fallbacks:
 *   * whatever is being PLAYED (live, or ready to start),
 *   * failing that the LAST round with a result, which on a finished event is
 *     the final and on a half-played one is where the draw has got to,
 *   * failing both, round one. Nothing has happened yet, so the fixtures are
 *     the news.
 *
 * A bye counts as a result here, since the generator writes it `completed`. That
 * never moves the focus backwards: byes only exist in round one, so any later
 * round with a real result is found first by the "last" search.
 */
export function focusRoundIndex<M extends DrawInputMatch>(
  rounds: Array<DrawRound<M>>,
  statusOf: (match: M) => string,
): number {
  const isPlaying = (r: DrawRound<M>) =>
    r.nodes.some((n) => statusOf(n.match) === 'live' || statusOf(n.match) === 'ready');
  const hasResult = (r: DrawRound<M>) =>
    r.nodes.some((n) => statusOf(n.match) === 'completed' || statusOf(n.match) === 'walkover');

  let focusIndex = rounds.findIndex(isPlaying);
  if (focusIndex === -1) focusIndex = rounds.map(hasResult).lastIndexOf(true);
  if (focusIndex === -1) focusIndex = 0;
  return focusIndex;
}
