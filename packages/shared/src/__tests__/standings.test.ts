import { describe, it, expect } from 'vitest';
import { sortStandings, type StandingEntry } from '../utils/standings';
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
