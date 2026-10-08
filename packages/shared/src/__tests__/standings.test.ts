import { describe, it, expect } from 'vitest';
import {
  sortStandings,
  tallyRoundRobin,
  rankRoundRobin,
  poolQualifierCount,
  type StandingEntry,
  type TallyEntry,
  type TallyMatch,
} from '../utils/standings';
import { getEventRules, describeMatchShape, hasTypedFormat } from '../utils/constants';

// A pool entry with everything at zero, so each test only states the figures it
// is actually about.
function entry(id: string, over: Partial<StandingEntry> = {}): StandingEntry {
  return {
    id,
    wins: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    gamesFor: 0,
    gamesAgainst: 0,
    h2h: {},
    ...over,
  };
}

const ids = (rows: StandingEntry[]) => rows.map((r) => r.id);

describe('sortStandings — seeding a bracket off a pool', () => {
  it('ranks by wins by default', () => {
    const rows = [
      entry('c', { wins: 1, pointsFor: 90 }),
      entry('a', { wins: 3, pointsFor: 40 }),
      entry('b', { wins: 2, pointsFor: 60 }),
    ];
    expect(ids(sortStandings(rows))).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing seed_by as wins — NULL in the database is not "no order"', () => {
    const rows = [entry('a', { wins: 1 }), entry('b', { wins: 2 })];
    expect(ids(sortStandings(rows, null))).toEqual(['b', 'a']);
    expect(ids(sortStandings(rows, undefined))).toEqual(['b', 'a']);
  });

  it('ranks by points scored when asked, even where that disagrees with wins', () => {
    const rows = [
      entry('a', { wins: 3, pointsFor: 40 }),
      entry('b', { wins: 2, pointsFor: 60 }),
      entry('c', { wins: 1, pointsFor: 90 }),
    ];
    expect(ids(sortStandings(rows, 'wins'))).toEqual(['a', 'b', 'c']);
    expect(ids(sortStandings(rows, 'points'))).toEqual(['c', 'b', 'a']);
  });

  it('breaks a tie on head-to-head before any differential', () => {
    // Equal wins, and b has the worse differentials — but b beat a, and that
    // decides it between exactly those two.
    const rows = [
      entry('a', { wins: 2, gamesFor: 4, gamesAgainst: 1, pointsFor: 80, pointsAgainst: 40 }),
      entry('b', { wins: 2, gamesFor: 3, gamesAgainst: 3, pointsFor: 70, pointsAgainst: 60, h2h: { a: 1 } }),
    ];
    expect(ids(sortStandings(rows, 'wins'))).toEqual(['b', 'a']);
  });

  it('falls through head-to-head to games, then points differential', () => {
    const rows = [
      entry('a', { wins: 2, gamesFor: 3, gamesAgainst: 2, pointsFor: 60, pointsAgainst: 55 }),
      entry('b', { wins: 2, gamesFor: 4, gamesAgainst: 1, pointsFor: 50, pointsAgainst: 45 }),
      entry('c', { wins: 2, gamesFor: 3, gamesAgainst: 2, pointsFor: 70, pointsAgainst: 50 }),
    ];
    // b on games differential, then c over a on points differential.
    expect(ids(sortStandings(rows, 'wins'))).toEqual(['b', 'c', 'a']);
  });

  it('uses the same tiebreak chain when seeding by points', () => {
    const rows = [
      entry('a', { wins: 0, pointsFor: 60, pointsAgainst: 55, gamesFor: 1, gamesAgainst: 2 }),
      entry('b', { wins: 3, pointsFor: 60, pointsAgainst: 40, gamesFor: 3, gamesAgainst: 0 }),
    ];
    // Level on points scored, so the chain decides — games differential first.
    expect(ids(sortStandings(rows, 'points'))).toEqual(['b', 'a']);
  });

  it('does not reorder the array it was given', () => {
    const rows = [entry('a', { wins: 1 }), entry('b', { wins: 5 })];
    sortStandings(rows, 'wins');
    expect(ids(rows)).toEqual(['a', 'b']);
  });

  it('takes the whole pool when it is shorter than the bracket — top N is a cap, not a quota', () => {
    const rows = [entry('a', { wins: 2 }), entry('b', { wins: 1 }), entry('c', { wins: 0 })];
    expect(ids(sortStandings(rows, 'wins').slice(0, 8))).toEqual(['a', 'b', 'c']);
  });
});

describe('event match format resolution', () => {
  it('falls back to the match_format enum when nothing is typed', () => {
    expect(getEventRules({ match_format: 'one_game_15' })).toEqual({ bestOf: 1, target: 15, cap: 24 });
    expect(getEventRules({ match_format: 'best_of_3_to_21' })).toEqual({ bestOf: 3, target: 21, cap: 30 });
  });

  it('treats explicit nulls as absent — that is what an untouched row holds', () => {
    expect(getEventRules({ match_format: 'one_game_11', games_per_match: null, points_per_game: null }))
      .toEqual({ bestOf: 1, target: 11, cap: 20 });
    expect(hasTypedFormat({ match_format: 'one_game_11', games_per_match: null })).toBe(false);
  });

  it('prefers the typed shape over the enum', () => {
    // The enum still says best of 3 to 21; the typed shape is what is played.
    expect(getEventRules({ match_format: 'best_of_3_to_21', games_per_match: 1, points_per_game: 15 }))
      .toEqual({ bestOf: 1, target: 15, cap: 24 });
    expect(hasTypedFormat({ match_format: 'best_of_3_to_21', games_per_match: 1, points_per_game: 15 })).toBe(true);
  });

  it('lets one typed column override on its own, with the enum supplying the other', () => {
    expect(getEventRules({ match_format: 'one_game_21', points_per_game: 9 }))
      .toEqual({ bestOf: 1, target: 9, cap: 18 });
    expect(getEventRules({ match_format: 'one_game_21', games_per_match: 5 }))
      .toEqual({ bestOf: 5, target: 21, cap: 30 });
  });

  it('labels a typed shape the same way the presets are labelled', () => {
    expect(describeMatchShape({ match_format: 'best_of_3_to_21' })).toBe('Best of 3 to 21');
    expect(describeMatchShape({ match_format: 'one_game_15' })).toBe('1 Game to 15');
    expect(describeMatchShape({ match_format: 'best_of_3_to_21', games_per_match: 5, points_per_game: 15 }))
      .toBe('Best of 5 to 15');
  });
});

// Four invented teams where head-to-head decides a tie on wins and the point
// difference says the opposite. Kestrel and Heron both win twice; Kestrel beat
// Heron, Heron has the far better margin.
const teams: TallyEntry[] = [
  { id: 'kestrel', name: 'Team Kestrel', group: null, out: false },
  { id: 'heron', name: 'Team Heron', group: null, out: false },
  { id: 'osprey', name: 'Team Osprey', group: null, out: false },
  { id: 'plover', name: 'Team Plover', group: null, out: false },
];
const played = (sideA: string, sideB: string, a: number, b: number, status = 'completed'): TallyMatch => ({
  status, sideA, sideB, winner: a > b ? sideA : sideB, scores: [{ a, b }],
});
const results: TallyMatch[] = [
  played('kestrel', 'heron', 21, 19),
  played('heron', 'osprey', 21, 5),
  played('osprey', 'kestrel', 21, 19),
  played('kestrel', 'plover', 21, 19),
  played('heron', 'plover', 21, 5),
  played('plover', 'osprey', 21, 18),
];
const order = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('tallyRoundRobin and rankRoundRobin, the one order the server and the admin table share', () => {
  it('tallies wins, points, games and head-to-head', () => {
    const rows = tallyRoundRobin(teams, results);
    const kestrel = rows.find((r) => r.id === 'kestrel')!;
    expect(kestrel).toMatchObject({
      name: 'Team Kestrel', wins: 2, losses: 1, pointsFor: 61, pointsAgainst: 59, gamesFor: 2, gamesAgainst: 1,
    });
    expect(kestrel.h2h).toEqual({ heron: 1, plover: 1 });
  });

  it('lets head-to-head decide a tie on wins, where wins-then-difference would not', () => {
    const ranked = rankRoundRobin(tallyRoundRobin(teams, results), { seedBy: 'wins', grouped: false, external: false });
    expect(order(ranked)).toEqual(['kestrel', 'heron', 'plover', 'osprey']);
    expect(ranked.map((r) => r.groupRank)).toEqual([1, 2, 3, 4]);

    // The order the admin table used to show, for contrast: it put Heron first.
    const old = [...tallyRoundRobin(teams, results)].sort((a, b) =>
      b.wins - a.wins || (b.pointsFor - b.pointsAgainst) - (a.pointsFor - a.pointsAgainst));
    expect(old[0]!.id).toBe('heron');
  });

  it('matches sortStandings on a flat pool, which is what the server ranked by', () => {
    const tallied = tallyRoundRobin(teams, results);
    expect(order(rankRoundRobin(tallied, { seedBy: 'wins', grouped: false, external: false })))
      .toEqual(order(sortStandings(tallied, 'wins')));
  });

  it('drops head-to-head and game difference on an external event, keeping the real figures', () => {
    const ranked = rankRoundRobin(tallyRoundRobin(teams, results), { seedBy: 'wins', grouped: false, external: true });
    expect(order(ranked)).toEqual(['heron', 'kestrel', 'plover', 'osprey']);
    expect(ranked.find((r) => r.id === 'kestrel')!.h2h).toEqual({ heron: 1, plover: 1 });
    expect(ranked.find((r) => r.id === 'kestrel')!.gamesFor).toBe(2);
  });

  it('counts only completed and walkover matches', () => {
    const extra = [...results, played('osprey', 'heron', 21, 0, 'voided'), played('osprey', 'heron', 21, 0, 'pending')];
    expect(tallyRoundRobin(teams, extra)).toEqual(tallyRoundRobin(teams, results));
    const walkover: TallyMatch = { status: 'walkover', sideA: 'osprey', sideB: 'heron', winner: 'osprey', scores: null };
    const osprey = tallyRoundRobin(teams, [...results, walkover]).find((r) => r.id === 'osprey')!;
    expect(osprey.wins).toBe(2);
    expect(osprey.pointsFor).toBe(44);
  });

  it('counts a withdrawn entry in its opponents records but does not rank it', () => {
    const withdrawn = teams.map((t) => (t.id === 'osprey' ? { ...t, out: true } : t));
    const rows = tallyRoundRobin(withdrawn, results);
    expect(order(rows)).not.toContain('osprey');
    expect(rows.find((r) => r.id === 'heron')!.wins).toBe(2);
  });

  it('reads a group stage as winners first, each row knowing its place in its group', () => {
    const grouped: TallyEntry[] = [
      ...teams.map((t) => ({ ...t, group: 1 })),
      { id: 'egret', name: 'Team Egret', group: 2, out: false },
      { id: 'finch', name: 'Team Finch', group: 2, out: false },
    ];
    const ranked = rankRoundRobin(
      tallyRoundRobin(grouped, [...results, played('egret', 'finch', 21, 10)]),
      { seedBy: 'wins', grouped: true, external: false },
    );
    expect(ranked.filter((r) => r.group === 1).map((r) => r.id)).toEqual(['kestrel', 'heron', 'plover', 'osprey']);
    expect(ranked.slice(0, 2).map((r) => r.groupRank)).toEqual([1, 1]);
  });
});

describe('poolQualifierCount', () => {
  it('defaults to 2 per group on a group stage and 4 on a flat pool', () => {
    expect(poolQualifierCount(4, null)).toBe(8);
    expect(poolQualifierCount(null, null)).toBe(4);
    expect(poolQualifierCount(1, null)).toBe(4);
  });

  it('uses qualifiers_per_group when it is set', () => {
    expect(poolQualifierCount(3, 1)).toBe(3);
    expect(poolQualifierCount(1, 6)).toBe(6);
  });
});
