import { describe, it, expect } from 'vitest';
import {
  addDaysISO,
  clubDateISO,
  dayHeading,
  describeMyState,
  groupSessionsByDay,
  isAttendanceRecorded,
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
