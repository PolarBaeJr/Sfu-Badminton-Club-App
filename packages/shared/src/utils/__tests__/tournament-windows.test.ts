import { describe, it, expect } from 'vitest';
import {
  WINDOW_STATE_CASES,
  checkinWindowNotice,
  effectiveWindows,
  formatWindowInstant,
  registrationWindowNotice,
  validateEffectiveWindows,
  validateWindowPair,
  windowColumnsFromWallClock,
  windowState,
} from '../tournament-windows';
import { clubWallClockToUtc, formatClubEventTime } from '../club-events';
import { ExpectedError } from '../expected-error';

describe('windowState', () => {
  it.each(WINDOW_STATE_CASES)('$opens .. $closes at $now is $expected', ({ opens, closes, now, expected }) => {
    expect(windowState(opens, closes, new Date(now))).toBe(expected);
  });

  it('opens on the instant and closes on the instant', () => {
    const opens = '2026-10-01T12:00:00Z';
    const closes = '2026-10-01T13:00:00Z';
    expect(windowState(opens, closes, new Date(opens))).toBe('open');
    expect(windowState(opens, closes, new Date(closes))).toBe('closed');
  });

  it('treats undefined like null', () => {
    expect(windowState(undefined, undefined, new Date())).toBe('open');
  });
});

describe('effectiveWindows', () => {
  const tournament = {
    registration_opens_at: '2026-10-01T00:00:00Z',
    registration_closes_at: '2026-10-05T00:00:00Z',
    checkin_opens_at: '2026-10-06T16:00:00Z',
    checkin_closes_at: null,
  };

  it('falls back to the tournament when the event sets nothing', () => {
    expect(effectiveWindows({ event: {}, tournament })).toEqual({
      registration: { opens_at: '2026-10-01T00:00:00Z', closes_at: '2026-10-05T00:00:00Z' },
      checkin: { opens_at: '2026-10-06T16:00:00Z', closes_at: null },
    });
  });

  it('lets the event override one bound and inherit the other', () => {
    const w = effectiveWindows({
      event: { registration_closes_at: '2026-10-03T00:00:00Z', checkin_closes_at: '2026-10-06T17:00:00Z' },
      tournament,
    });
    expect(w.registration).toEqual({ opens_at: '2026-10-01T00:00:00Z', closes_at: '2026-10-03T00:00:00Z' });
    expect(w.checkin).toEqual({ opens_at: '2026-10-06T16:00:00Z', closes_at: '2026-10-06T17:00:00Z' });
  });

  it('is all null with neither row', () => {
    expect(effectiveWindows({ event: null, tournament: undefined })).toEqual({
      registration: { opens_at: null, closes_at: null },
      checkin: { opens_at: null, closes_at: null },
    });
  });
});

describe('validateWindowPair', () => {
  it('passes a one-ended or empty window', () => {
    expect(validateWindowPair({ opens_at: null, closes_at: null }, 'Registration')).toBeNull();
    expect(validateWindowPair({ opens_at: '2026-10-01T00:00:00Z', closes_at: null }, 'Registration')).toBeNull();
    expect(validateWindowPair({ opens_at: null, closes_at: '2026-10-01T00:00:00Z' }, 'Registration')).toBeNull();
  });

  it('refuses a window that closes at or before it opens', () => {
    expect(validateWindowPair({ opens_at: '2026-10-01T00:00:00Z', closes_at: '2026-10-01T00:00:00Z' }, 'Check-in'))
      .toBe('Check-in must close after it opens.');
    expect(validateWindowPair({ opens_at: '2026-10-02T00:00:00Z', closes_at: '2026-10-01T00:00:00Z' }, 'Registration'))
      .toBe('Registration must close after it opens.');
  });

  it('passes a window that closes after it opens', () => {
    expect(validateWindowPair({ opens_at: '2026-10-01T00:00:00Z', closes_at: '2026-10-01T00:01:00Z' }, 'Registration')).toBeNull();
  });
});

describe('notices', () => {
  const window = { opens_at: '2026-10-01T19:00:00Z', closes_at: '2026-10-02T19:00:00Z' };

  it('formats in club time', () => {
    expect(formatWindowInstant).toBe(formatClubEventTime);
  });

  it('says when registration opens, that it closed, or nothing', () => {
    expect(registrationWindowNotice(window, new Date('2026-10-01T00:00:00Z')))
      .toBe(`Registration opens ${formatClubEventTime(window.opens_at)}`);
    expect(registrationWindowNotice(window, new Date('2026-10-01T20:00:00Z'))).toBeNull();
    expect(registrationWindowNotice(window, new Date('2026-10-03T00:00:00Z'))).toBe('Registration closed');
  });

  it('says when check-in opens, that it closed, or nothing', () => {
    expect(checkinWindowNotice(window, new Date('2026-10-01T00:00:00Z')))
      .toBe(`Check-in opens ${formatClubEventTime(window.opens_at)}`);
    expect(checkinWindowNotice(window, new Date('2026-10-01T20:00:00Z'))).toBeNull();
    expect(checkinWindowNotice(window, new Date('2026-10-03T00:00:00Z'))).toBe('Check-in has closed, see the desk');
  });
});

describe('windowColumnsFromWallClock', () => {
  it('converts club wall clock to instants, only for the keys given', () => {
    const out = windowColumnsFromWallClock({ registration_opens_at: '2026-10-01T09:00', checkin_closes_at: undefined });
    expect(out).toEqual({ registration_opens_at: clubWallClockToUtc('2026-10-01T09:00')!.toISOString() });
  });

  it('clears a bound on blank or null', () => {
    expect(windowColumnsFromWallClock({ checkin_opens_at: '  ', checkin_closes_at: null }))
      .toEqual({ checkin_opens_at: null, checkin_closes_at: null });
  });

  it('refuses a time that is not real, as an expected error', () => {
    expect(() => windowColumnsFromWallClock({ registration_closes_at: '2026-02-31T09:00' })).toThrow(ExpectedError);
    expect(() => windowColumnsFromWallClock({ registration_closes_at: 'soon' })).toThrow(/Not a real date and time: soon/);
  });
});

describe('validateEffectiveWindows', () => {
  const open = { opens_at: null, closes_at: null };
  const inverted = { opens_at: '2026-10-02T00:00:00Z', closes_at: '2026-10-01T00:00:00Z' };

  it('names the pair that is inverted', () => {
    expect(validateEffectiveWindows({ registration: open, checkin: open })).toBeNull();
    expect(validateEffectiveWindows({ registration: inverted, checkin: open })).toBe('Registration must close after it opens.');
    expect(validateEffectiveWindows({ registration: open, checkin: inverted })).toBe('Check-in must close after it opens.');
  });
});
