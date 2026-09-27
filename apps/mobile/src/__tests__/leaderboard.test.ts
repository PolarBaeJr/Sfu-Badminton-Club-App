import { describe, expect, it } from 'vitest';
import { LEADERBOARD_TABS, ladderPosition, rankLadder, type LadderRow } from '../lib/leaderboard';

const row = (id: string, status: string, singles: number | null, doubles: number | null): LadderRow => ({
  id,
  name: id,
  handle: null,
  status,
  singles_elo: singles,
  doubles_elo: doubles,
});

const rows = [
  row('a', 'recreational', 900, 1200),
  row('b', 'competitive', 1100, 1000),
  row('c', 'competitive', 1000, 1300),
  row('d', 'pending_approval', 1200, 900),
];

describe('rankLadder', () => {
  it('has the four web tabs, without tournament points', () => {
    expect(LEADERBOARD_TABS.map((t) => t.id)).toEqual(['open_singles', 'open_doubles', 'comp_singles', 'comp_doubles']);
  });

  it('open singles keeps everyone, highest singles Elo first', () => {
    expect(rankLadder(rows, 'open_singles').map((r) => [r.row.id, r.rank, r.elo])).toEqual([
      ['d', 1, 1200],
      ['b', 2, 1100],
      ['c', 3, 1000],
      ['a', 4, 900],
    ]);
  });

  it('open doubles sorts by doubles Elo', () => {
    expect(rankLadder(rows, 'open_doubles').map((r) => r.row.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('comp tabs keep only competitive members', () => {
    expect(rankLadder(rows, 'comp_singles').map((r) => r.row.id)).toEqual(['b', 'c']);
    expect(rankLadder(rows, 'comp_doubles').map((r) => [r.row.id, r.rank])).toEqual([
      ['c', 1],
      ['b', 2],
    ]);
  });

  it('numbers tied members by position, in the order they arrived', () => {
    const tied = [row('x', 'competitive', 400, 400), row('y', 'competitive', 400, 400), row('z', 'competitive', 500, 400)];
    expect(rankLadder(tied, 'open_singles').map((r) => [r.row.id, r.rank])).toEqual([
      ['z', 1],
      ['x', 2],
      ['y', 3],
    ]);
  });

  it('reads a missing Elo as zero rather than throwing', () => {
    expect(rankLadder([row('n', 'competitive', null, null), row('m', 'competitive', 1, 1)], 'open_singles')[1]?.row.id).toBe('n');
  });
});

describe('ladderPosition (RANK semantics)', () => {
  const ladder = [
    { id: 'a', singles_elo: 500 },
    { id: 'b', singles_elo: 400 },
    { id: 'c', singles_elo: 400 },
    { id: 'd', singles_elo: 400 },
    { id: 'e', singles_elo: 300 },
  ];

  it('tied members share a place', () => {
    expect(ladderPosition(ladder, 'b', 400)).toBe(2);
    expect(ladderPosition(ladder, 'd', 400)).toBe(2);
  });

  it('the member below a tie skips the tied places', () => {
    expect(ladderPosition(ladder, 'e', 300)).toBe(5);
  });

  it('the leader is first', () => {
    expect(ladderPosition(ladder, 'a', 500)).toBe(1);
  });

  it('is null, not last place, for a member the RPC left out', () => {
    expect(ladderPosition(ladder, 'hidden', 450)).toBeNull();
  });

  it('is null with no rating', () => {
    expect(ladderPosition(ladder, 'a', null)).toBeNull();
  });
});
