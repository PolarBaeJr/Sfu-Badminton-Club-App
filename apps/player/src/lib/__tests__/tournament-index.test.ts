import { describe, expect, it } from 'vitest';
import {
  countEnteredPlayers,
  describeDisciplines,
  isUpcoming,
  ordinalPlacing,
  pickHeroTournament,
  resultMonth,
  soleEnterableEvent,
  spotsLeft,
  type IndexEvent,
  type IndexTournament,
} from '@/lib/tournament-index';

const event = (over: Partial<IndexEvent> = {}): IndexEvent => ({
  id: 'e1',
  event_type: 'open_singles',
  status: 'registration',
  max_participants: null,
  ...over,
});

const tournament = (over: Partial<IndexTournament> = {}): IndexTournament => ({
  id: 't1',
  name: 'Winter Open',
  start_date: '2026-02-07',
  status: 'active',
  suspended_at: null,
  tournament_events: [event()],
  ...over,
});

describe('pickHeroTournament', () => {
  it('leads with the nearest tournament that is taking entries', () => {
    const near = tournament({ id: 'near', start_date: '2026-02-07' });
    const far = tournament({ id: 'far', start_date: '2026-03-20' });
    expect(pickHeroTournament([far, near])?.id).toBe('near');
  });

  it('ignores a tournament whose events have all closed', () => {
    const closed = tournament({ tournament_events: [event({ status: 'live' })] });
    expect(pickHeroTournament([closed])).toBeNull();
  });

  it('ignores a suspended tournament — the server would refuse the entry anyway', () => {
    const suspended = tournament({ suspended_at: '2026-01-30T00:00:00Z' });
    expect(pickHeroTournament([suspended])).toBeNull();
  });

  it('returns null when there is nothing open', () => {
    expect(pickHeroTournament([])).toBeNull();
  });
});

describe('describeDisciplines', () => {
  it('names both when the tournament runs both', () => {
    expect(describeDisciplines([event({ event_type: 'mens_singles' }), event({ event_type: 'mixed_doubles' })]))
      .toBe('SINGLES + DOUBLES');
  });

  it('names just the one it runs', () => {
    expect(describeDisciplines([event({ event_type: 'womens_doubles' })])).toBe('DOUBLES');
    expect(describeDisciplines([event({ event_type: 'open_singles' })])).toBe('SINGLES');
  });

  it('says so rather than rendering an empty string when there are no events', () => {
    expect(describeDisciplines([])).toBe('NO EVENTS YET');
  });
});

describe('countEnteredPlayers', () => {
  it('counts people, not rows — a pair is two players', () => {
    const n = countEnteredPlayers(
      [{ player_id: 'a', status: 'registered' }],
      [{ player1_id: 'b', player2_id: 'c', status: 'registered' }],
    );
    expect(n).toBe(3);
  });

  it('counts someone entered in both singles and doubles once', () => {
    const n = countEnteredPlayers(
      [{ player_id: 'a', status: 'registered' }],
      [{ player1_id: 'a', player2_id: 'b', status: 'registered' }],
    );
    expect(n).toBe(2);
  });

  it('drops withdrawn and disqualified entries, matching the server capacity rule', () => {
    const n = countEnteredPlayers(
      [
        { player_id: 'a', status: 'registered' },
        { player_id: 'b', status: 'withdrawn' },
        { player_id: 'c', status: 'disqualified' },
        { player_id: 'd', status: 'checked_in' },
      ],
      [{ player1_id: 'e', player2_id: 'f', status: 'withdrawn' }],
    );
    expect(n).toBe(2);
  });
});

describe('spotsLeft', () => {
  it('answers when exactly one capped singles event is taking entries', () => {
    const e = event({ id: 'solo', max_participants: 16 });
    const entries = Array.from({ length: 10 }, (_, i) => ({ event_id: 'solo', status: 'registered', _i: i }));
    expect(spotsLeft([e], entries)).toBe(6);
  });

  it('refuses when two events are open — "the cap" is then ambiguous', () => {
    const a = event({ id: 'a', max_participants: 16 });
    const b = event({ id: 'b', event_type: 'mixed_doubles', max_participants: 8 });
    expect(spotsLeft([a, b], [])).toBeNull();
  });

  it('refuses for a doubles event — a member has no way to take that place', () => {
    const d = event({ event_type: 'open_doubles', max_participants: 8 });
    expect(spotsLeft([d], [])).toBeNull();
  });

  it('refuses when the event carries no cap', () => {
    expect(spotsLeft([event({ max_participants: null })], [])).toBeNull();
  });

  it('ignores withdrawn entries, so a withdrawal really does free a place', () => {
    const e = event({ id: 'solo', max_participants: 4 });
    expect(spotsLeft([e], [
      { event_id: 'solo', status: 'registered' },
      { event_id: 'solo', status: 'withdrawn' },
    ])).toBe(3);
  });

  it('never goes negative if an over-full event is somehow written', () => {
    const e = event({ id: 'solo', max_participants: 2 });
    expect(spotsLeft([e], [
      { event_id: 'solo', status: 'registered' },
      { event_id: 'solo', status: 'registered' },
      { event_id: 'solo', status: 'registered' },
    ])).toBe(0);
  });
});

describe('soleEnterableEvent', () => {
  it('finds the one singles event a member could enter', () => {
    expect(soleEnterableEvent([event({ id: 'x' })])?.id).toBe('x');
  });

  it('declines when a doubles event is the only one open — it is admin managed', () => {
    expect(soleEnterableEvent([event({ event_type: 'womens_doubles' })])).toBeNull();
  });

  it('declines when there is a choice to make', () => {
    expect(soleEnterableEvent([event({ id: 'a' }), event({ id: 'b' })])).toBeNull();
  });
});

describe('ordinalPlacing', () => {
  it('renders the positions finalize.ts actually writes', () => {
    // 1 champion, 2 beaten finalist, 3 joint semi-final losers, 5 joint QF, 9 joint R16.
    expect([1, 2, 3, 5, 9].map(ordinalPlacing)).toEqual(['1st', '2nd', '3rd', '5th', '9th']);
  });

  it('handles the teens, which do not follow the last digit', () => {
    expect([11, 12, 13].map(ordinalPlacing)).toEqual(['11th', '12th', '13th']);
  });

  it('handles the twenties, which do', () => {
    expect([21, 22, 23, 24].map(ordinalPlacing)).toEqual(['21st', '22nd', '23rd', '24th']);
  });
});

describe('resultMonth', () => {
  it('names the month a result belongs to', () => {
    expect(resultMonth('2025-11-16')).toBe('NOV 2025');
  });

  it('does not roll a first-of-the-month into the previous month', () => {
    expect(resultMonth('2025-12-01')).toBe('DEC 2025');
  });

  it('does not roll a last-of-the-month into the next one', () => {
    expect(resultMonth('2025-11-30')).toBe('NOV 2025');
  });

  it('accepts a full timestamp as well as a date key', () => {
    expect(resultMonth('2025-11-16T08:00:00Z')).toBe('NOV 2025');
  });
});

describe('isUpcoming', () => {
  it('counts a tournament starting today as still to come', () => {
    expect(isUpcoming('2026-02-07', '2026-02-07')).toBe(true);
  });

  it('does not resurrect yesterday', () => {
    expect(isUpcoming('2026-02-06', '2026-02-07')).toBe(false);
  });

  it('is a club-day comparison, not an instant one', () => {
    // The bug this replaces: new Date('2026-02-07') is UTC midnight, which is
    // 2026-02-06 16:00 in Vancouver — so from 4pm the day before, a tournament
    // starting "tomorrow" already read as started. Day keys cannot do that.
    expect(isUpcoming('2026-02-07', '2026-02-06')).toBe(true);
  });
});
