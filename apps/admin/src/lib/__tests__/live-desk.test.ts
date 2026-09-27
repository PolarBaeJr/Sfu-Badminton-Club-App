import { describe, it, expect } from 'vitest';
import {
  deskRows, nextCallable, deskCounts, buildEntryMaps, deskEventPlaying, hasCourtsTab,
  type DeskMatch,
} from '../live-desk';

function match(over: Partial<DeskMatch> & { id: string }): DeskMatch {
  return {
    status: 'pending',
    is_bye: false,
    phase: null,
    round_number: 1,
    match_number: null,
    bracket_position: 0,
    court: null,
    participant_a_id: null,
    participant_b_id: null,
    pair_a_id: null,
    pair_b_id: null,
    ...over,
  };
}

const sideOf = (entryId: string | null) => ({ entryId, label: entryId ?? 'TBD' });
const ids = (rows: Array<{ match: { id: string } }>) => rows.map((r) => r.match.id);

describe('deskRows', () => {
  it('keeps one order however the states change, so no row moves under the desk', () => {
    const before = [
      match({ id: 'm2', match_number: 2, participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'm1', match_number: 1, participant_a_id: 'c', participant_b_id: 'd' }),
      match({ id: 'm3', match_number: 3, participant_a_id: 'e' }),
    ];
    const after = before.map((m) =>
      m.id === 'm2' ? { ...m, status: 'live', court: '3' } : m.id === 'm3' ? { ...m, participant_b_id: 'f' } : m,
    );
    expect(ids(deskRows(before, sideOf, false))).toEqual(['m1', 'm2', 'm3']);
    expect(ids(deskRows(after, sideOf, false))).toEqual(['m1', 'm2', 'm3']);
  });

  it('puts the whole pool before the bracket although round_number restarts', () => {
    const rows = deskRows([
      match({ id: 'qf', phase: 'bracket', round_number: 1, match_number: 1 }),
      match({ id: 'pool3', phase: 'pool', round_number: 3, match_number: 1 }),
      match({ id: 'pool1', phase: 'pool', round_number: 1, match_number: 1 }),
    ], sideOf, false);
    expect(ids(rows)).toEqual(['pool1', 'pool3', 'qf']);
  });

  it('falls back to bracket_position where there is no match number', () => {
    const rows = deskRows([
      match({ id: 'p1', bracket_position: 1 }),
      match({ id: 'p0', bracket_position: 0 }),
    ], sideOf, false);
    expect(ids(rows)).toEqual(['p0', 'p1']);
  });

  it('reads a TBD side as waiting, both sides known as callable, and live as live', () => {
    const rows = deskRows([
      match({ id: 'w', match_number: 1, participant_a_id: 'a' }),
      match({ id: 'c', match_number: 2, participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'l', match_number: 3, status: 'live', participant_a_id: 'c', participant_b_id: 'd' }),
    ], sideOf, false);
    expect(rows.map((r) => r.state)).toEqual(['waiting', 'callable', 'live']);
  });

  it('reads the pair columns on a doubles event', () => {
    const rows = deskRows([
      match({ id: 'd', participant_a_id: 'x', participant_b_id: 'y', pair_a_id: 'p', pair_b_id: 'q' }),
    ], sideOf, true);
    expect(rows[0]!.a.entryId).toBe('p');
    expect(rows[0]!.b.entryId).toBe('q');
  });

  it('drops byes, voided matches and anything with a result', () => {
    const rows = deskRows([
      match({ id: 'bye', is_bye: true, status: 'completed', participant_a_id: 'a' }),
      match({ id: 'bye-pending', is_bye: true }),
      match({ id: 'void', status: 'voided', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'done', status: 'completed', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'wo', status: 'walkover', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'disputed', status: 'disputed', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'open', participant_a_id: 'a', participant_b_id: 'b' }),
    ], sideOf, false);
    expect(ids(rows)).toEqual(['open']);
  });
});

describe('nextCallable', () => {
  it('is the earliest callable row, never a live one', () => {
    const rows = deskRows([
      match({ id: 'l', match_number: 1, status: 'live', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'w', match_number: 2, participant_a_id: 'c' }),
      match({ id: 'c1', match_number: 3, participant_a_id: 'd', participant_b_id: 'e' }),
      match({ id: 'c2', match_number: 4, participant_a_id: 'f', participant_b_id: 'g' }),
    ], sideOf, false);
    expect(nextCallable(rows)?.match.id).toBe('c1');
  });

  it('is null when everything left is live or waiting', () => {
    const rows = deskRows([
      match({ id: 'l', status: 'live', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'w', match_number: 2 }),
    ], sideOf, false);
    expect(nextCallable(rows)).toBeNull();
  });
});

describe('deskCounts', () => {
  it('counts each state once and the uncourted across all of them', () => {
    const rows = deskRows([
      match({ id: 'l', match_number: 1, status: 'live', court: 'Court 2', participant_a_id: 'a', participant_b_id: 'b' }),
      match({ id: 'c', match_number: 2, court: '   ', participant_a_id: 'c', participant_b_id: 'd' }),
      match({ id: 'c2', match_number: 3, court: '4', participant_a_id: 'e', participant_b_id: 'f' }),
      match({ id: 'w', match_number: 4 }),
    ], sideOf, false);
    expect(deskCounts(rows)).toEqual({ live: 1, callable: 2, waiting: 1, uncourted: 2 });
  });

  it('is all zeroes on an empty list', () => {
    expect(deskCounts([])).toEqual({ live: 0, callable: 0, waiting: 0, uncourted: 0 });
  });
});

describe('buildEntryMaps', () => {
  const entries = [
    { id: 'z', seed_number: 2, status: 'registered', name: 'Zed' },
    { id: 'a', seed_number: null, status: 'checked_in', name: 'Ann' },
    { id: 'w', seed_number: 1, status: 'withdrawn', name: 'Wes' },
    { id: 'd', seed_number: 0, status: 'disqualified', name: 'Dee' },
  ];

  it('names every entry, seeds only the seeded, and places only those still in', () => {
    const { nameMap, seedMap, placeableEntries } = buildEntryMaps(entries, (e) => e.name);
    expect(nameMap).toEqual({ z: 'Zed', a: 'Ann', w: 'Wes', d: 'Dee' });
    expect(seedMap).toEqual({ z: 2, w: 1 });
    expect(placeableEntries).toEqual([{ id: 'a', name: 'Ann' }, { id: 'z', name: 'Zed' }]);
  });
});

describe('the event-level predicates', () => {
  it('lets the desk score across both halves of a pool_to_bracket event', () => {
    expect(deskEventPlaying('pool_generated')).toBe(true);
    expect(deskEventPlaying('bracket_generated')).toBe(true);
    expect(deskEventPlaying('live')).toBe(true);
    expect(deskEventPlaying('completed')).toBe(false);
    expect(deskEventPlaying('checkin')).toBe(false);
  });

  it('offers the courts tab only on a drawn event that is not finished', () => {
    expect(hasCourtsTab('live')).toBe(true);
    expect(hasCourtsTab('completed')).toBe(false);
    expect(hasCourtsTab('registration')).toBe(false);
  });
});
