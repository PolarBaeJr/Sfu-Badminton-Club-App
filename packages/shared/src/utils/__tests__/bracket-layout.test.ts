import { describe, it, expect } from 'vitest';
import { computeDrawLayout, fitScale, type DrawInputMatch } from '../bracket-layout';
import { nextPowerOf2 } from '../constants';

const GEO = { cardH: 80, cardGap: 10, colW: 200, linkW: 30, headH: 30 };
const PITCH = GEO.cardH + GEO.cardGap;

/**
 * A draw shaped exactly the way `generateBracket` shapes one: `nextPowerOf2(N)`
 * slots, round `r` holding `bracketSize / 2^r` matches, `bracket_position`
 * 0-based, and child `i` feeding `floor(i / 2)` of the round above. The tests
 * are only worth anything if the fixture is the generator's shape, so it is
 * built from the same `nextPowerOf2` the generator calls.
 */
function drawOf(entrants: number): DrawInputMatch[] {
  const size = nextPowerOf2(entrants);
  const totalRounds = Math.log2(size);
  const out: DrawInputMatch[] = [];
  for (let round = 1; round <= totalRounds; round++) {
    const count = size / Math.pow(2, round);
    for (let pos = 0; pos < count; pos++) {
      out.push({ id: `r${round}p${pos}`, round_number: round, bracket_position: pos });
    }
  }
  return out;
}

const at = (l: ReturnType<typeof computeDrawLayout>, id: string) =>
  l.nodes.find((n) => n.id === id)!;

describe('computeDrawLayout — converging', () => {
  it('meets in the middle: 2R-1 columns, and the final is the centre one', () => {
    const l = computeDrawLayout(drawOf(32), GEO);
    expect(l.mode).toBe('converging');
    expect(l.rounds).toBe(5);
    // Nine columns of card plus eight gutters, not five columns.
    expect(l.width).toBe(9 * GEO.colW + 8 * GEO.linkW);
    const final = at(l, 'r5p0');
    expect(final.side).toBe('centre');
    // Dead centre: the same distance from each edge.
    expect(final.x).toBe((l.width - GEO.colW) / 2);
  });

  it('halves the height a linear draw would need', () => {
    const l = computeDrawLayout(drawOf(32), GEO);
    // 16 first-round matches, so 8 a side rather than 16 in one column.
    const perSide = l.nodes.filter((n) => n.depth === 0 && n.side === 'left').length;
    expect(perSide).toBe(8);
    expect(l.nodes.filter((n) => n.depth === 0 && n.side === 'right')).toHaveLength(8);
    expect(l.bodyH).toBe(7 * PITCH + GEO.cardH);
  });

  it('splits the first round down the middle of bracket_position order', () => {
    const l = computeDrawLayout(drawOf(32), GEO);
    const firstRound = l.nodes
      .filter((n) => n.depth === 0)
      .sort((a, b) => a.match.bracket_position - b.match.bracket_position);
    expect(firstRound.slice(0, 8).every((n) => n.side === 'left')).toBe(true);
    expect(firstRound.slice(8).every((n) => n.side === 'right')).toBe(true);
  });

  it('runs the right half inwards — its columns march leftwards as rounds advance', () => {
    const l = computeDrawLayout(drawOf(32), GEO);
    const rightXs = [0, 1, 2, 3].map(
      (d) => l.nodes.find((n) => n.depth === d && n.side === 'right')!.x,
    );
    for (let i = 1; i < rightXs.length; i++) expect(rightXs[i]!).toBeLessThan(rightXs[i - 1]!);
    const leftXs = [0, 1, 2, 3].map(
      (d) => l.nodes.find((n) => n.depth === d && n.side === 'left')!.x,
    );
    for (let i = 1; i < leftXs.length; i++) expect(leftXs[i]!).toBeGreaterThan(leftXs[i - 1]!);
    // The two halves are mirror images about the centre line.
    for (let d = 0; d < 4; d++) expect(leftXs[d]! + rightXs[d]!).toBe(l.width - GEO.colW);
  });

  it('mirrors X only — slot a stays above slot b on both halves', () => {
    const l = computeDrawLayout(drawOf(16), GEO);
    // Round 1 positions 4..7 are the right half. The even index is
    // winner_to_position 'a', and it must be the upper card on this side too.
    const p4 = at(l, 'r1p4');
    const p5 = at(l, 'r1p5');
    expect(p4.side).toBe('right');
    expect(p4.y).toBeLessThan(p5.y);
  });

  it('puts every card at the midpoint of the two that feed it', () => {
    const l = computeDrawLayout(drawOf(16), GEO);
    for (const parent of l.nodes.filter((n) => n.depth > 0)) {
      const p = parent.match.bracket_position;
      const kids = l.nodes.filter(
        (n) =>
          n.depth === parent.depth - 1
          && (n.match.bracket_position === p * 2 || n.match.bracket_position === p * 2 + 1),
      );
      expect(kids).toHaveLength(2);
      expect(parent.y).toBeCloseTo((kids[0]!.y + kids[1]!.y) / 2, 6);
    }
  });

  it('draws a straight line into the final from each half', () => {
    const l = computeDrawLayout(drawOf(8), GEO);
    const final = at(l, 'r3p0');
    const semiL = at(l, 'r2p0');
    const semiR = at(l, 'r2p1');
    // Both semis sit at the same height as the final, so neither link needs a
    // riser — a converging draw's last join is two horizontal lines.
    expect(semiL.y).toBe(final.y);
    expect(semiR.y).toBe(final.y);
    expect(l.connectors.filter((c) => c.key.startsWith('c1-0-') && c.w === 1)).toHaveLength(0);
    // ...and they arrive from opposite sides.
    expect(semiL.x).toBeLessThan(final.x);
    expect(semiR.x).toBeGreaterThan(final.x);
  });

  it('lands every connector on the edge of the cards it joins', () => {
    const l = computeDrawLayout(drawOf(16), GEO);
    for (const parent of l.nodes.filter((n) => n.depth > 0)) {
      const p = parent.match.bracket_position;
      for (const kid of l.nodes.filter(
        (n) =>
          n.depth === parent.depth - 1
          && (n.match.bracket_position === p * 2 || n.match.bracket_position === p * 2 + 1),
      )) {
        const key = `c${kid.depth}-${p}-${kid.match.bracket_position}`;
        const stub = l.connectors.find((c) => c.key === `${key}-stub`)!;
        const entry = l.connectors.find((c) => c.key === `${key}-entry`)!;
        expect(stub.y).toBe(kid.y + GEO.cardH / 2);
        expect(entry.y).toBe(parent.y + GEO.cardH / 2);
        if (kid.side === 'right') {
          // Leaves the child's LEFT edge, arrives at the parent's RIGHT edge.
          expect(stub.x + stub.w).toBe(kid.x);
          expect(entry.x).toBe(parent.x + GEO.colW);
        } else {
          expect(stub.x).toBe(kid.x + GEO.colW);
          expect(entry.x + entry.w).toBe(parent.x);
        }
      }
    }
  });

  it('names each round once a side and once in the centre', () => {
    const l = computeDrawLayout(drawOf(32), GEO);
    expect(l.columns).toHaveLength(9);
    expect(l.columns.filter((c) => c.side === 'centre')).toHaveLength(1);
    expect(l.columns.filter((c) => c.roundNumber === 1)).toHaveLength(2);
  });
});

describe('computeDrawLayout — the sizes that have to stay legible', () => {
  const cases: Array<[number, number, number]> = [
    // entrants, rounds, first-round matches a side
    [8, 3, 2],
    [32, 5, 8],
    [64, 6, 16],
    [128, 7, 32],
  ];
  for (const [entrants, rounds, perSide] of cases) {
    it(`a ${entrants}-entry draw is ${2 * rounds - 1} columns and ${perSide} cards a side`, () => {
      const l = computeDrawLayout(drawOf(entrants), GEO);
      expect(l.mode).toBe('converging');
      expect(l.rounds).toBe(rounds);
      expect(l.columns).toHaveLength(2 * rounds - 1);
      expect(l.nodes.filter((n) => n.depth === 0 && n.side === 'left')).toHaveLength(perSide);
      expect(l.bodyH).toBe((perSide - 1) * PITCH + GEO.cardH);
    });
  }

  it('is more of the draw on a landscape screen than a linear one, at every size', () => {
    const viewport = { w: 1400, h: 760 };
    for (const entrants of [32, 64, 128]) {
      const conv = computeDrawLayout(drawOf(entrants), GEO);
      // The linear shape the two apps drew before: one column a round, the whole
      // first round stacked in it.
      const linW = conv.rounds * GEO.colW + (conv.rounds - 1) * GEO.linkW;
      const linH =
        GEO.headH + (Math.pow(2, conv.rounds - 1) - 1) * PITCH + GEO.cardH;
      expect(fitScale(conv, viewport.w, viewport.h))
        .toBeGreaterThan(fitScale({ width: linW, height: linH }, viewport.w, viewport.h));
    }
  });
});

describe('computeDrawLayout — the awkward draws', () => {
  it('a two-entry event is a final and nothing else', () => {
    const l = computeDrawLayout(drawOf(2), GEO);
    expect(l.mode).toBe('converging');
    expect(l.columns).toHaveLength(1);
    expect(l.nodes[0]!.side).toBe('centre');
    expect(l.width).toBe(GEO.colW);
  });

  it('a four-entry event is one match a side and the final between them', () => {
    const l = computeDrawLayout(drawOf(4), GEO);
    expect(l.nodes.filter((n) => n.side === 'left')).toHaveLength(1);
    expect(l.nodes.filter((n) => n.side === 'right')).toHaveLength(1);
    expect(l.width).toBe(3 * GEO.colW + 2 * GEO.linkW);
  });

  it('handles a non-power-of-two field, which the generator pads with byes', () => {
    // 13 entrants -> a 16-slot draw. The layout sees 16 slots' worth of matches;
    // three of the first-round rows are byes, which are cards like any other.
    const l = computeDrawLayout(drawOf(13), GEO);
    expect(l.mode).toBe('converging');
    expect(l.rounds).toBe(4);
    expect(l.nodes.filter((n) => n.depth === 0)).toHaveLength(8);
  });

  it('falls back to a linear stack, with no guessed lines, when the rounds do not halve', () => {
    // Three first-round matches feeding one final: nothing here says which two
    // of the three meet, so no elbow can be honest about it.
    const odd: DrawInputMatch[] = [
      { id: 'a', round_number: 1, bracket_position: 0 },
      { id: 'b', round_number: 1, bracket_position: 1 },
      { id: 'c', round_number: 1, bracket_position: 2 },
      { id: 'f', round_number: 2, bracket_position: 0 },
    ];
    const l = computeDrawLayout(odd, GEO);
    expect(l.mode).toBe('linear');
    expect(l.connectors).toHaveLength(0);
    expect(l.columns).toHaveLength(2);
    expect(l.nodes.every((n) => n.side === 'left')).toBe(true);
    expect(l.width).toBe(2 * GEO.colW + GEO.linkW);
  });

  it('falls back when the last round is not a single final', () => {
    const twoFinals: DrawInputMatch[] = [
      { id: 'a', round_number: 1, bracket_position: 0 },
      { id: 'b', round_number: 1, bracket_position: 1 },
      { id: 'c', round_number: 1, bracket_position: 2 },
      { id: 'd', round_number: 1, bracket_position: 3 },
      { id: 'e', round_number: 2, bracket_position: 0 },
      { id: 'f', round_number: 2, bracket_position: 1 },
    ];
    const l = computeDrawLayout(twoFinals, GEO);
    expect(l.mode).toBe('linear');
    // The halving still holds, so the lines are real and are still drawn.
    expect(l.connectors.length).toBeGreaterThan(0);
  });

  it('survives an empty draw', () => {
    const l = computeDrawLayout([], GEO);
    expect(l.nodes).toHaveLength(0);
    expect(l.width).toBe(0);
    expect(l.height).toBe(0);
  });

  it('reads rounds in play order however they are numbered', () => {
    // The knockout half of a pool_to_bracket event is generated by the same
    // code path and numbers its rounds from 1, but depth is the index in the
    // round list rather than round_number - 1, so a shifted numbering is fine.
    const shifted = drawOf(8).map((m) => ({ ...m, round_number: m.round_number + 10 }));
    const l = computeDrawLayout(shifted, GEO);
    expect(l.mode).toBe('converging');
    expect(l.rounds).toBe(3);
    expect(l.columns.map((c) => c.roundNumber)).toContain(11);
  });
});

describe('computeDrawLayout — the third-place playoff', () => {
  it('sits under the final in the centre column, joined to nothing', () => {
    const l = computeDrawLayout(drawOf(16), { ...GEO, playoffCaptionH: 60 }, { thirdPlace: true });
    const final = at(l, 'r4p0');
    expect(l.thirdPlace).not.toBeNull();
    expect(l.thirdPlace!.x).toBe(final.x);
    expect(l.thirdPlace!.y).toBeGreaterThan(final.y + GEO.cardH);
    // No line touches it: its two entrants are on OPPOSITE halves of a
    // converging draw, so there is no single path back to draw.
    expect(l.connectors.some((c) => c.dashed)).toBe(false);
  });

  it('makes room for the card and its caption', () => {
    const withOut = computeDrawLayout(drawOf(16), { ...GEO, playoffCaptionH: 60 });
    const withIt = computeDrawLayout(drawOf(16), { ...GEO, playoffCaptionH: 60 }, { thirdPlace: true });
    expect(withIt.bodyH).toBeGreaterThanOrEqual(withOut.bodyH);
    expect(withIt.bodyH).toBeGreaterThanOrEqual(withIt.thirdPlace!.y + GEO.cardH + 60);
  });

  it('still finds room on a four-entry draw, where the centre column is short', () => {
    const l = computeDrawLayout(drawOf(4), { ...GEO, playoffCaptionH: 60 }, { thirdPlace: true });
    expect(l.bodyH).toBeGreaterThanOrEqual(l.thirdPlace!.y + GEO.cardH + 60);
  });
});

describe('fitScale', () => {
  it('fits both axes, not just the width', () => {
    // A chart twice as tall as the box and only just too wide: fitting width
    // alone would report 0.9 and leave half of it off screen.
    expect(fitScale({ width: 1000, height: 2000 }, 900, 800)).toBeCloseTo(0.4, 6);
  });

  it('never magnifies', () => {
    expect(fitScale({ width: 100, height: 100 }, 900, 800)).toBe(1);
  });

  it('does not go below its floor', () => {
    expect(fitScale({ width: 100000, height: 100000 }, 900, 800, 0.25)).toBe(0.25);
  });

  it('is 1 before anything has been measured', () => {
    expect(fitScale({ width: 1000, height: 1000 }, 0, 0)).toBe(1);
  });
});
