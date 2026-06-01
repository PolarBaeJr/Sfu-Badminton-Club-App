import { describe, it, expect } from 'vitest';
import { formatDate } from '../date';
import {
  formatDateTime,
  formatRelativeTime,
  isAdmin,
  getWinRate,
  getPointDifferential,
  getStreakDisplay,
  cn,
} from '../helpers';
import {
  isDoublesEvent,
  getRoundName,
  nextPowerOf2,
  getMaxGamesForFormat,
} from '../constants';

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

  it('calculates 50% win rate', () => {
    expect(getWinRate(5, 5)).toBe('50%');
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
});

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('filters out falsy values', () => {
    expect(cn('foo', false, undefined, null, 'bar')).toBe('foo bar');
  });

  it('returns empty string when all values are falsy', () => {
    expect(cn(false, undefined, null)).toBe('');
  });

  it('handles a single class', () => {
    expect(cn('only')).toBe('only');
  });
});

describe('isDoublesEvent', () => {
  it('returns true for mens_doubles', () => {
    expect(isDoublesEvent('mens_doubles')).toBe(true);
  });

  it('returns true for womens_doubles', () => {
    expect(isDoublesEvent('womens_doubles')).toBe(true);
  });

  it('returns true for mixed_doubles', () => {
    expect(isDoublesEvent('mixed_doubles')).toBe(true);
  });

  it('returns true for open_doubles', () => {
    expect(isDoublesEvent('open_doubles')).toBe(true);
  });

  it('returns false for mens_singles', () => {
    expect(isDoublesEvent('mens_singles')).toBe(false);
  });

  it('returns false for womens_singles', () => {
    expect(isDoublesEvent('womens_singles')).toBe(false);
  });

  it('returns false for open_singles', () => {
    expect(isDoublesEvent('open_singles')).toBe(false);
  });
});

describe('getRoundName', () => {
  it('returns Final for the last round', () => {
    expect(getRoundName(4, 4)).toBe('Final');
  });

  it('returns Semi-Final for the second-to-last round', () => {
    expect(getRoundName(3, 4)).toBe('Semi-Final');
  });

  it('returns Quarter-Final for the third-to-last round', () => {
    expect(getRoundName(2, 4)).toBe('Quarter-Final');
  });

  it('returns Round of 16 for a 4-round bracket first round', () => {
    expect(getRoundName(1, 4)).toBe('Round of 16');
  });

  it('handles a 5-round bracket', () => {
    expect(getRoundName(5, 5)).toBe('Final');
    expect(getRoundName(4, 5)).toBe('Semi-Final');
    expect(getRoundName(3, 5)).toBe('Quarter-Final');
    expect(getRoundName(2, 5)).toBe('Round of 16');
    expect(getRoundName(1, 5)).toBe('Round of 32');
  });

  it('handles a 2-round bracket', () => {
    expect(getRoundName(2, 2)).toBe('Final');
    expect(getRoundName(1, 2)).toBe('Semi-Final');
  });

  it('handles a single-round bracket (just the final)', () => {
    expect(getRoundName(1, 1)).toBe('Final');
  });
});

describe('getMaxGamesForFormat', () => {
  it('returns 3 for best_of_3_to_21', () => {
    expect(getMaxGamesForFormat('best_of_3_to_21')).toBe(3);
  });

  it('returns 1 for one_game_21', () => {
    expect(getMaxGamesForFormat('one_game_21')).toBe(1);
  });

  it('returns 1 for one_game_15', () => {
    expect(getMaxGamesForFormat('one_game_15')).toBe(1);
  });

  it('returns 1 for one_game_11', () => {
    expect(getMaxGamesForFormat('one_game_11')).toBe(1);
  });
});

describe('nextPowerOf2', () => {
  it('returns 1 for 0', () => {
    expect(nextPowerOf2(0)).toBe(1);
  });

  it('returns 1 for 1', () => {
    expect(nextPowerOf2(1)).toBe(1);
  });

  it('returns 2 for 2', () => {
    expect(nextPowerOf2(2)).toBe(2);
  });

  it('returns 4 for 3', () => {
    expect(nextPowerOf2(3)).toBe(4);
  });

  it('returns 8 for 5', () => {
    expect(nextPowerOf2(5)).toBe(8);
  });

  it('returns 8 for 7', () => {
    expect(nextPowerOf2(7)).toBe(8);
  });

  it('returns 8 for 8 (already a power of 2)', () => {
    expect(nextPowerOf2(8)).toBe(8);
  });

  it('returns 16 for 9', () => {
    expect(nextPowerOf2(9)).toBe(16);
  });

  it('returns 16 for 16', () => {
    expect(nextPowerOf2(16)).toBe(16);
  });

  it('returns 32 for 17', () => {
    expect(nextPowerOf2(17)).toBe(32);
  });

  it('returns 64 for 33', () => {
    expect(nextPowerOf2(33)).toBe(64);
  });

  it('returns 128 for 100', () => {
    expect(nextPowerOf2(100)).toBe(128);
  });
});
