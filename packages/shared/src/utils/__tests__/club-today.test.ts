import { describe, it, expect } from 'vitest';
import { clubToday } from '../session-window';

// endSeason stamped `new Date().toISOString().split('T')[0]`, which is the UTC
// calendar date. Vancouver is UTC-7 in summer and UTC-8 in winter, so any club
// evening past 17:00 PDT / 16:00 PST is already tomorrow in UTC — an exec
// ending a season on Friday evening recorded it as ending Saturday.
describe('clubToday', () => {
  it('returns the club date, not the UTC date, on a summer evening', () => {
    // 2026-08-07 02:00Z is 2026-08-06 19:00 in Vancouver (PDT, UTC-7).
    expect(clubToday(new Date('2026-08-07T02:00:00Z'))).toBe('2026-08-06');
  });

  it('returns the club date, not the UTC date, on a winter evening', () => {
    // 2026-12-05 01:00Z is 2026-12-04 17:00 in Vancouver (PST, UTC-8).
    expect(clubToday(new Date('2026-12-05T01:00:00Z'))).toBe('2026-12-04');
  });

  it('agrees with UTC during the club daytime', () => {
    // 2026-08-06 19:00Z is 2026-08-06 12:00 in Vancouver — same calendar day.
    expect(clubToday(new Date('2026-08-06T19:00:00Z'))).toBe('2026-08-06');
  });

  it('emits YYYY-MM-DD, the shape a Postgres DATE column expects', () => {
    expect(clubToday(new Date('2026-01-02T20:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The bug was a whole-day error, so a test that only checked the format would
  // have passed against the broken implementation.
  it('differs from the naive UTC slice at the exact hour that broke', () => {
    const evening = new Date('2026-08-07T02:00:00Z');
    expect(evening.toISOString().split('T')[0]).toBe('2026-08-07');
    expect(clubToday(evening)).toBe('2026-08-06');
  });
});
