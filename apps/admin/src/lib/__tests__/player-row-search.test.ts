import { describe, it, expect } from 'vitest';
// Straight at the module rather than the '@badminton/ui' barrel: the barrel
// pulls in every component, and a node test has no business transforming JSX
// to check a string-matching function. This is the same code the barrel
// re-exports.
import { filterRowsByPlayers, filterPlayerOptions } from '@badminton/ui/src/player-search';

/**
 * The search behind /challenges and /matches. These rows are about two SIDES,
 * so the interesting questions are all about which of several names can pull a
 * row into view — and about what the shared matching must NOT do to the order
 * the page fetched them in.
 */

const row = (id: string, players: string[], meta?: string) => ({ id, players, meta });

// Newest first, as both admin pages fetch them.
const rows = [
  row('m1', ['Alice Chen', 'Bob Lee']),
  row('m2', ['Carol Ng', 'Dave Chen']),
  row('m3', ['Alice Chen', 'Carol Ng', 'Bob Lee', 'Dave Chen']),
  row('m4', ['Erin Park', 'Frank Wu']),
];

const ids = (rs: { id: string }[]) => rs.map((r) => r.id);

describe('filterRowsByPlayers', () => {
  it('matches on either side, not just the first', () => {
    // Bob is second on m1 and third on m3.
    expect(ids(filterRowsByPlayers(rows, 'Bob'))).toEqual(['m1', 'm3']);
  });

  it('matches a partner as readily as an opponent', () => {
    // Carol partners Dave on m2 and is one of four on m3.
    expect(ids(filterRowsByPlayers(rows, 'Carol'))).toEqual(['m2', 'm3']);
  });

  it('matches a surname shared by two people, on every row either appears', () => {
    expect(ids(filterRowsByPlayers(rows, 'Chen'))).toEqual(['m1', 'm2', 'm3']);
  });

  it('matches a full name that is not the first on the row', () => {
    expect(ids(filterRowsByPlayers(rows, 'Dave Chen'))).toEqual(['m2', 'm3']);
  });

  it('PRESERVES the caller order — these lists are newest-first and that is information', () => {
    // 'Chen' hits m1 by word-prefix on the FIRST name and m2 only on the
    // second, which is where a ranking filter would reorder them. It must not.
    const out = ids(filterRowsByPlayers(rows, 'Chen'));
    expect(out).toEqual([...out].sort((a, b) => rows.findIndex(r => r.id === a) - rows.findIndex(r => r.id === b)));
  });

  it('does NOT match the connectives a row displays', () => {
    // The "&" and "vs" on screen are not in the search key. If they were,
    // typing either would return every doubles row on the page.
    expect(filterRowsByPlayers(rows, 'vs')).toEqual([]);
    expect(filterRowsByPlayers(rows, '&')).toEqual([]);
  });

  it('does not run names together across the join', () => {
    // "Alice Chen" + "Bob Lee" must not become searchable as "chenbob".
    expect(filterRowsByPlayers(rows, 'ChenBob')).toEqual([]);
  });

  it('returns everything for an empty or whitespace query', () => {
    expect(ids(filterRowsByPlayers(rows, ''))).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(ids(filterRowsByPlayers(rows, '   '))).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(ids(filterRowsByPlayers(rows, '  aLiCe  '))).toEqual(['m1', 'm3']);
  });

  it('falls back to meta, as the picker does', () => {
    const withMeta = [row('x', ['Zed Kim'], 'zed@sfu.ca'), row('y', ['Amy Poon'], 'amy@sfu.ca')];
    expect(ids(filterRowsByPlayers(withMeta, 'amy@sfu'))).toEqual(['y']);
  });

  it('tolerates a row with no names at all', () => {
    const sparse = [row('empty', []), row('named', ['Alice Chen'])];
    expect(ids(filterRowsByPlayers(sparse, 'Alice'))).toEqual(['named']);
  });

  it('agrees with the picker on which single-player rows match', () => {
    // The anti-drift property: same query, same verdict, one implementation.
    const people = [
      { id: 'p1', name: 'Alice Chen' },
      { id: 'p2', name: 'Dave Chen' },
      { id: 'p3', name: 'Erin Park' },
    ];
    const viaPicker = new Set(filterPlayerOptions(people, 'chen').map((p) => p.id));
    const viaRows = new Set(
      filterRowsByPlayers(people.map((p) => ({ id: p.id, players: [p.name] })), 'chen').map((r) => r.id)
    );
    expect(viaRows).toEqual(viaPicker);
  });
});

/**
 * Searching by handle. The handle is the member's ONE chosen name — the thing
 * the club writes as `@kiera` — so it is matched with the same ranking as the
 * real name rather than as a `meta` fallback, and it is found with or without
 * the `@`.
 */
describe('filterPlayerOptions by handle', () => {
  const people = [
    { id: 'p1', name: 'Akierabayashi Sato', handle: 'sato' },
    { id: 'p2', name: 'Kiera Watanabe', handle: 'kiera' },
    { id: 'p3', name: 'Erin Park', handle: null },
    { id: 'p4', name: 'Matthew Cheng', handle: 'matthew_43', meta: 'm@example.com' },
  ];
  const found = (q: string) => filterPlayerOptions(people, q).map((p) => p.id);

  it('finds a member by their handle', () => {
    expect(found('matthew_43')).toEqual(['p4']);
  });

  it('treats @kiera and kiera as the same search', () => {
    expect(found('@kiera')).toEqual(found('kiera'));
  });

  // The reason the handle is not simply folded into `meta`: a meta match ranks
  // below every name match, so the person whose handle IS the query would have
  // been listed under someone who merely contains it.
  it('ranks an exact handle above a name that only contains the query', () => {
    expect(found('kiera')).toEqual(['p2', 'p1']);
  });

  it('leaves a member with no handle matchable by name', () => {
    expect(found('erin')).toEqual(['p3']);
  });

  it('still falls back to meta, and still ranks it last', () => {
    expect(found('example.com')).toEqual(['p4']);
  });

  it('a query of nothing but @ is an empty query', () => {
    expect(found('@')).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
});
