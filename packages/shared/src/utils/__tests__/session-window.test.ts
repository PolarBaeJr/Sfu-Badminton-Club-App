import { describe, it, expect } from 'vitest';
import { getCheckinWindow, isCheckinOpen } from '../session-window';

// All expected instants below are UTC equivalents of America/Vancouver
// wall-clock times: PDT = UTC-7 (summer), PST = UTC-8 (winter).

describe('getCheckinWindow', () => {
  it('closes at end of the club-local day when no times are set', () => {
    const { opensAt, closesAt } = getCheckinWindow({ date: '2026-07-15' });
    // Default opens-minutes is null: no opening edge.
    expect(opensAt).toBeNull();
    // Midnight July 16, PDT (UTC-7).
    expect(closesAt.toISOString()).toBe('2026-07-16T07:00:00.000Z');
  });

  it('closes at start + default duration when only start_time is set', () => {
    const { closesAt } = getCheckinWindow({ date: '2026-07-15', start_time: '18:30:00' });
    // 18:30 PDT + 120 min = 20:30 PDT = 03:30 UTC next day.
    expect(closesAt.toISOString()).toBe('2026-07-16T03:30:00.000Z');
  });

  it('respects an explicit end_time', () => {
    const { closesAt } = getCheckinWindow({
      date: '2026-07-15',
      start_time: '18:30:00',
      end_time: '21:00:00',
    });
    // 21:00 PDT = 04:00 UTC next day.
    expect(closesAt.toISOString()).toBe('2026-07-16T04:00:00.000Z');
  });

  it('uses the winter (PST) offset for winter dates', () => {
    const { closesAt } = getCheckinWindow({ date: '2026-01-15', end_time: '21:00' });
    // 21:00 PST = 05:00 UTC next day.
    expect(closesAt.toISOString()).toBe('2026-01-16T05:00:00.000Z');
  });

  it('handles the spring-forward DST boundary sanely', () => {
    // DST starts 2026-03-08 at 02:00 in America/Vancouver.
    const { closesAt } = getCheckinWindow({ date: '2026-03-08', end_time: '21:00' });
    // 21:00 PDT (post-transition, UTC-7) = 04:00 UTC next day.
    expect(closesAt.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    const endOfDay = getCheckinWindow({ date: '2026-03-07' }).closesAt;
    // Midnight March 8 is still PST (UTC-8).
    expect(endOfDay.toISOString()).toBe('2026-03-08T08:00:00.000Z');
  });
});

describe('isCheckinOpen', () => {
  it('is open all day for a session with no times', () => {
    const session = { date: '2026-07-15' };
    // Early club-local morning (00:30 PDT) and late evening (23:30 PDT).
    expect(isCheckinOpen(session, new Date('2026-07-15T07:30:00Z'))).toBe(true);
    expect(isCheckinOpen(session, new Date('2026-07-16T06:30:00Z'))).toBe(true);
    // Days before, too (opens-minutes default is null).
    expect(isCheckinOpen(session, new Date('2026-07-10T00:00:00Z'))).toBe(true);
  });

  it('closes after start + default duration for a start-only session', () => {
    const session = { date: '2026-07-15', start_time: '18:30' };
    // During the session (19:00 PDT).
    expect(isCheckinOpen(session, new Date('2026-07-16T02:00:00Z'))).toBe(true);
    // After 20:30 PDT.
    expect(isCheckinOpen(session, new Date('2026-07-16T03:31:00Z'))).toBe(false);
  });

  it('closes at the explicit end_time', () => {
    const session = { date: '2026-07-15', start_time: '18:30', end_time: '22:00' };
    expect(isCheckinOpen(session, new Date('2026-07-16T04:59:00Z'))).toBe(true);
    expect(isCheckinOpen(session, new Date('2026-07-16T05:00:00Z'))).toBe(false);
  });

  it('is closed when now is beyond the close bound', () => {
    expect(isCheckinOpen({ date: '2026-07-15' }, new Date('2026-07-16T07:00:00Z'))).toBe(false);
  });

  it('is closed for a non-open session regardless of time', () => {
    const session = { date: '2026-07-15', status: 'closed' };
    expect(isCheckinOpen(session, new Date('2026-07-15T20:00:00Z'))).toBe(false);
  });
});
