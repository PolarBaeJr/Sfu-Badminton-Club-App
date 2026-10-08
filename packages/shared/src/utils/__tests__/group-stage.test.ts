import { describe, it, expect } from 'vitest';
import {
  qualificationOrder,
  snakeGroupAssignment,
  sortStandings,
  type GroupedStandingEntry,
} from '../standings';

// The pure half of the group stage (00106): how a field is dealt into groups,
// and how the finished groups are read as one ordered list. Both decide who
// plays whom, and neither needs a database to be wrong.

function entry(over: Partial<GroupedStandingEntry> & { id: string }): GroupedStandingEntry {
  return {
    wins: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    gamesFor: 0,
    gamesAgainst: 0,
    h2h: {},
    group: null,
    ...over,
  };
}

describe('snakeGroupAssignment', () => {
  it('deals the first pass left to right and the second right to left', () => {
    // Seeds 1-4 to A,B,C,D; seeds 5-8 back to D,C,B,A. This IS the format —
    // straight dealing would put 1 and 5 together and 4 and 8 together.
    expect(snakeGroupAssignment(8, 4)).toEqual([1, 2, 3, 4, 4, 3, 2, 1]);
  });

  it('keeps the total seed weight of every group within one of the others', () => {
    // THE PROPERTY THE FORMAT EXISTS FOR, asserted as an inequality rather than
    // as a fixed array, so it holds for the sizes nobody wrote a case for.
    for (const groups of [2, 3, 4, 5, 6, 7, 8]) {
      for (let count = groups; count <= groups * 6; count++) {
        const plan = snakeGroupAssignment(count, groups);
        const weight = new Array<number>(groups).fill(0);
        plan.forEach((g, i) => { weight[g - 1]! += i + 1; });
        const sizes = new Array<number>(groups).fill(0);
        for (const g of plan) sizes[g - 1]!++;
        // Sizes differ by at most one — that is just dealing.
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
        // And the seed weight per ENTRANT differs by less than one full seed,
        // which is what "balanced" means once the sizes are allowed to differ.
        const perEntrant = weight.map((w, i) => w / Math.max(1, sizes[i]!));
        expect(Math.max(...perEntrant) - Math.min(...perEntrant)).toBeLessThan(groups);
      }
    }
  });

  it('never puts the top `groups` seeds together', () => {
    // The failure mode named in the brief: seeds 1-4 in one group makes the
    // whole format pointless.
    for (const groups of [2, 3, 4, 5, 6]) {
      const plan = snakeGroupAssignment(groups * 4, groups);
      expect(new Set(plan.slice(0, groups)).size).toBe(groups);
    }
  });

  it('is a flat round robin when there is one group', () => {
    expect(snakeGroupAssignment(5, 1)).toEqual([1, 1, 1, 1, 1]);
    expect(snakeGroupAssignment(5, 0)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('qualificationOrder', () => {
  const groupOf = (g: number, wins: number, id: string, pf = 0) =>
    entry({ id, group: g, wins, losses: 3 - wins, pointsFor: pf, gamesFor: wins, gamesAgainst: 3 - wins });

  it('puts every group winner ahead of every runner-up', () => {
    const rows = [
      groupOf(1, 3, 'a1'), groupOf(1, 2, 'a2'), groupOf(1, 0, 'a3'),
      groupOf(2, 3, 'b1'), groupOf(2, 1, 'b2'), groupOf(2, 0, 'b3'),
      groupOf(3, 2, 'c1'), groupOf(3, 1, 'c2'), groupOf(3, 0, 'c3'),
    ];
    const order = qualificationOrder(rows, 'wins').map(r => r.id);
    // Winners (in some order), then runners-up, then thirds.
    expect(new Set(order.slice(0, 3))).toEqual(new Set(['a1', 'b1', 'c1']));
    expect(new Set(order.slice(3, 6))).toEqual(new Set(['a2', 'b2', 'c2']));
    expect(new Set(order.slice(6, 9))).toEqual(new Set(['a3', 'b3', 'c3']));
  });

  it('does NOT let a strong runner-up outrank a weak group winner', () => {
    // The ordering is the whole reason to run groups: c1 won group C on two
    // wins and a2 came second in group A on two wins. Flat ranking would put
    // them level and the tiebreak would decide; qualification order puts the
    // group winner in the top tier, full stop.
    const rows = [
      groupOf(1, 3, 'a1'), groupOf(1, 2, 'a2'),
      groupOf(3, 2, 'c1'), groupOf(3, 0, 'c2'),
    ];
    const order = qualificationOrder(rows, 'wins').map(r => r.id);
    expect(order.indexOf('c1')).toBeLessThan(order.indexOf('a2'));
    // Whereas the flat comparator — correctly, for a flat event — does not.
    const flat = sortStandings(rows, 'wins').map(r => r.id);
    expect(flat.indexOf('a2')).toBeLessThan(flat.indexOf('c1'));
  });

  it('ranks unequal groups by rate, not by raw wins', () => {
    // 24 in 5 groups is 5,5,5,5,4. A 4-0 record in the small group beats a 4-1
    // in a large one; raw wins would call them equal and hand the tiebreak to
    // whoever happened to be handed an extra fixture.
    const big = entry({ id: 'big', group: 1, wins: 4, losses: 1, gamesFor: 8, gamesAgainst: 4 });
    const small = entry({ id: 'small', group: 2, wins: 4, losses: 0, gamesFor: 8, gamesAgainst: 2 });
    const order = qualificationOrder([big, small], 'wins').map(r => r.id);
    expect(order[0]).toBe('small');
  });

  it('carries the finishing place inside the group', () => {
    const rows = [
      groupOf(1, 3, 'a1'), groupOf(1, 1, 'a2'), groupOf(1, 0, 'a3'),
      groupOf(2, 3, 'b1'), groupOf(2, 1, 'b2'),
    ];
    const byId = Object.fromEntries(qualificationOrder(rows, 'wins').map(r => [r.id, r.groupRank]));
    expect(byId).toEqual({ a1: 1, b1: 1, a2: 2, b2: 2, a3: 3 });
  });

  it('does not let a shallow group pull its finishers up a tier', () => {
    // Group B has two members and group A has three. B's runner-up must not be
    // promoted into the winners' tier just because B has nobody at depth 3.
    const rows = [
      groupOf(1, 3, 'a1'), groupOf(1, 2, 'a2'), groupOf(1, 0, 'a3'),
      groupOf(2, 3, 'b1'), groupOf(2, 0, 'b2'),
    ];
    const order = qualificationOrder(rows, 'wins').map(r => r.id);
    expect(new Set(order.slice(0, 2))).toEqual(new Set(['a1', 'b1']));
    expect(new Set(order.slice(2, 4))).toEqual(new Set(['a2', 'b2']));
    expect(order[4]).toBe('a3');
  });

  it('ranks an ungrouped entry rather than dropping it', () => {
    const rows = [groupOf(1, 3, 'a1'), entry({ id: 'orphan', wins: 1, losses: 1 })];
    expect(qualificationOrder(rows, 'wins').map(r => r.id).sort()).toEqual(['a1', 'orphan']);
  });

  it('does not depend on the order the rows arrived in', () => {
    const rows = [
      groupOf(1, 3, 'a1'), groupOf(1, 1, 'a2'),
      groupOf(2, 2, 'b1'), groupOf(2, 0, 'b2'),
      groupOf(3, 3, 'c1'), groupOf(3, 1, 'c2'),
    ];
    const forward = qualificationOrder(rows, 'wins').map(r => r.id);
    const backward = qualificationOrder([...rows].reverse(), 'wins').map(r => r.id);
    expect(backward).toEqual(forward);
  });
});
