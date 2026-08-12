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

  // WAS: "refuses for a doubles event — a member has no way to take that
  // place". Since 00102 a member CAN take it: they enter the pool on their own
  // and an exec pairs them. So the number has to be real — and it has to be the
  // number the server enforces, or the badge promises a place registerForEvent
  // then refuses.
  it('counts a doubles event in TEAMS, because that is what the cap counts', () => {
    const d = event({ id: 'dbl', event_type: 'open_doubles', max_participants: 8 });
    expect(spotsLeft([d], [], [])).toBe(8);
    // Three formed teams take three of the eight.
    expect(spotsLeft([d], [], [
      { event_id: 'dbl', status: 'registered' },
      { event_id: 'dbl', status: 'registered' },
      { event_id: 'dbl', status: 'checked_in' },
    ])).toBe(5);
  });

  it('counts two people waiting for a partner as one doubles spot', () => {
    const d = event({ id: 'dbl', event_type: 'open_doubles', max_participants: 8 });
    expect(spotsLeft([d], [
      { event_id: 'dbl', status: 'registered' },
      { event_id: 'dbl', status: 'registered' },
    ], [])).toBe(7);
  });

  it('rounds a LONE waiting person up to a whole spot — they still need a court', () => {
    const d = event({ id: 'dbl', event_type: 'open_doubles', max_participants: 8 });
    expect(spotsLeft([d], [{ event_id: 'dbl', status: 'registered' }], [])).toBe(7);
    // …and the second person to enter takes none, because they fill the slot
    // the first one opened. This is the one place the badge does not tick down
    // on every entry, and it is the same arithmetic the action applies.
    expect(spotsLeft([d], [
      { event_id: 'dbl', status: 'registered' },
      { event_id: 'dbl', status: 'registered' },
    ], [])).toBe(7);
  });

  it('agrees with the admin capacity check for a mixed field', () => {
    // Six teams and three people waiting = 6 + ceil(3/2) = 8 slots taken.
    const d = event({ id: 'dbl', event_type: 'open_doubles', max_participants: 10 });
    const pairs = Array.from({ length: 6 }, () => ({ event_id: 'dbl', status: 'registered' }));
    const waiting = Array.from({ length: 3 }, () => ({ event_id: 'dbl', status: 'registered' }));
    expect(spotsLeft([d], waiting, pairs)).toBe(2);
  });

  it('ignores withdrawn entries on BOTH sides of a doubles field', () => {
    const d = event({ id: 'dbl', event_type: 'open_doubles', max_participants: 8 });
    expect(spotsLeft([d], [
      { event_id: 'dbl', status: 'registered' },
      { event_id: 'dbl', status: 'withdrawn' },
    ], [
      { event_id: 'dbl', status: 'registered' },
      { event_id: 'dbl', status: 'disqualified' },
    ])).toBe(6);
  });

  it('does not let another event’s rows count against this one', () => {
    const d = event({ id: 'dbl', event_type: 'open_doubles', max_participants: 8 });
    expect(spotsLeft([d], [{ event_id: 'other', status: 'registered' }], [
      { event_id: 'other', status: 'registered' },
    ])).toBe(8);
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

  // WAS: "declines when a doubles event is the only one open — it is admin
  // managed". It no longer is. The CTA this feeds is a LINK to the tournament
  // page, so naming the doubles event here cannot route anybody past the
  // consent copy — that lives in the button's own dialog on the page they land
  // on, and registerForEvent refuses without the acknowledgement regardless.
  it('names a doubles event now that a member can enter one alone', () => {
    expect(soleEnterableEvent([event({ id: 'd', event_type: 'womens_doubles' })])?.id).toBe('d');
  });

  it('declines when there is a choice to make', () => {
    expect(soleEnterableEvent([event({ id: 'a' }), event({ id: 'b' })])).toBeNull();
    // Including a choice between the two disciplines, which is the common shape.
    expect(soleEnterableEvent([
      event({ id: 'a' }),
      event({ id: 'b', event_type: 'mixed_doubles' }),
    ])).toBeNull();
  });

  it('declines when the only doubles event is not taking entries', () => {
    expect(soleEnterableEvent([
      event({ id: 'd', event_type: 'mixed_doubles', status: 'checkin' }),
    ])).toBeNull();
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
