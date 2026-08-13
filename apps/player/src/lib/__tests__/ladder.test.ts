import { describe, it, expect } from 'vitest';
import {
  topPercentile,
  gapToNext,
  rungProgress,
  winShare,
  formatStreak,
  ladderHistogram,
  bandHeight,
  MIN_BAND_HEIGHT,
  extendLadderWindow,
  ladderWindowIncluding,
  LADDER_WINDOW_STEP,
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

describe('bandHeight', () => {
  it('draws an empty band as nothing', () => {
    expect(bandHeight(0, 30)).toBe(0);
  });

  it('fills the tallest band', () => {
    expect(bandHeight(30, 30)).toBe(1);
  });

  it('keeps a single member visible', () => {
    expect(bandHeight(1, 30)).toBeCloseTo(MIN_BAND_HEIGHT);
  });

  it('keeps small counts apart instead of flattening them onto the floor', () => {
    // The bug this replaces: max(0.14, count/30) made 1, 2, 3 and 4 identical.
    const heights = [1, 2, 3, 4].map((c) => bandHeight(c, 30));
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]!).toBeGreaterThan(heights[i - 1]!);
    }
  });

  it('fills every occupied band when the peak is one', () => {
    expect(bandHeight(1, 1)).toBe(1);
  });

  it('never exceeds full height', () => {
    expect(bandHeight(40, 30)).toBeLessThanOrEqual(1.001);
  });
});

describe('ladderHistogram', () => {
  it('counts the field into equal-width rating bands', () => {
    const h = ladderHistogram([1400, 1300, 1250, 1200], 1, 4);
    expect(h.min).toBe(1200);
    expect(h.max).toBe(1400);
    // Bands of 50: [1200,1250) [1250,1300) [1300,1350) [1350,1400]
    expect(h.buckets).toEqual([1, 1, 1, 1]);
    expect(h.peak).toBe(1);
    expect(h.buckets.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('clamps the top rating into the last band rather than off the end', () => {
    const h = ladderHistogram([1400, 1200], 0, 4);
    expect(h.buckets).toEqual([1, 0, 0, 1]);
    expect(h.meBucket).toBe(3);
  });

  it('reports the fullest band, so bars can be drawn relative to it', () => {
    const h = ladderHistogram([1200, 1205, 1210, 1400], 0, 4);
    expect(h.peak).toBe(3);
    expect(h.buckets[0]).toBe(3);
  });

  it('puts a flat field in the middle band instead of piling it at one end', () => {
    const h = ladderHistogram([1200, 1200, 1200], 1, 5);
    expect(h.buckets).toEqual([0, 0, 3, 0, 0]);
    expect(h.meBucket).toBe(2);
  });

  it('has no marked band when the member is not in this field', () => {
    expect(ladderHistogram([1400, 1200], -1, 4).meBucket).toBeNull();
  });

  it('never loses a player', () => {
    const values = Array.from({ length: 92 }, (_, i) => 1650 - i * 7 + (i % 5));
    const h = ladderHistogram(values, 11, 22);
    expect(h.buckets).toHaveLength(22);
    expect(h.buckets.reduce((a, b) => a + b, 0)).toBe(92);
    expect(h.meBucket).not.toBeNull();
  });

  it('is an empty set of bands for an empty field', () => {
    const h = ladderHistogram([], 0, 3);
    expect(h).toEqual({ min: 0, max: 0, buckets: [0, 0, 0], peak: 0, meBucket: null });
  });
});

// ---------------------------------------------------------------------------
// THE RENDERED WINDOW
// ---------------------------------------------------------------------------
// The Ranks page renders a slice of the ladder and extends it as the reader
// scrolls. What is pinned here is the arithmetic only — that the window never
// overshoots the list, never shrinks, and always leaves something below the row
// it was asked to reach.

describe('extendLadderWindow', () => {
  it('adds one step at a time', () => {
    expect(extendLadderWindow(25, 200, 25)).toBe(50);
    expect(extendLadderWindow(50, 200, 25)).toBe(75);
  });

  it('stops exactly at the end of the list and stays there', () => {
    // The sentinel unmounts at the end, but the "Show more" button on it is
    // real and a fast double press must not run the count past the data.
    expect(extendLadderWindow(90, 100, 25)).toBe(100);
    expect(extendLadderWindow(100, 100, 25)).toBe(100);
  });

  it('handles a list shorter than one step', () => {
    expect(extendLadderWindow(3, 3, 25)).toBe(3);
    expect(extendLadderWindow(0, 0, 25)).toBe(0);
  });

  it('always moves forward, even if somebody passes a nonsense step', () => {
    // A step of zero would make the sentinel fire forever without ever adding a
    // row — an infinite loop of observer callbacks, not merely a slow list.
    expect(extendLadderWindow(10, 100, 0)).toBeGreaterThan(10);
    expect(extendLadderWindow(10, 100, -5)).toBeGreaterThan(10);
  });

  it('uses the shared step by default', () => {
    expect(extendLadderWindow(0, 1000)).toBe(LADDER_WINDOW_STEP);
  });
});

describe('ladderWindowIncluding', () => {
  it('rounds up to a whole step, so the row is never the last one rendered', () => {
    // The member who has just jumped to their own rank is exactly the one who
    // wants to see who is below them. Index 79 is the 80th row, so a window of
    // 80 would put them flush against the bottom; it goes to 100.
    expect(ladderWindowIncluding(79, 25, 300, 25)).toBe(100);
    expect(ladderWindowIncluding(0, 25, 300, 25)).toBe(25);
  });

  it('never renders past the end of the list', () => {
    expect(ladderWindowIncluding(97, 25, 98, 25)).toBe(98);
  });

  it('never shrinks a window that is already big enough', () => {
    // Pressing "go to my row" twice must do nothing the second time, not
    // collapse the page back to a smaller slice under the reader.
    expect(ladderWindowIncluding(10, 200, 300, 25)).toBe(200);
    expect(ladderWindowIncluding(-1, 75, 300, 25)).toBe(75);
  });

  it('leaves the window alone for an empty list', () => {
    expect(ladderWindowIncluding(0, 25, 0, 25)).toBe(25);
  });

  it('always produces a window that actually contains the row', () => {
    // The property the control depends on, over every position in a long list.
    for (const total of [1, 24, 25, 26, 100, 301]) {
      for (let i = 0; i < total; i++) {
        expect(ladderWindowIncluding(i, LADDER_WINDOW_STEP, total)).toBeGreaterThan(i);
      }
    }
  });
});
