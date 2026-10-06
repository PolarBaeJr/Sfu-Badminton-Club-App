import { describe, it, expect } from 'vitest';
import {
  busyCourtIds,
  courtKey,
  courtLabel,
  courtLabelIssues,
  courtsInOrder,
  nextCourtFree,
  parseCourtList,
  resolveCourtLabels,
  type TournamentCourt,
} from '../match-court';

const court = (id: string, label: string, sort_order: number, active = true): TournamentCourt =>
  ({ id, label, sort_order, active });

const COURTS = [
  court('c3', '3', 3),
  court('c1', '1', 1),
  court('c2', 'Court 2', 2),
  court('cx', 'Centre', 4, false),
];

describe('courtKey', () => {
  it('treats "Court 3", "court 3" and "3" as one court', () => {
    expect(courtKey('Court 3')).toBe('3');
    expect(courtKey('  court   3 ')).toBe('3');
    expect(courtKey('3')).toBe('3');
    expect(courtKey('Courts: 3')).toBe('3');
  });

  it('keeps a word that only starts with court', () => {
    expect(courtKey('Courtyard 2')).toBe('courtyard 2');
    expect(courtLabel('Courtyard 2')).toBe('Court Courtyard 2');
  });

  it('is empty for nothing', () => {
    expect(courtKey(null)).toBe('');
    expect(courtKey('   ')).toBe('');
  });

  it('keeps a bare "Court" as itself', () => {
    expect(courtKey('Court')).toBe('court');
  });
});

describe('courtsInOrder', () => {
  it('orders by sort_order, then label numerically', () => {
    expect(courtsInOrder(COURTS).map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'cx']);
    const tied = [court('a', '10', 0), court('b', '9', 0)];
    expect(courtsInOrder(tied).map((c) => c.label)).toEqual(['9', '10']);
  });
});

describe('courtLabelIssues', () => {
  it('passes a clean list', () => {
    expect(courtLabelIssues(['1', '2', 'Centre'])).toEqual([]);
  });

  it('refuses an empty name and one over 20 characters', () => {
    expect(courtLabelIssues(['  '])).toEqual(['A court needs a name.']);
    expect(courtLabelIssues(['x'.repeat(21)])[0]).toMatch(/longer than 20/);
  });

  it('refuses the same court twice, by key', () => {
    expect(courtLabelIssues(['3', 'Court 3'])).toEqual(['Court 3 is listed twice.']);
  });

  it('refuses a court the tournament already has', () => {
    expect(courtLabelIssues(['court 2'], ['Court 2'])).toEqual(['There is already a court called Court 2.']);
  });
});

describe('parseCourtList', () => {
  it('expands a range either way round', () => {
    expect(parseCourtList('1-4')).toEqual(['1', '2', '3', '4']);
    expect(parseCourtList('3 - 1')).toEqual(['3', '2', '1']);
  });

  it('takes a comma list and mixes in ranges', () => {
    expect(parseCourtList('1, 2, Centre, 5-6,,')).toEqual(['1', '2', 'Centre', '5', '6']);
  });

  it('leaves an over-long range as typed', () => {
    expect(parseCourtList('1-100')).toEqual(['1-100']);
  });
});

describe('resolveCourtLabels', () => {
  it('matches active courts by key and lists the rest once', () => {
    const { byLabel, unknown } = resolveCourtLabels(COURTS, ['1', 'Court 3', '2', '9', '9', 'Centre']);
    expect(byLabel.get('1')?.id).toBe('c1');
    expect(byLabel.get('Court 3')?.id).toBe('c3');
    expect(byLabel.get('2')?.id).toBe('c2');
    // Centre is switched off, so it does not resolve.
    expect(unknown).toEqual(['9', 'Centre']);
  });
});

describe('busyCourtIds', () => {
  it('counts linked matches by id and text-only matches by key', () => {
    const busy = busyCourtIds(COURTS, [
      { court_id: 'c1', court: '1' },
      { court_id: null, court: 'Court 3' },
      { court: 'Somewhere else' },
    ]);
    expect([...busy].sort()).toEqual(['c1', 'c3']);
  });
});

describe('nextCourtFree', () => {
  it('takes the preferred court when it is free, else the first free active one', () => {
    expect(nextCourtFree(COURTS, new Set(), 'c3')?.id).toBe('c3');
    expect(nextCourtFree(COURTS, new Set(['c3']), 'c3')?.id).toBe('c1');
    expect(nextCourtFree(COURTS, new Set(['c1']))?.id).toBe('c2');
  });

  it('never offers a switched-off court, and is null when all are busy', () => {
    expect(nextCourtFree(COURTS, new Set(['c1', 'c2', 'c3']))).toBeNull();
    expect(nextCourtFree(COURTS, new Set(), 'cx')?.id).toBe('c1');
  });
});
