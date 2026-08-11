import { describe, expect, it } from 'vitest';
import {
  attendanceStreak,
  clubDayKey,
  dayLabel,
  describeMatch,
  groupByDay,
  seasonWeek,
  sessionDayLabel,
  shiftDayKey,
  type RiverPerson,
} from '@/lib/feed-activity';

const TZ = 'America/Vancouver';

const person = (id: string, name: string): RiverPerson => ({
  id,
  name,
  handle: null,
  avatarUrl: null,
});

describe('clubDayKey', () => {
  it('reads a timestamp in club time, not UTC', () => {
    // 2026-08-05T06:00Z is still 2026-08-04 at 23:00 in Vancouver. Grouping in
    // UTC would file this match under the wrong day for the whole club.
    expect(clubDayKey('2026-08-05T06:00:00Z', TZ)).toBe('2026-08-04');
  });

  it('agrees with UTC when the offset does not straddle midnight', () => {
    expect(clubDayKey('2026-08-05T20:00:00Z', TZ)).toBe('2026-08-05');
  });
});

describe('shiftDayKey', () => {
  it('steps back a day', () => {
    expect(shiftDayKey('2026-08-05', -1)).toBe('2026-08-04');
  });

  it('steps across a month boundary', () => {
    expect(shiftDayKey('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('steps across a year boundary', () => {
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('dayLabel', () => {
  it('names today and yesterday rather than dating them', () => {
    expect(dayLabel('2026-08-05', '2026-08-05')).toBe('TODAY');
    expect(dayLabel('2026-08-04', '2026-08-05')).toBe('YESTERDAY');
  });

  it('dates anything older', () => {
    expect(dayLabel('2026-08-01', '2026-08-05')).toBe('SAT 1 AUG');
  });
});

describe('sessionDayLabel', () => {
  it('names today and tomorrow', () => {
    expect(sessionDayLabel('2026-08-05', '2026-08-05')).toBe('Today');
    expect(sessionDayLabel('2026-08-06', '2026-08-05')).toBe('Tomorrow');
  });

  it('uses the bare weekday inside a week, where it cannot be misread', () => {
    // 2026-08-10 is a Monday, five days out.
    expect(sessionDayLabel('2026-08-10', '2026-08-05')).toBe('Monday');
  });

  it('dates anything further out, so "Monday" cannot mean a Monday nine days away', () => {
    expect(sessionDayLabel('2026-08-17', '2026-08-05')).toBe('Monday 17 Aug');
  });

  it('dates a day in the past rather than calling it a weekday', () => {
    expect(sessionDayLabel('2026-08-03', '2026-08-05')).toBe('Monday 3 Aug');
  });
});

describe('groupByDay', () => {
  const now = new Date('2026-08-05T18:00:00Z');

  it('returns nothing for nothing', () => {
    expect(groupByDay([], now, TZ)).toEqual([]);
  });

  it('buckets into club days, newest day first', () => {
    const sections = groupByDay(
      [
        { at: '2026-08-04T20:00:00Z', id: 'older' },
        { at: '2026-08-05T17:00:00Z', id: 'newest' },
        { at: '2026-08-05T16:00:00Z', id: 'today-earlier' },
      ],
      now,
      TZ,
    );
    expect(sections.map((s) => s.label)).toEqual(['TODAY', 'YESTERDAY']);
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['newest', 'today-earlier']);
    expect(sections[1]?.items.map((i) => i.id)).toEqual(['older']);
  });

  it('sorts rather than trusting the caller — the river merges two queries', () => {
    const sections = groupByDay(
      [
        { at: '2026-08-05T10:00:00Z', id: 'b' },
        { at: '2026-08-05T14:00:00Z', id: 'a' },
      ],
      now,
      TZ,
    );
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('seasonWeek', () => {
  it('counts the start day itself as week 1', () => {
    expect(seasonWeek('2026-06-01', new Date('2026-06-01T18:00:00Z'), TZ)).toBe(1);
  });

  it('rolls to week 2 after seven days', () => {
    expect(seasonWeek('2026-06-01', new Date('2026-06-08T18:00:00Z'), TZ)).toBe(2);
  });

  it('stays in week 1 on day six', () => {
    expect(seasonWeek('2026-06-01', new Date('2026-06-07T18:00:00Z'), TZ)).toBe(1);
  });

  it('refuses to invent a week before the season starts', () => {
    expect(seasonWeek('2026-09-01', new Date('2026-08-05T18:00:00Z'), TZ)).toBeNull();
  });

  it('accepts a full timestamp as the start date', () => {
    expect(seasonWeek('2026-06-01T00:00:00Z', new Date('2026-06-09T18:00:00Z'), TZ)).toBe(2);
  });
});

describe('attendanceStreak', () => {
  it('is zero when the member has never turned up', () => {
    expect(attendanceStreak([{ id: 'a' }, { id: 'b' }], new Set())).toBe(0);
  });

  it('counts back from the most recent session', () => {
    const sessions = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
    expect(attendanceStreak(sessions, new Set(['c', 'b', 'a']))).toBe(3);
  });

  it('stops at the first session missed', () => {
    const sessions = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
    expect(attendanceStreak(sessions, new Set(['c', 'a']))).toBe(1);
  });

  it('is zero when the latest session was missed, however good the run before it', () => {
    const sessions = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
    expect(attendanceStreak(sessions, new Set(['b', 'a']))).toBe(0);
  });
});

describe('describeMatch', () => {
  const me = person('me', 'Kiera Watanabe');
  const marcus = person('marcus', 'Marcus Ng');
  const jordan = person('jordan', 'Jordan Lee');
  const priya = person('priya', 'Priya Patel');

  it('says nothing about a match with no decided side', () => {
    expect(describeMatch({ winners: [], losers: [marcus] }, 'me')).toBeNull();
  });

  it('writes the reader into their own win', () => {
    expect(describeMatch({ winners: [me], losers: [marcus] }, 'me')).toBe('You beat Marcus Ng');
  });

  it('writes the reader into their own loss', () => {
    expect(describeMatch({ winners: [marcus], losers: [me] }, 'me')).toBe('Marcus Ng beat you');
  });

  it('leaves the reader out of the subject of their own doubles win', () => {
    expect(describeMatch({ winners: [me, priya], losers: [marcus, jordan] }, 'me')).toBe(
      'You beat Marcus Ng & Jordan Lee',
    );
  });

  it('reads other members’ matches in the third person', () => {
    expect(describeMatch({ winners: [jordan], losers: [marcus] }, 'me')).toBe(
      'Jordan Lee beat Marcus Ng',
    );
  });
});
