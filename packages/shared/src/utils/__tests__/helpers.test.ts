import { describe, it, expect } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  isAdmin,
  getWinRate,
  getWinRateNumeric,
  getOverallRecord,
  getPointDifferential,
  getStreakDisplay,
  cn,
  pickOne,
} from '../helpers';
import type { UserRole } from '../../types/database';

describe('formatDate', () => {
  it('formats an ISO date string', () => {
    const result = formatDate('2024-03-15T12:00:00Z');
    expect(result).toContain('Mar');
    expect(result).toContain('15');
    expect(result).toContain('2024');
  });

  it('handles a date-only string', () => {
    // Use a midday timestamp so the formatted local-time date is stable across timezones.
    const result = formatDate('2023-01-01T12:00:00Z');
    expect(result).toContain('2023');
    expect(result).toContain('Jan');
  });
});

describe('formatDateTime', () => {
  it('includes time components', () => {
    const result = formatDateTime('2024-06-20T14:30:00Z');
    expect(result).toContain('Jun');
    expect(result).toContain('2024');
  });
});

describe('formatRelativeTime', () => {
  it('returns "just now" for very recent timestamps', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('returns minutes ago for timestamps within the hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours ago for timestamps within the day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
  });

  it('returns days ago for timestamps within the week', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago');
  });

  it('falls back to formatDate for timestamps older than a week', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
    const result = formatRelativeTime(twoWeeksAgo);
    expect(result).not.toContain('ago');
    expect(result).toContain('202');
  });
});

describe('isAdmin', () => {
  it('returns true for admin role', () => {
    expect(isAdmin('admin')).toBe(true);
  });

  it('returns false for player role', () => {
    expect(isAdmin('player')).toBe(false);
  });

  it('covers all UserRole values', () => {
    const roles: UserRole[] = ['player', 'admin'];
    const results = roles.map(isAdmin);
    expect(results).toEqual([false, true]);
  });
});

describe('getWinRate', () => {
  it('returns 0% when no matches played', () => {
    expect(getWinRate(0, 0)).toBe('0%');
  });

  it('calculates 100% win rate', () => {
    expect(getWinRate(10, 0)).toBe('100%');
  });

  it('calculates 0% win rate', () => {
    expect(getWinRate(0, 10)).toBe('0%');
  });

  it('rounds to nearest integer percentage', () => {
    expect(getWinRate(1, 2)).toBe('33%');
    expect(getWinRate(2, 1)).toBe('67%');
  });

  it('calculates correct percentage for mixed record', () => {
    expect(getWinRate(3, 1)).toBe('75%');
  });

  it('calculates 50% win rate', () => {
    expect(getWinRate(5, 5)).toBe('50%');
  });

  it('handles a single win', () => {
    expect(getWinRate(1, 0)).toBe('100%');
  });

  it('handles a single loss', () => {
    expect(getWinRate(0, 1)).toBe('0%');
  });
});

describe('getWinRateNumeric', () => {
  it('returns null when no matches played', () => {
    expect(getWinRateNumeric(0, 0)).toBeNull();
  });

  it('returns 1 for all wins', () => {
    expect(getWinRateNumeric(10, 0)).toBe(1);
  });

  it('returns 0 for all losses', () => {
    expect(getWinRateNumeric(0, 10)).toBe(0);
  });

  it('returns an unrounded fraction for a mixed record', () => {
    expect(getWinRateNumeric(3, 1)).toBe(0.75);
  });

  it('does not round repeating fractions', () => {
    expect(getWinRateNumeric(1, 2)).toBeCloseTo(1 / 3, 10);
  });
});

describe('getOverallRecord', () => {
  it('returns zeros, 0%, and null rate when no matches played', () => {
    const result = getOverallRecord({ singles_wins: 0, singles_losses: 0, doubles_wins: 0, doubles_losses: 0 });
    expect(result).toEqual({ wins: 0, losses: 0, played: 0, winRate: '0%', winRateNumeric: null });
  });

  it('combines singles and doubles into an overall record', () => {
    const result = getOverallRecord({ singles_wins: 3, singles_losses: 1, doubles_wins: 2, doubles_losses: 2 });
    expect(result.wins).toBe(5);
    expect(result.losses).toBe(3);
    expect(result.played).toBe(8);
    expect(result.winRate).toBe('63%');
    expect(result.winRateNumeric).toBe(5 / 8);
  });

  it('handles all wins across both formats', () => {
    const result = getOverallRecord({ singles_wins: 4, singles_losses: 0, doubles_wins: 6, doubles_losses: 0 });
    expect(result).toEqual({ wins: 10, losses: 0, played: 10, winRate: '100%', winRateNumeric: 1 });
  });

  it('rounds the formatted rate like getWinRate (1 win in 3 games)', () => {
    const result = getOverallRecord({ singles_wins: 1, singles_losses: 1, doubles_wins: 0, doubles_losses: 1 });
    expect(result.winRate).toBe('33%');
    expect(result.winRateNumeric).toBeCloseTo(1 / 3, 10);
  });
});

describe('getPointDifferential', () => {
  it('returns positive differential with + prefix', () => {
    expect(getPointDifferential(100, 80)).toBe('+20');
  });

  it('returns negative differential', () => {
    expect(getPointDifferential(80, 100)).toBe('-20');
  });

  it('returns +0 for equal points', () => {
    expect(getPointDifferential(50, 50)).toBe('+0');
  });

  it('handles large differentials', () => {
    expect(getPointDifferential(1000, 200)).toBe('+800');
    expect(getPointDifferential(200, 1000)).toBe('-800');
  });

  it('handles zero scored and zero allowed', () => {
    expect(getPointDifferential(0, 0)).toBe('+0');
  });
});

describe('getStreakDisplay', () => {
  it('displays winning streak', () => {
    expect(getStreakDisplay(3)).toBe('W3');
  });

  it('displays losing streak', () => {
    expect(getStreakDisplay(-5)).toBe('L5');
  });

  it('displays dash for no streak', () => {
    expect(getStreakDisplay(0)).toBe('-');
  });

  it('handles a single win streak', () => {
    expect(getStreakDisplay(1)).toBe('W1');
  });

  it('handles a single loss streak', () => {
    expect(getStreakDisplay(-1)).toBe('L1');
  });
});

describe('pickOne', () => {
  it('returns null for null', () => {
    expect(pickOne(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(pickOne(undefined)).toBeNull();
  });

  it('returns the value when given a plain object', () => {
    const person = { id: '1', full_name: 'Alice' };
    expect(pickOne(person)).toBe(person);
  });

  it('returns the first element when given an array', () => {
    const a = { id: '1' };
    const b = { id: '2' };
    expect(pickOne([a, b])).toBe(a);
  });

  it('returns null for an empty array', () => {
    expect(pickOne([])).toBeNull();
  });
});

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('foo', 'bar', 'baz')).toBe('foo bar baz');
  });

  it('filters out falsy values', () => {
    expect(cn('foo', false, undefined, null, 'bar')).toBe('foo bar');
  });

  it('returns empty string when all values are falsy', () => {
    expect(cn(false, undefined, null)).toBe('');
  });

  it('returns empty string with no arguments', () => {
    expect(cn()).toBe('');
  });

  it('handles a single class', () => {
    expect(cn('only')).toBe('only');
  });

  it('supports conditional classes via boolean expressions', () => {
    const isActive = true;
    const isDisabled = false;
    expect(cn('base', isActive && 'active', isDisabled && 'disabled')).toBe('base active');
  });
});
