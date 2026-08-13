import { describe, it, expect } from 'vitest';
import {
  addDaysISO,
  buildCalendarMonth,
  clubDateISO,
  dayHeading,
  describeMyState,
  groupSessionsByDay,
  initialMonthIndex,
  isAttendanceRecorded,
  monthKeyOf,
  monthKeysBetween,
  tallyBySession,
} from '../schedule';

describe('clubDateISO', () => {
  it('returns the club-local date, not the UTC one', () => {
    // 2026-08-11 03:00 UTC is still the evening of the 10th in Vancouver.
    expect(clubDateISO(new Date('2026-08-11T03:00:00Z'))).toBe('2026-08-10');
  });

  it('rolls over at club midnight', () => {
    expect(clubDateISO(new Date('2026-08-11T07:00:00Z'))).toBe('2026-08-11');
  });

  it('handles the winter offset too', () => {
    // PST (UTC-8) in January.
    expect(clubDateISO(new Date('2026-01-11T07:30:00Z'))).toBe('2026-01-10');
  });
});

describe('addDaysISO', () => {
  it('adds a day', () => {
    expect(addDaysISO('2026-08-10', 1)).toBe('2026-08-11');
  });

  it('crosses a month boundary', () => {
    expect(addDaysISO('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('crosses a year boundary', () => {
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('is unaffected by a spring-forward DST day', () => {
    // 8 March 2026 is the DST switch in Vancouver; a bare date must still
    // advance by exactly one calendar day.
    expect(addDaysISO('2026-03-08', 1)).toBe('2026-03-09');
  });

  it('goes backwards', () => {
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('dayHeading', () => {
  const today = '2026-08-10'; // a Monday

  it('names today', () => {
    expect(dayHeading(today, today)).toMatchObject({
      label: 'Today',
      dateLabel: '10 Aug',
      isToday: true,
      isTomorrow: false,
    });
  });

  it('names tomorrow', () => {
    expect(dayHeading('2026-08-11', today)).toMatchObject({ label: 'Tomorrow', isTomorrow: true });
  });

  it('falls back to the weekday further out', () => {
    expect(dayHeading('2026-08-14', today)).toMatchObject({
      label: 'Fri',
      dateLabel: '14 Aug',
      isToday: false,
      isTomorrow: false,
    });
  });

  it('always carries the absolute date, so the relative word is never the only anchor', () => {
    expect(dayHeading(today, today).dateLabel).toBe('10 Aug');
  });

  it('treats a past date as an ordinary weekday', () => {
    expect(dayHeading('2026-08-09', today).label).toBe('Sun');
  });
});

describe('groupSessionsByDay', () => {
  const today = '2026-08-10';

  it('buckets by date, oldest day first', () => {
    const groups = groupSessionsByDay(
      [
        { id: 'b', date: '2026-08-12' },
        { id: 'a', date: '2026-08-10' },
        { id: 'c', date: '2026-08-12' },
      ],
      today
    );
    expect(groups.map((g) => g.dateISO)).toEqual(['2026-08-10', '2026-08-12']);
    expect(groups.map((g) => g.sessions.map((s) => s.id))).toEqual([['a'], ['b', 'c']]);
  });

  it('keeps the query order within a day', () => {
    const groups = groupSessionsByDay(
      [
        { id: 'early', date: today },
        { id: 'late', date: today },
      ],
      today
    );
    expect(groups.map((g) => g.sessions.map((s) => s.id))).toEqual([['early', 'late']]);
  });

  it('carries the heading onto each group', () => {
    const groups = groupSessionsByDay([{ id: 'a', date: today }], today);
    expect(groups.map((g) => ({ label: g.label, isToday: g.isToday }))).toEqual([
      { label: 'Today', isToday: true },
    ]);
  });

  it('returns nothing for an empty schedule', () => {
    expect(groupSessionsByDay([], today)).toEqual([]);
  });
});

describe('tallyBySession', () => {
  it('counts rows per session', () => {
    expect(
      tallyBySession([{ session_id: 'a' }, { session_id: 'b' }, { session_id: 'a' }])
    ).toEqual({ a: 2, b: 1 });
  });

  it('treats a null result as no rows rather than throwing', () => {
    expect(tallyBySession(null)).toEqual({});
  });

  it('omits sessions with no rows entirely', () => {
    expect(tallyBySession([{ session_id: 'a' }]).b).toBeUndefined();
  });
});

describe('describeMyState', () => {
  it('prefers attendance over an older RSVP', () => {
    expect(describeMyState('checked_in', 'declined')).toBe('checked_in');
    expect(describeMyState('no_show', 'going')).toBe('no_show');
  });

  it('maps an admin-confirmed row to "attended"', () => {
    expect(describeMyState('present', null)).toBe('attended');
  });

  it('maps an excused absence', () => {
    expect(describeMyState('excused', 'going')).toBe('excused');
  });

  it('falls back to the RSVP when nothing is recorded', () => {
    expect(describeMyState(null, 'going')).toBe('going');
    expect(describeMyState(null, 'declined')).toBe('declined');
  });

  it('is "none" with neither', () => {
    expect(describeMyState(null, null)).toBe('none');
    expect(describeMyState(undefined, undefined)).toBe('none');
  });
});

describe('isAttendanceRecorded', () => {
  it('is true for every attendance status', () => {
    for (const status of ['checked_in', 'present', 'no_show', 'excused'] as const) {
      expect(isAttendanceRecorded(status)).toBe(true);
    }
  });

  it('is false when there is no attendance row', () => {
    expect(isAttendanceRecorded(null)).toBe(false);
    expect(isAttendanceRecorded(undefined)).toBe(false);
  });
});

describe('monthKeyOf', () => {
  it('takes the YYYY-MM prefix', () => {
    expect(monthKeyOf('2026-08-31')).toBe('2026-08');
  });
});

describe('monthKeysBetween', () => {
  it('returns the single month both dates fall in', () => {
    expect(monthKeysBetween('2026-08-03', '2026-08-28')).toEqual(['2026-08']);
  });

  it('walks a term, inclusive of both ends', () => {
    expect(monthKeysBetween('2026-09-08', '2026-12-05')).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
  });

  it('crosses a year boundary', () => {
    expect(monthKeysBetween('2026-11-20', '2027-02-01')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });

  it('is empty when the high bound precedes the low one', () => {
    expect(monthKeysBetween('2026-08-01', '2026-06-01')).toEqual([]);
  });
});

describe('buildCalendarMonth', () => {
  const s = (id: string, date: string) => ({ id, date });

  it('is Sunday-first and squares off to whole weeks', () => {
    // 1 Aug 2026 is a Saturday, so the first row is six borrowed days then
    // the 1st; 31 days from column 6 needs six rows.
    const month = buildCalendarMonth('2026-08', [], '2026-08-13');
    expect(month.label).toBe('August 2026');
    expect(month.weeks).toHaveLength(6);
    for (const week of month.weeks) expect(week).toHaveLength(7);
    expect(month.weeks[0]?.[0]?.dateISO).toBe('2026-07-26');
    expect(month.weeks[0]?.[6]).toMatchObject({ dateISO: '2026-08-01', day: 1, inMonth: true });
    expect(month.weeks[0]?.[5]).toMatchObject({ dateISO: '2026-07-31', inMonth: false });
    expect(month.weeks[5]?.[6]?.dateISO).toBe('2026-09-05');
  });

  it('runs every date in the grid consecutively, with no gap and no repeat', () => {
    const month = buildCalendarMonth('2026-08', [], '2026-08-13');
    const flat = month.weeks.flat().map((c) => c.dateISO);
    expect(new Set(flat).size).toBe(flat.length);
    for (let i = 1; i < flat.length; i += 1) {
      expect(flat[i]).toBe(addDaysISO(flat[i - 1] as string, 1));
    }
  });

  it('marks exactly one cell as today', () => {
    const month = buildCalendarMonth('2026-08', [], '2026-08-13');
    const today = month.weeks.flat().filter((c) => c.isToday);
    expect(today).toHaveLength(1);
    expect(today[0]?.dateISO).toBe('2026-08-13');
  });

  it('files a session under its own date', () => {
    const month = buildCalendarMonth('2026-08', [s('a', '2026-08-13'), s('b', '2026-08-13')], '2026-08-01');
    const cell = month.weeks.flat().find((c) => c.dateISO === '2026-08-13');
    expect(cell?.sessions.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('leaves the borrowed days of the neighbouring months empty', () => {
    // 31 Jul is a real cell in the August grid, but hanging July's session on
    // it would print that night in two months and double any count of it.
    const month = buildCalendarMonth('2026-08', [s('july', '2026-07-31')], '2026-08-01');
    const borrowed = month.weeks.flat().find((c) => c.dateISO === '2026-07-31');
    expect(borrowed?.inMonth).toBe(false);
    expect(borrowed?.sessions).toEqual([]);
    expect(month.weeks.flat().flatMap((c) => c.sessions)).toEqual([]);
  });

  it('gets February right in a leap year and a common one', () => {
    expect(
      buildCalendarMonth('2028-02', [], '2028-02-01').weeks.flat().filter((c) => c.inMonth)
    ).toHaveLength(29);
    expect(
      buildCalendarMonth('2027-02', [], '2027-02-01').weeks.flat().filter((c) => c.inMonth)
    ).toHaveLength(28);
  });

  it('does not drop or double a day across the 2026-11-01 offset change', () => {
    // British Columbia's winter fall-back disappears on this date
    // (CLUB_PERMANENT_OFFSET_FROM). A grid built with local-time Date
    // constructors could land twice on the 1st or skip it; one anchored at
    // UTC midnight cannot. November 2026 has 30 days, all present, all once.
    const month = buildCalendarMonth('2026-11', [], '2026-11-15');
    const inMonth = month.weeks.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(30);
    expect(inMonth.map((c) => c.day)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    // 1 Nov 2026 is a Sunday: it must sit in column 0, not spill to column 6
    // of a phantom earlier week.
    expect(month.weeks[0]?.[0]?.dateISO).toBe('2026-11-01');
    expect(month.weeks[0]?.[0]?.inMonth).toBe(true);
  });

  it('keeps a session on the 1st of November on the 1st', () => {
    const month = buildCalendarMonth('2026-11', [s('n', '2026-11-01')], '2026-10-01');
    const withSessions = month.weeks.flat().filter((c) => c.sessions.length > 0);
    expect(withSessions).toHaveLength(1);
    expect(withSessions[0]?.dateISO).toBe('2026-11-01');
  });
});

describe('initialMonthIndex', () => {
  const keys = ['2026-09', '2026-10', '2026-11', '2026-12'];

  it('opens on today when today is in range', () => {
    expect(initialMonthIndex(keys, '2026-11-03')).toBe(2);
  });

  it('clamps to the first month when today precedes the range', () => {
    expect(initialMonthIndex(keys, '2026-07-30')).toBe(0);
  });

  it('clamps to the last month when today is past the range', () => {
    // Reading the schedule over the summer break: the last month with
    // anything in it beats an empty August with both arrows dead.
    expect(initialMonthIndex(keys, '2027-08-01')).toBe(3);
  });

  it('is 0 for an empty range rather than -1', () => {
    expect(initialMonthIndex([], '2026-08-13')).toBe(0);
  });
});
