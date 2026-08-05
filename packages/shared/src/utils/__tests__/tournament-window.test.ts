import { describe, it, expect } from 'vitest';
import { hasTournamentEnded } from '../tournament-window';

const NOW = new Date(2026, 7, 5, 12, 0, 0); // 2026-08-05, local noon

describe('hasTournamentEnded', () => {
  it('is over once an admin marks it completed or archived, whatever the dates say', () => {
    for (const status of ['completed', 'archived']) {
      expect(hasTournamentEnded({ status, start_date: '2026-12-01', end_date: '2026-12-02' }, NOW)).toBe(true);
    }
  });

  it('is not over while it is draft or active and still running', () => {
    expect(hasTournamentEnded({ status: 'active', start_date: '2026-08-01', end_date: '2026-08-10' }, NOW)).toBe(false);
    expect(hasTournamentEnded({ status: 'draft', start_date: '2026-09-01', end_date: null }, NOW)).toBe(false);
  });

  it('stays open for the whole of the final day', () => {
    // The event ends today — a member should not be asked to rate it at 9am
    // while they are still playing.
    expect(hasTournamentEnded({ status: 'active', start_date: '2026-08-04', end_date: '2026-08-05' }, NOW)).toBe(false);
    expect(hasTournamentEnded({ status: 'active', start_date: '2026-08-04', end_date: '2026-08-04' }, NOW)).toBe(true);
  });

  it('falls back to start_date for a single-day event with no end_date', () => {
    expect(hasTournamentEnded({ status: 'active', start_date: '2026-08-04', end_date: null }, NOW)).toBe(true);
    expect(hasTournamentEnded({ status: 'active', start_date: '2026-08-05', end_date: null }, NOW)).toBe(false);
  });

  it('does not treat a missing tournament or missing dates as finished', () => {
    // Fail CLOSED: an unknown tournament must not open the feedback window.
    expect(hasTournamentEnded(null, NOW)).toBe(false);
    expect(hasTournamentEnded(undefined, NOW)).toBe(false);
    expect(hasTournamentEnded({ status: 'active', start_date: null, end_date: null }, NOW)).toBe(false);
  });
});
