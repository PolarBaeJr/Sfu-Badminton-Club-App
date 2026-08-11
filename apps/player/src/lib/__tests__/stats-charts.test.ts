import { describe, it, expect } from 'vitest';
import {
  buildRatingSeries,
  buildFormFlags,
  computeRatingScale,
  buildRatingPath,
  buildRatingAreaPath,
  summarizeRatingSeries,
  seasonBoundaryX,
  buildOverallFormFlags,
  deriveForm,
  deriveAttendance,
  deriveSessionCadence,
  formatSigned,
  type ChartBox,
  type RatingSourceRow,
  type RatingPoint,
} from '../stats-charts';

const BOX: ChartBox = { width: 300, height: 100, padY: 10, padX: 6 };

function row(over: Partial<RatingSourceRow['match']> & { post_rating?: number | null; rating_delta?: number | null } = {}): RatingSourceRow {
  const { post_rating = 1000, rating_delta = 0, ...match } = over as Record<string, unknown>;
  return {
    post_rating: post_rating as number | null,
    rating_delta: rating_delta as number | null,
    match: {
      played_at: '2026-01-01T00:00:00Z',
      match_type: 'singles',
      rated_flag: true,
      completed_flag: true,
      result_status: 'confirmed',
      ...(match as object),
    },
  };
}

function pts(...ratings: number[]): RatingPoint[] {
  return ratings.map((rating, i) => ({
    at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    rating,
    delta: null,
  }));
}

describe('buildRatingSeries', () => {
  it('keeps only confirmed, rated, completed matches of the requested discipline', () => {
    const rows: RatingSourceRow[] = [
      row({ played_at: '2026-01-01T00:00:00Z', post_rating: 1000 }),
      row({ played_at: '2026-01-02T00:00:00Z', post_rating: 1010, match_type: 'doubles' }),
      row({ played_at: '2026-01-03T00:00:00Z', post_rating: 1020, rated_flag: false }),
      row({ played_at: '2026-01-04T00:00:00Z', post_rating: 1030, completed_flag: false }),
      row({ played_at: '2026-01-05T00:00:00Z', post_rating: 1040, result_status: 'disputed' }),
      row({ played_at: '2026-01-06T00:00:00Z', post_rating: 1050 }),
    ];
    expect(buildRatingSeries(rows, 'singles').map((p) => p.rating)).toEqual([1000, 1050]);
    expect(buildRatingSeries(rows, 'doubles').map((p) => p.rating)).toEqual([1010]);
  });

  it('drops rows with no post_rating or no played_at rather than plotting them at zero', () => {
    const rows: RatingSourceRow[] = [
      row({ post_rating: null }),
      row({ played_at: null }),
      row({ post_rating: 900 }),
    ];
    expect(buildRatingSeries(rows, 'singles')).toHaveLength(1);
  });

  it('drops a row with no embedded match', () => {
    expect(buildRatingSeries([{ post_rating: 900, rating_delta: 1, match: null }], 'singles')).toEqual([]);
  });

  it('sorts oldest first regardless of the order the query returned', () => {
    const rows: RatingSourceRow[] = [
      row({ played_at: '2026-03-01T00:00:00Z', post_rating: 3 }),
      row({ played_at: '2026-01-01T00:00:00Z', post_rating: 1 }),
      row({ played_at: '2026-02-01T00:00:00Z', post_rating: 2 }),
    ];
    expect(buildRatingSeries(rows, 'singles').map((p) => p.rating)).toEqual([1, 2, 3]);
  });
});

describe('computeRatingScale', () => {
  it('maps the highest rating near the top and the lowest near the bottom', () => {
    const points = pts(1000, 1100);
    const scale = computeRatingScale(points, { box: BOX });
    expect(scale.y(1100)).toBeLessThan(scale.y(1000));
    expect(scale.y(1100)).toBeGreaterThanOrEqual(BOX.padY);
    expect(scale.y(1000)).toBeLessThanOrEqual(BOX.height - BOX.padY);
  });

  it('spreads x evenly from the left pad to the right pad', () => {
    const scale = computeRatingScale(pts(1, 2, 3), { box: BOX });
    expect(scale.x(0)).toBe(BOX.padX);
    expect(scale.x(2)).toBe(BOX.width - BOX.padX);
    expect(scale.x(1)).toBe(BOX.width / 2);
  });

  it('centres a single point instead of pinning it to the left edge', () => {
    const scale = computeRatingScale(pts(1200), { box: BOX });
    expect(scale.x(0)).toBe(BOX.width / 2);
  });

  it('gives a flat series a finite, centred line rather than NaN', () => {
    const points = pts(1000, 1000, 1000);
    const scale = computeRatingScale(points, { box: BOX });
    const y = scale.y(1000);
    expect(Number.isNaN(y)).toBe(false);
    expect(y).toBeCloseTo(BOX.height / 2, 5);
  });

  it('widens the domain to include an extra value so a context line stays on canvas', () => {
    const scale = computeRatingScale(pts(1000, 1010), { box: BOX, extra: [1400] });
    expect(scale.max).toBeGreaterThanOrEqual(1400);
    expect(scale.y(1400)).toBeGreaterThanOrEqual(BOX.padY);
    expect(scale.y(1400)).toBeLessThanOrEqual(BOX.height - BOX.padY);
  });

  it('clamps a value outside the domain into the box', () => {
    const scale = computeRatingScale(pts(1000, 1100), { box: BOX });
    expect(scale.y(99999)).toBe(BOX.padY);
    expect(scale.y(-99999)).toBe(BOX.height - BOX.padY);
  });

  it('handles an empty series without producing NaN coordinates', () => {
    const scale = computeRatingScale([], { box: BOX });
    expect(Number.isNaN(scale.y(0))).toBe(false);
    expect(scale.count).toBe(0);
  });
});

describe('buildRatingPath', () => {
  it('is empty for an empty series', () => {
    expect(buildRatingPath([], computeRatingScale([], { box: BOX }))).toBe('');
  });

  it('emits one move and then one line per remaining point', () => {
    const points = pts(1000, 1050, 1100);
    const d = buildRatingPath(points, computeRatingScale(points, { box: BOX }));
    expect(d.startsWith('M')).toBe(true);
    expect(d.match(/L/g)).toHaveLength(2);
    expect(d).not.toMatch(/NaN/);
  });

  it('places a single point as a lone move command', () => {
    const points = pts(1200);
    const d = buildRatingPath(points, computeRatingScale(points, { box: BOX }));
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d).not.toContain('L');
  });
});

describe('buildRatingAreaPath', () => {
  it('closes the shape down to the baseline', () => {
    const points = pts(1000, 1100);
    const d = buildRatingAreaPath(points, computeRatingScale(points, { box: BOX }));
    expect(d.endsWith('Z')).toBe(true);
    expect(d).toContain(String(BOX.height - BOX.padY));
  });

  it('refuses to draw a wash under fewer than two points', () => {
    expect(buildRatingAreaPath(pts(1000), computeRatingScale(pts(1000), { box: BOX }))).toBe('');
    expect(buildRatingAreaPath([], computeRatingScale([], { box: BOX }))).toBe('');
  });
});

describe('summarizeRatingSeries', () => {
  it('is null for an empty series', () => {
    expect(summarizeRatingSeries([])).toBeNull();
  });

  it('reports current, peak, low and net change', () => {
    const s = summarizeRatingSeries(pts(1000, 1200, 900, 1050))!;
    expect(s.current).toBe(1050);
    expect(s.peak).toBe(1200);
    expect(s.low).toBe(900);
    expect(s.peakIndex).toBe(1);
    expect(s.lowIndex).toBe(2);
    expect(s.change).toBe(50);
  });

  it('resolves a repeated peak to its first occurrence', () => {
    const s = summarizeRatingSeries(pts(1200, 1100, 1200))!;
    expect(s.peakIndex).toBe(0);
  });

  it('treats a single match as its own peak, low and current', () => {
    const s = summarizeRatingSeries(pts(1000))!;
    expect(s).toMatchObject({ current: 1000, peak: 1000, low: 1000, change: 0 });
  });
});

describe('seasonBoundaryX', () => {
  const points = pts(1000, 1010, 1020, 1030);
  const scale = computeRatingScale(points, { box: BOX });

  it('sits between the last old-season match and the first new-season one', () => {
    const x = seasonBoundaryX(points, '2026-01-03T00:00:00Z', scale);
    expect(x).toBeCloseTo((scale.x(1) + scale.x(2)) / 2, 5);
  });

  it('is null when every plotted match is already inside the season', () => {
    expect(seasonBoundaryX(points, '2025-01-01T00:00:00Z', scale)).toBeNull();
  });

  it('is null when no plotted match falls inside the season', () => {
    expect(seasonBoundaryX(points, '2027-01-01T00:00:00Z', scale)).toBeNull();
  });

  it('is null without a season start', () => {
    expect(seasonBoundaryX(points, null, scale)).toBeNull();
    expect(seasonBoundaryX(points, undefined, scale)).toBeNull();
  });
});

describe('buildFormFlags', () => {
  const rows = [
    { win_flag: true, match: { played_at: '2026-01-03T00:00:00Z', match_type: 'singles', result_status: 'confirmed' } },
    { win_flag: false, match: { played_at: '2026-01-01T00:00:00Z', match_type: 'singles', result_status: 'confirmed' } },
    { win_flag: true, match: { played_at: '2026-01-02T00:00:00Z', match_type: 'doubles', result_status: 'confirmed' } },
    { win_flag: true, match: { played_at: '2026-01-04T00:00:00Z', match_type: 'singles', result_status: 'disputed' } },
    { win_flag: true, match: null },
  ];

  it('returns one discipline, oldest first', () => {
    expect(buildFormFlags(rows, 'singles')).toEqual([false, true]);
  });

  it('drops results that are not confirmed', () => {
    expect(buildFormFlags(rows, 'singles')).toHaveLength(2);
  });

  it('keeps an unrated match, because a casual game still has a winner', () => {
    const casual = [
      { win_flag: true, match: { played_at: '2026-02-01T00:00:00Z', match_type: 'singles', result_status: 'confirmed' } },
    ];
    expect(buildFormFlags(casual, 'singles')).toEqual([true]);
  });

  it('drops a row with no embedded match', () => {
    expect(buildFormFlags([{ win_flag: true, match: null }], 'singles')).toEqual([]);
  });
});

describe('buildOverallFormFlags', () => {
  const rows = [
    { win_flag: true, match: { played_at: '2026-01-03T00:00:00Z', match_type: 'singles', result_status: 'confirmed' } },
    { win_flag: false, match: { played_at: '2026-01-01T00:00:00Z', match_type: 'singles', result_status: 'confirmed' } },
    { win_flag: true, match: { played_at: '2026-01-02T00:00:00Z', match_type: 'doubles', result_status: 'confirmed' } },
    { win_flag: true, match: { played_at: '2026-01-04T00:00:00Z', match_type: 'singles', result_status: 'disputed' } },
    { win_flag: true, match: null },
  ];

  it('merges both disciplines into one series, oldest first', () => {
    expect(buildOverallFormFlags(rows)).toEqual([false, true, true]);
  });

  it('still drops an unconfirmed result', () => {
    expect(buildOverallFormFlags(rows)).toHaveLength(3);
  });

  it('drops a row with no embedded match or no date', () => {
    expect(buildOverallFormFlags([{ win_flag: true, match: null }])).toEqual([]);
    expect(
      buildOverallFormFlags([
        { win_flag: true, match: { played_at: null, match_type: 'singles', result_status: 'confirmed' } },
      ])
    ).toEqual([]);
  });
});

describe('deriveSessionCadence', () => {
  // Mondays, Wednesdays and Saturdays of four consecutive weeks in Jan 2026.
  const monWedSat = [
    '2026-01-05', '2026-01-07', '2026-01-10',
    '2026-01-12', '2026-01-14', '2026-01-17',
    '2026-01-19', '2026-01-21', '2026-01-24',
    '2026-01-26', '2026-01-28', '2026-01-31',
  ];

  it('reads a steady three-a-week term', () => {
    expect(deriveSessionCadence(monWedSat)).toEqual({ perWeek: 3, weekdays: ['MON', 'WED', 'SAT'] });
  });

  it('is null with too few weeks to call it a rhythm', () => {
    expect(deriveSessionCadence(monWedSat.slice(0, 6))).toBeNull();
    expect(deriveSessionCadence([])).toBeNull();
  });

  it('tolerates one odd week but not a term with no pattern', () => {
    // Week 3 gains a Friday; three of the four weeks still agree.
    const oneOddWeek = [...monWedSat, '2026-01-23'];
    expect(deriveSessionCadence(oneOddWeek)?.weekdays).toEqual(['MON', 'WED', 'SAT']);

    // Every week different: no cadence to state.
    const scattered = ['2026-01-05', '2026-01-13', '2026-01-22', '2026-01-30'];
    expect(deriveSessionCadence(scattered)).toBeNull();
  });

  it('files a Monday session under Monday rather than the Sunday before it', () => {
    // The UTC-parsing bug this guards against would report SUN, not MON.
    const mondays = ['2026-01-05', '2026-01-12', '2026-01-19'];
    expect(deriveSessionCadence(mondays)).toEqual({ perWeek: 1, weekdays: ['MON'] });
  });

  it('ignores an unparseable date instead of inventing a weekday for it', () => {
    expect(deriveSessionCadence([...monWedSat, 'not-a-date'])?.perWeek).toBe(3);
  });
});

describe('deriveForm', () => {
  it('counts wins and losses over the trimmed window, oldest first', () => {
    const f = deriveForm([true, false, true, true]);
    expect(f.results).toEqual(['W', 'L', 'W', 'W']);
    expect(f.wins).toBe(3);
    expect(f.losses).toBe(1);
  });

  it('drops undecided results rather than drawing a third colour', () => {
    const f = deriveForm([true, null, false, null]);
    expect(f.results).toEqual(['W', 'L']);
  });

  it('keeps only the most recent `limit` results', () => {
    const f = deriveForm([true, true, true, false, false], 2);
    expect(f.results).toEqual(['L', 'L']);
  });

  it('reports a win streak as positive and a loss streak as negative', () => {
    expect(deriveForm([false, true, true, true]).streak).toBe(3);
    expect(deriveForm([true, false, false]).streak).toBe(-2);
  });

  it('counts a streak over the full history even when the strip is shorter', () => {
    const flags = Array.from({ length: 14 }, () => true);
    expect(deriveForm(flags, 10).streak).toBe(14);
    expect(deriveForm(flags, 10).results).toHaveLength(10);
  });

  it('is a zero streak with no decided results', () => {
    expect(deriveForm([]).streak).toBe(0);
    expect(deriveForm([null, null]).streak).toBe(0);
  });
});

describe('deriveAttendance', () => {
  const sessions = [
    { id: 's1', date: '2026-01-01', track: 'all' },
    { id: 's2', date: '2026-01-08', track: 'all' },
    { id: 's3', date: '2026-01-15', track: 'competitive' },
    { id: 's4', date: '2026-01-22', track: 'all' },
  ];

  it('counts a skipped session as an absence even though it has no attendance row', () => {
    const a = deriveAttendance(sessions, [{ session_id: 's1', status: 'checked_in' }], 'competitive');
    expect(a.total).toBe(4);
    expect(a.attended).toBe(1);
    expect(a.ratePct).toBe(25);
    expect(a.cells.map((c) => c.attended)).toEqual([true, false, false, false]);
  });

  it('excludes sessions aimed at a track the member is not in', () => {
    const a = deriveAttendance(sessions, [], 'recreational');
    expect(a.total).toBe(3);
    expect(a.cells.map((c) => c.sessionId)).toEqual(['s1', 's2', 's4']);
  });

  it('shows only open-to-all sessions to a member with no track', () => {
    expect(deriveAttendance(sessions, [], null).total).toBe(3);
  });

  it('treats an admin-confirmed present the same as a self check-in', () => {
    const a = deriveAttendance(sessions, [{ session_id: 's2', status: 'present' }], 'competitive');
    expect(a.cells[1]?.attended).toBe(true);
  });

  it('counts no_show and excused as absences', () => {
    const a = deriveAttendance(
      sessions,
      [
        { session_id: 's1', status: 'no_show' },
        { session_id: 's2', status: 'excused' },
      ],
      'competitive'
    );
    expect(a.attended).toBe(0);
  });

  it('breaks the current streak on a missed session', () => {
    const a = deriveAttendance(
      sessions,
      [
        { session_id: 's1', status: 'checked_in' },
        { session_id: 's2', status: 'checked_in' },
        { session_id: 's4', status: 'checked_in' },
      ],
      'competitive'
    );
    expect(a.currentStreak).toBe(1);
    expect(a.bestStreak).toBe(2);
  });

  it('counts a full record as one unbroken streak', () => {
    const a = deriveAttendance(
      sessions,
      sessions.map((s) => ({ session_id: s.id, status: 'checked_in' })),
      'competitive'
    );
    expect(a.currentStreak).toBe(4);
    expect(a.bestStreak).toBe(4);
    expect(a.ratePct).toBe(100);
  });

  it('orders cells oldest first regardless of the query order', () => {
    const a = deriveAttendance([...sessions].reverse(), [], 'competitive');
    expect(a.cells.map((c) => c.date)).toEqual(['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22']);
  });

  it('reports a zero rate rather than NaN when no session was eligible', () => {
    const a = deriveAttendance([], [], 'competitive');
    expect(a.ratePct).toBe(0);
    expect(a.total).toBe(0);
    expect(a.currentStreak).toBe(0);
  });
});

describe('formatSigned', () => {
  it('signs positives and negatives and leaves zero bare', () => {
    expect(formatSigned(12)).toBe('+12');
    expect(formatSigned(-4)).toBe('−4');
    expect(formatSigned(0)).toBe('0');
  });
});
