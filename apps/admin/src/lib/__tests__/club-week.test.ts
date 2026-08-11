import { describe, it, expect } from 'vitest';
import { addCalendarDays, clubWeek, clubWeekStart } from '../club-week';

// THE WEEK THE OFFICER IS STANDING IN, not the week the server's clock is in.
//
// Two real bugs are pinned here. A UTC cutoff meant that from about 17:00
// Vancouver "today" was already tomorrow, so a Sunday-evening load asked for
// next week; and a DST-crossing range measured a 98-day term as 15 weeks
// because the arithmetic re-entered a timezone halfway through.
describe('addCalendarDays', () => {
  it('crosses a month', () => {
    expect(addCalendarDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('crosses a year', () => {
    expect(addCalendarDays('2025-12-31', 1)).toBe('2026-01-01');
  });

  it('handles a leap day', () => {
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  // THE DST CASE. Vancouver springs forward on 2026-03-08 and falls back on
  // 2026-11-01. A day of calendar arithmetic must still be one calendar day
  // across both, which is exactly what re-entering a timezone breaks: 24 hours
  // added to a local midnight lands at 01:00 or 23:00 on the wrong side.
  it('adds one calendar day across both DST transitions', () => {
    expect(addCalendarDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addCalendarDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addCalendarDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addCalendarDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  // A 98-day term is exactly 14 weeks. Counting it a day at a time must agree.
  it('measures a 98-day term as 14 weeks across a DST change', () => {
    expect(addCalendarDays('2026-01-05', 98)).toBe('2026-04-13');
    expect(addCalendarDays('2026-01-05', 14 * 7)).toBe('2026-04-13');
  });
});

describe('clubWeekStart', () => {
  it('returns the same day for a Monday', () => {
    // 2026-08-10 is a Monday.
    expect(clubWeekStart('2026-08-10')).toBe('2026-08-10');
  });

  it('walks back to Monday from mid-week', () => {
    expect(clubWeekStart('2026-08-13')).toBe('2026-08-10'); // Thursday
  });

  // Sunday is the END of the club's week, not the start of the next one. Getting
  // this wrong hides the whole weekend's joiners from the Monday-morning read.
  it('treats Sunday as the last day of the week it closes', () => {
    expect(clubWeekStart('2026-08-16')).toBe('2026-08-10'); // Sunday
  });
});

describe('clubWeek', () => {
  // 03:00 UTC on a Monday is 20:00 the PREVIOUS Sunday in Vancouver, so the
  // club is still in the week that is about to close. A UTC read of the day
  // would have rolled the whole window forward by seven days.
  it('stays in Sunday evening\'s week when UTC has already rolled to Monday', () => {
    const week = clubWeek(new Date('2026-08-17T03:00:00Z'));
    expect(week.today).toBe('2026-08-16');
    expect(week.start).toBe('2026-08-10');
    expect(week.end).toBe('2026-08-16');
  });

  it('spans exactly seven days', () => {
    const week = clubWeek(new Date('2026-08-13T19:00:00Z'));
    expect(week.start).toBe('2026-08-10');
    expect(week.end).toBe('2026-08-16');
    expect(addCalendarDays(week.start, 6)).toBe(week.end);
  });

  it('contains today', () => {
    const week = clubWeek(new Date('2026-08-13T19:00:00Z'));
    expect(week.today >= week.start).toBe(true);
    expect(week.today <= week.end).toBe(true);
  });
});
