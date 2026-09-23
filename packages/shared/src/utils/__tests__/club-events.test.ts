import { describe, it, expect } from 'vitest';
import {
  PAST_CLUB_EVENTS_SHOWN,
  clubEventSignupState,
  clubWallClockToUtc,
  formatClubEventCost,
  formatClubEventTime,
  partitionClubEvents,
  utcToClubWallClock,
  type ClubEventTiming,
} from '../club-events';

const NOW = new Date('2026-10-01T18:00:00Z');

describe('partitionClubEvents', () => {
  it('puts upcoming soonest first and past most recent first', () => {
    const events = [
      { id: 'a', starts_at: '2026-10-05T01:00:00Z' },
      { id: 'b', starts_at: '2026-09-20T01:00:00Z' },
      { id: 'c', starts_at: '2026-10-02T01:00:00Z' },
      { id: 'd', starts_at: '2026-09-25T01:00:00Z' },
      { id: 'e', starts_at: NOW.toISOString() },
    ];
    const { upcoming, past } = partitionClubEvents(events, NOW);
    expect(upcoming.map((e) => e.id)).toEqual(['e', 'c', 'a']);
    expect(past.map((e) => e.id)).toEqual(['d', 'b']);
  });

  it('caps the past list', () => {
    const events = Array.from({ length: PAST_CLUB_EVENTS_SHOWN + 5 }, (_, i) => ({
      starts_at: new Date(NOW.getTime() - (i + 1) * 86_400_000).toISOString(),
    }));
    expect(partitionClubEvents(events, NOW).past).toHaveLength(PAST_CLUB_EVENTS_SHOWN);
  });
});

describe('clubEventSignupState', () => {
  const base: ClubEventTiming = {
    status: 'published',
    starts_at: '2026-10-10T02:00:00Z',
    capacity: 10,
    signup_opens_at: null,
    signup_closes_at: null,
  };

  it('is open with room and no window', () => {
    expect(clubEventSignupState(base, NOW, 3, false)).toBe('open');
  });

  it('is full at capacity, and never full with no capacity', () => {
    expect(clubEventSignupState(base, NOW, 10, false)).toBe('full');
    expect(clubEventSignupState({ ...base, capacity: null }, NOW, 500, false)).toBe('open');
  });

  it('is not open yet before the window, and closed after it', () => {
    expect(clubEventSignupState({ ...base, signup_opens_at: '2026-10-02T00:00:00Z' }, NOW, 0, false)).toBe(
      'not_open_yet',
    );
    expect(clubEventSignupState({ ...base, signup_closes_at: '2026-10-01T17:00:00Z' }, NOW, 0, false)).toBe(
      'closed',
    );
  });

  // The order the RPCs decide in: withdrawing ignores the close time, so a
  // member already signed up stays `going` until the event starts.
  it('keeps a signed-up member going after sign-ups close or fill', () => {
    expect(clubEventSignupState({ ...base, signup_closes_at: '2026-10-01T17:00:00Z' }, NOW, 10, true)).toBe(
      'going',
    );
  });

  it('is started once the event begins, even for a member who is going', () => {
    expect(clubEventSignupState({ ...base, starts_at: '2026-10-01T17:00:00Z' }, NOW, 0, true)).toBe('started');
  });

  it('is cancelled before anything else', () => {
    expect(
      clubEventSignupState({ ...base, status: 'cancelled', starts_at: '2026-09-01T00:00:00Z' }, NOW, 0, true),
    ).toBe('cancelled');
  });
});

describe('formatClubEventCost', () => {
  it('says nothing for no cost, Free for zero, and dollars otherwise', () => {
    expect(formatClubEventCost(null)).toBeNull();
    expect(formatClubEventCost(0)).toBe('Free');
    expect(formatClubEventCost(1250)).toBe('$12.50');
  });
});

describe('club wall-clock times', () => {
  // BC drops the winter fallback on 2026-11-01: from that day the club is at
  // UTC-07:00 all year, whatever tzdata the host carries.
  it('reads a start on 2026-11-01 at the permanent offset', () => {
    expect(clubWallClockToUtc('2026-11-01T19:00')?.toISOString()).toBe('2026-11-02T02:00:00.000Z');
    expect(clubWallClockToUtc('2027-01-15T19:00')?.toISOString()).toBe('2027-01-16T02:00:00.000Z');
  });

  it('reads a summer start at daylight time', () => {
    expect(clubWallClockToUtc('2026-07-01T19:00')?.toISOString()).toBe('2026-07-02T02:00:00.000Z');
  });

  it('refuses what is not a real time', () => {
    expect(clubWallClockToUtc('2026-02-31T19:00')).toBeNull();
    expect(clubWallClockToUtc('2026-10-01T24:00')).toBeNull();
    expect(clubWallClockToUtc('2026-10-01 19:00')).toBeNull();
    expect(clubWallClockToUtc('')).toBeNull();
  });

  it('turns a stored instant back into the wall clock it came from', () => {
    for (const wall of ['2026-07-01T19:00', '2026-11-01T19:00', '2027-03-14T09:30']) {
      const at = clubWallClockToUtc(wall);
      expect(at && utcToClubWallClock(at.toISOString())).toBe(wall);
    }
  });
});

describe('formatClubEventTime', () => {
  // Read through the pinned offset, not the host's tzdata, which may still
  // think Vancouver falls back to UTC-08:00 on 2026-11-01.
  it('shows a November 2026 evening at the permanent offset', () => {
    const shown = formatClubEventTime('2026-11-05T02:00:00Z');
    expect(shown).toContain('Nov 4');
    expect(shown).toContain('7:00');
    expect(shown).toContain('PM');
  });

  it('shows a summer evening at daylight time', () => {
    const shown = formatClubEventTime('2026-07-02T02:00:00Z');
    expect(shown).toContain('Jul 1');
    expect(shown).toContain('7:00');
  });
});
