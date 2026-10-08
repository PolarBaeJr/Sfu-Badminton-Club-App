import { describe, it, expect } from 'vitest';
import { getCheckinWindow, isCheckinOpen } from '../session-window';
import {
  SESSION_DEFAULT_DURATION_MINUTES,
  SESSION_CHECKIN_OPENS_MINUTES_BEFORE,
} from '../constants';

// All expected instants below are UTC equivalents of America/Vancouver
// wall-clock times: PDT = UTC-7 (summer), PST = UTC-8 (winter).
//
// Cases governed by the two configurable check-in settings derive their
// expectations from the constants instead of hardcoding minutes. Those
// settings live in platform_settings and are admin-editable, so a literal
// here rots silently the moment prod is retuned — which is what happened
// before: 231b0af synced the constants to prod (60 / 30) and left these
// tests asserting the original migration seed (120 / null).
const MINUTE = 60_000;

describe('getCheckinWindow', () => {
  it('closes at end of the club-local day when no times are set', () => {
    const { opensAt, closesAt } = getCheckinWindow({ date: '2026-07-15' });
    // With no start_time the window is anchored to local midnight, so the
    // opening edge (when configured) sits that many minutes before it.
    if (SESSION_CHECKIN_OPENS_MINUTES_BEFORE == null) {
      expect(opensAt).toBeNull();
    } else {
      const midnight = Date.parse('2026-07-15T07:00:00.000Z'); // 00:00 PDT Jul 15
      expect(opensAt?.toISOString()).toBe(
        new Date(midnight - SESSION_CHECKIN_OPENS_MINUTES_BEFORE * MINUTE).toISOString()
      );
    }
    // Midnight July 16, PDT (UTC-7) — independent of both settings.
    expect(closesAt.toISOString()).toBe('2026-07-16T07:00:00.000Z');
  });

  it('closes at start + default duration when only start_time is set', () => {
    const { closesAt } = getCheckinWindow({ date: '2026-07-15', start_time: '18:30:00' });
    const start = Date.parse('2026-07-16T01:30:00.000Z'); // 18:30 PDT
    expect(closesAt.toISOString()).toBe(
      new Date(start + SESSION_DEFAULT_DURATION_MINUTES * MINUTE).toISOString()
    );
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
  it('is open across the session day when no times are set', () => {
    const session = { date: '2026-07-15' };
    // Early club-local morning (00:30 PDT) and late evening (23:30 PDT).
    expect(isCheckinOpen(session, new Date('2026-07-15T07:30:00Z'))).toBe(true);
    expect(isCheckinOpen(session, new Date('2026-07-16T06:30:00Z'))).toBe(true);
    // Days earlier: only reachable when there is no opening edge at all.
    // With an opening edge configured, an untimed session anchors to local
    // midnight, so check-in is not yet open the week before.
    expect(isCheckinOpen(session, new Date('2026-07-10T00:00:00Z'))).toBe(
      SESSION_CHECKIN_OPENS_MINUTES_BEFORE == null
    );
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
