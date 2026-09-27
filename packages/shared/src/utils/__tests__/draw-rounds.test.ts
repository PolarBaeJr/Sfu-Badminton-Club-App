import { describe, it, expect } from 'vitest';
import { computeDrawLayout } from '../bracket-layout';
import { groupDrawRounds, focusRoundIndex, ALL_OPEN_MAX_ROUNDS } from '../draw-rounds';
import { nextPowerOf2 } from '../constants';

const GEO = { cardH: 80, cardGap: 10, colW: 200, linkW: 30, headH: 30 };

interface M {
  id: string;
  round_number: number;
  bracket_position: number;
  status: string;
  is_bye: boolean;
}

/** The generator's shape (see bracket-layout.test.ts drawOf), every row pending. */
function drawOf(entrants: number): M[] {
  const size = nextPowerOf2(entrants);
  const totalRounds = Math.log2(size);
  const out: M[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    const count = size / Math.pow(2, round);
    for (let pos = 0; pos < count; pos++) {
      out.push({ id: `r${round}p${pos}`, round_number: round, bracket_position: pos, status: 'pending', is_bye: false });
    }
  }
  return out;
}

function withStatus(draw: M[], statuses: Record<string, string>, byes: string[] = []): M[] {
  return draw.map((m) => ({ ...m, status: statuses[m.id] ?? m.status, is_bye: byes.includes(m.id) }));
}

const roundsOf = (draw: M[]) => groupDrawRounds(computeDrawLayout(draw, GEO));
const statusOf = (m: M) => m.status;

describe('groupDrawRounds', () => {
  it('lists rounds in play order and each round in draw order, top half then bottom', () => {
    const rounds = roundsOf(drawOf(16));
    expect(rounds.map((r) => r.roundNumber)).toEqual([1, 2, 3, 4]);
    expect(rounds.map((r) => r.nodes.length)).toEqual([8, 4, 2, 1]);
    expect(rounds[0]!.nodes.map((n) => n.match.bracket_position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('reads rounds in play order however they are numbered', () => {
    const shifted = drawOf(8).map((m) => ({ ...m, round_number: m.round_number + 10 }));
    expect(roundsOf(shifted).map((r) => r.roundNumber)).toEqual([11, 12, 13]);
  });

  it('is empty for an empty draw', () => {
    expect(roundsOf([])).toEqual([]);
  });

  it('never sees the third-place playoff, because callers pass the tree only', () => {
    const tree = drawOf(8);
    const rounds = roundsOf(tree);
    expect(rounds.flatMap((r) => r.nodes).map((n) => n.id).sort()).toEqual(tree.map((m) => m.id).sort());
    expect(rounds[rounds.length - 1]!.nodes).toHaveLength(1);
  });
});

describe('focusRoundIndex', () => {
  it('opens the first round with a match being played or ready to start', () => {
    const draw = withStatus(drawOf(16), { r1p0: 'completed', r2p0: 'ready', r2p1: 'live', r3p0: 'live' });
    expect(focusRoundIndex(roundsOf(draw), statusOf)).toBe(1);
  });

  it('falls back to the last round with a result when nothing is being played', () => {
    const draw = withStatus(drawOf(16), { r1p0: 'completed', r2p0: 'walkover' });
    expect(focusRoundIndex(roundsOf(draw), statusOf)).toBe(1);
  });

  it('opens the final on a finished draw', () => {
    const finished = drawOf(8).map((m) => ({ ...m, status: 'completed' }));
    expect(focusRoundIndex(roundsOf(finished), statusOf)).toBe(2);
  });

  it('falls back to round one when nothing has happened yet', () => {
    expect(focusRoundIndex(roundsOf(drawOf(16)), statusOf)).toBe(0);
    expect(focusRoundIndex([], statusOf)).toBe(0);
  });

  it('a completed bye in round one never holds the focus back once round two has a result', () => {
    // 6 entrants in an 8 draw: the generator writes byes at positions 0 and 2 of
    // round one as completed rows. With a real result in round two, round two is
    // the last round with a result and the byes do not pull the focus back.
    const draw = withStatus(
      drawOf(6),
      { r1p0: 'completed', r1p2: 'completed', r2p0: 'completed' },
      ['r1p0', 'r1p2'],
    );
    expect(focusRoundIndex(roundsOf(draw), statusOf)).toBe(1);
  });

  it('reads a bye as a result, which lands on round one, the same place the last fallback would', () => {
    const draw = withStatus(drawOf(6), { r1p0: 'completed', r1p2: 'completed' }, ['r1p0', 'r1p2']);
    expect(focusRoundIndex(roundsOf(draw), statusOf)).toBe(0);
  });

  it('opens a draw of three rounds or fewer whole', () => {
    expect(roundsOf(drawOf(8)).length <= ALL_OPEN_MAX_ROUNDS).toBe(true);
    expect(roundsOf(drawOf(16)).length <= ALL_OPEN_MAX_ROUNDS).toBe(false);
  });
});
