import { describe, it, expect } from 'vitest';
import {
  topPercentile,
  gapToNext,
  rungProgress,
  winShare,
  formatStreak,
  ladderSpread,
} from '../ladder';

describe('topPercentile', () => {
  it('rounds up, so the leader of 87 is top 2% rather than top 1%', () => {
    expect(topPercentile(0, 87)).toBe(2);
  });

  it('places a mid-table player by their rank, not their index', () => {
    expect(topPercentile(11, 87)).toBe(14); // rank 12 of 87
  });

  it('never reports better than top 1%', () => {
    expect(topPercentile(0, 1000)).toBe(1);
  });

  it('is 100% for the last player', () => {
    expect(topPercentile(9, 10)).toBe(100);
  });

  it('is null when the player is not in the field', () => {
    expect(topPercentile(-1, 10)).toBeNull();
    expect(topPercentile(10, 10)).toBeNull();
    expect(topPercentile(0, 0)).toBeNull();
  });
});

describe('gapToNext', () => {
  it('is the rating still to find', () => {
    expect(gapToNext(1270, 1287)).toBe(17);
  });

  it('is null at the top of the ladder', () => {
    expect(gapToNext(1287, null)).toBeNull();
  });

  it('is null for an unrated player', () => {
    expect(gapToNext(null, 1287)).toBeNull();
  });

  it('goes negative when the ordering is not by rating, rather than clamping', () => {
    // The Win % sort can put a lower-rated player above a higher-rated one; the
    // caller needs to see that so it can decline to show a "catch up" line.
    expect(gapToNext(1400, 1100)).toBe(-300);
  });
});

describe('rungProgress', () => {
  it('is full at the top of the ladder', () => {
    expect(rungProgress(1200, 1400, null)).toBe(1);
  });

  it('measures across the player\'s own rung, not from zero', () => {
    // Below 1200, me 1250, above 1300 -> half way up my own slot.
    expect(rungProgress(1200, 1250, 1300)).toBeCloseTo(0.5);
  });

  it('is not almost-full merely because ratings are large numbers', () => {
    // The bug this replaces: mine/above = 1270/1287 = 0.987 for a 17-point gap.
    expect(rungProgress(1260, 1270, 1287)).toBeLessThan(0.5);
  });

  it('is zero for the bottom player, who has no rung below to measure from', () => {
    expect(rungProgress(null, 1000, 1100)).toBe(0);
  });

  it('treats being level with the player above as a crossed rung', () => {
    expect(rungProgress(1200, 1300, 1300)).toBe(1);
  });

  it('clamps an inverted ordering instead of returning a nonsense fraction', () => {
    // The Win % sort can place a lower-rated player above a higher-rated one,
    // which leaves the rung with no positive span to divide by. Falling back to
    // "have I out-rated the player above me" keeps the bar meaningful: full
    // when I already have, empty when I have not.
    expect(rungProgress(1300, 1250, 1200)).toBe(1); // rated above the player above me
    expect(rungProgress(1400, 1250, 1300)).toBe(0); // still rated below them
    expect(rungProgress(1200, 1350, 1300)).toBe(1);
  });
});

describe('winShare', () => {
  it('is the fraction of played games won', () => {
    expect(winShare(18, 6)).toBeCloseTo(0.75);
  });

  it('is null with no games played, so an unplayed record is not shown as 0%', () => {
    expect(winShare(0, 0)).toBeNull();
  });

  it('is 0 for a player who has only lost', () => {
    expect(winShare(0, 4)).toBe(0);
  });
});

describe('formatStreak', () => {
  it('labels a winning streak', () => {
    expect(formatStreak(3)).toEqual({ label: 'W3', tone: 'win' });
  });

  it('labels a losing streak by its magnitude', () => {
    expect(formatStreak(-5)).toEqual({ label: 'L5', tone: 'loss' });
  });

  it('is null with no streak, leaving the placeholder to the row', () => {
    expect(formatStreak(0)).toBeNull();
    expect(formatStreak(null)).toBeNull();
    expect(formatStreak(undefined)).toBeNull();
  });
});

describe('ladderSpread', () => {
  it('places each rating as an offset across the field\'s range', () => {
    const s = ladderSpread([1400, 1300, 1200], 1);
    expect(s.min).toBe(1200);
    expect(s.max).toBe(1400);
    expect(s.ticks).toEqual([1, 0.5, 0]);
    expect(s.meAt).toBe(0.5);
  });

  it('centres a flat field instead of pinning everyone to one end', () => {
    const s = ladderSpread([1200, 1200, 1200], 0);
    expect(s.ticks).toEqual([0.5, 0.5, 0.5]);
    expect(s.meAt).toBe(0.5);
  });

  it('has no marker when the member is not in this field', () => {
    expect(ladderSpread([1400, 1200], -1).meAt).toBeNull();
  });

  it('is empty for an empty field', () => {
    expect(ladderSpread([], 0)).toEqual({ min: 0, max: 0, ticks: [], meAt: null });
  });
});
