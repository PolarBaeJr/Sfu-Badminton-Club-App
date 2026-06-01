import { describe, it, expect } from 'vitest';
import { formatDate } from '../utils/date';
import {
  isAdmin,
  getWinRate,
  getPointDifferential,
  getStreakDisplay,
  cn,
  formatRelativeTime,
} from '../utils/helpers';
import type { UserRole } from '../types/database';

// =============================================
// isAdmin
// =============================================
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

// =============================================
// getWinRate
// =============================================
describe('getWinRate', () => {
  it('returns 0% when no games played', () => {
    expect(getWinRate(0, 0)).toBe('0%');
  });

  it('returns 100% for perfect record', () => {
    expect(getWinRate(10, 0)).toBe('100%');
  });

  it('returns 0% for winless record', () => {
    expect(getWinRate(0, 10)).toBe('0%');
  });

  it('calculates correct percentage for mixed record', () => {
    expect(getWinRate(3, 1)).toBe('75%');
  });

  it('rounds to nearest integer', () => {
    // 1/3 = 33.33... -> 33%
    expect(getWinRate(1, 2)).toBe('33%');
    // 2/3 = 66.66... -> 67%
    expect(getWinRate(2, 1)).toBe('67%');
  });

  it('handles a single win', () => {
    expect(getWinRate(1, 0)).toBe('100%');
  });

  it('handles a single loss', () => {
    expect(getWinRate(0, 1)).toBe('0%');
  });

  it('handles exactly 50-50 record', () => {
    expect(getWinRate(5, 5)).toBe('50%');
  });
});

// =============================================
// getPointDifferential
// =============================================
describe('getPointDifferential', () => {
  it('shows positive differential with + prefix', () => {
    expect(getPointDifferential(100, 80)).toBe('+20');
  });

  it('shows negative differential without explicit prefix', () => {
    expect(getPointDifferential(80, 100)).toBe('-20');
  });

  it('shows zero differential as +0', () => {
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

// =============================================
// getStreakDisplay
// =============================================
describe('getStreakDisplay', () => {
  it('shows winning streak with W prefix', () => {
    expect(getStreakDisplay(3)).toBe('W3');
  });

  it('shows losing streak with L prefix and absolute value', () => {
    expect(getStreakDisplay(-5)).toBe('L5');
  });

  it('shows dash for no streak', () => {
    expect(getStreakDisplay(0)).toBe('-');
  });

  it('handles a single win streak', () => {
    expect(getStreakDisplay(1)).toBe('W1');
  });

  it('handles a single loss streak', () => {
    expect(getStreakDisplay(-1)).toBe('L1');
  });
});

// =============================================
// cn (className utility)
// =============================================
describe('cn', () => {
  it('joins multiple class names', () => {
    expect(cn('foo', 'bar', 'baz')).toBe('foo bar baz');
  });

  it('filters out falsy values', () => {
    expect(cn('foo', false, 'bar', undefined, null, 'baz')).toBe('foo bar baz');
  });

  it('returns empty string with no truthy values', () => {
    expect(cn(false, undefined, null)).toBe('');
  });

  it('returns empty string with no arguments', () => {
    expect(cn()).toBe('');
  });

  it('handles single class name', () => {
    expect(cn('only')).toBe('only');
  });

  it('supports conditional classes via boolean expressions', () => {
    const isActive = true;
    const isDisabled = false;
    expect(cn('base', isActive && 'active', isDisabled && 'disabled')).toBe('base active');
  });
});

// =============================================
// formatDate
// =============================================
describe('formatDate', () => {
  it('formats an ISO date string into a readable date', () => {
    // We test the shape rather than exact output since locale can vary
    const result = formatDate('2024-06-15T12:00:00Z');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    // Should contain the year
    expect(result).toContain('2024');
  });
});

// =============================================
// formatRelativeTime
// =============================================
describe('formatRelativeTime', () => {
  it('returns "just now" for very recent timestamps', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('returns minutes ago for timestamps within the hour', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m ago');
  });

  it('returns hours ago for timestamps within the day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
  });

  it('returns days ago for timestamps within the week', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago');
  });

  it('returns formatted date for timestamps older than a week', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    const result = formatRelativeTime(twoWeeksAgo);
    // Should fall back to formatDate, which includes the year
    expect(result).not.toContain('ago');
  });
});
