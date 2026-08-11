import { describe, expect, it } from 'vitest';
import {
  buildFormRun,
  buildRatingSeries,
  sparklineGeometry,
  type ParticipationPoint,
} from '@/lib/feed-series';

function point(over: Partial<ParticipationPoint> = {}): ParticipationPoint {
  return {
    playedAt: '2026-01-01T00:00:00Z',
    matchType: 'singles',
    rated: true,
    seasonId: 'season-a',
    postRating: 800,
    winFlag: true,
    ...over,
  };
}

describe('buildRatingSeries', () => {
  it('returns null when the member has never played a rated match', () => {
    expect(buildRatingSeries([], 'singles')).toBeNull();
  });

  it('keeps only the requested format', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-01-01T00:00:00Z', matchType: 'singles', postRating: 800 }),
        point({ playedAt: '2026-01-02T00:00:00Z', matchType: 'doubles', postRating: 500 }),
        point({ playedAt: '2026-01-03T00:00:00Z', matchType: 'singles', postRating: 830 }),
      ],
      'singles',
    );
    expect(series?.ratings).toEqual([800, 830]);
  });

  it('drops unrated matches and rows with no post_rating', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-01-01T00:00:00Z', postRating: 800 }),
        point({ playedAt: '2026-01-02T00:00:00Z', rated: false, postRating: 999 }),
        point({ playedAt: '2026-01-03T00:00:00Z', postRating: null }),
        point({ playedAt: '2026-01-04T00:00:00Z', postRating: 815 }),
      ],
      'singles',
    );
    // A null post_rating must not become a 0 — that would draw a cliff.
    expect(series?.ratings).toEqual([800, 815]);
    expect(series?.min).toBe(800);
    expect(series?.max).toBe(815);
  });

  it('orders oldest-first regardless of the order rows arrive in', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-03-01T00:00:00Z', postRating: 870 }),
        point({ playedAt: '2026-01-01T00:00:00Z', postRating: 800 }),
        point({ playedAt: '2026-02-01T00:00:00Z', postRating: 845 }),
      ],
      'singles',
    );
    expect(series?.ratings).toEqual([800, 845, 870]);
    expect(series?.first).toBe(800);
    expect(series?.last).toBe(870);
    expect(series?.change).toBe(70);
  });

  it('keeps the most recent maxPoints, not the first ones seen', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      point({ playedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, postRating: 700 + i }),
    );
    const series = buildRatingSeries(rows, 'singles', 5);
    expect(series?.ratings).toEqual([715, 716, 717, 718, 719]);
  });

  it('reports a negative change when the rating fell', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-01-01T00:00:00Z', postRating: 900 }),
        point({ playedAt: '2026-01-02T00:00:00Z', postRating: 862 }),
      ],
      'singles',
    );
    expect(series?.change).toBe(-38);
  });

  it('marks the index where the season changed', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-01-01T00:00:00Z', seasonId: 'fall', postRating: 800 }),
        point({ playedAt: '2026-01-02T00:00:00Z', seasonId: 'fall', postRating: 810 }),
        point({ playedAt: '2026-01-03T00:00:00Z', seasonId: 'spring', postRating: 790 }),
      ],
      'singles',
    );
    expect(series?.seasonBreaks).toEqual([2]);
  });

  it('does not invent a boundary when a season id is missing', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-01-01T00:00:00Z', seasonId: 'fall', postRating: 800 }),
        point({ playedAt: '2026-01-02T00:00:00Z', seasonId: null, postRating: 810 }),
        point({ playedAt: '2026-01-03T00:00:00Z', seasonId: 'fall', postRating: 820 }),
      ],
      'singles',
    );
    expect(series?.seasonBreaks).toEqual([]);
  });
});

describe('sparklineGeometry', () => {
  it('draws no line for a single point but still places the dot', () => {
    const series = buildRatingSeries([point({ postRating: 800 })], 'singles')!;
    const geo = sparklineGeometry(series, 100, 40);
    expect(geo.polyline).toBe('');
    expect(geo.area).toBe('');
    expect(geo.dots).toHaveLength(1);
    expect(geo.dots[0]?.x).toBe(50);
  });

  it('centres a flat run instead of dividing by a zero range', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-01-01T00:00:00Z', postRating: 800 }),
        point({ playedAt: '2026-01-02T00:00:00Z', postRating: 800 }),
      ],
      'singles',
    )!;
    const geo = sparklineGeometry(series, 100, 40, 4);
    expect(geo.dots.every((d) => Number.isFinite(d.y))).toBe(true);
    // (40 - 8) / 2 + 4 — the vertical middle of the inner box.
    expect(geo.dots.map((d) => d.y)).toEqual([20, 20]);
  });

  it('puts the highest rating at the top of the box and the lowest at the bottom', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-01-01T00:00:00Z', postRating: 700 }),
        point({ playedAt: '2026-01-02T00:00:00Z', postRating: 900 }),
      ],
      'singles',
    )!;
    const geo = sparklineGeometry(series, 100, 40, 4);
    expect(geo.dots[0]?.y).toBe(36);
    expect(geo.dots[1]?.y).toBe(4);
  });

  it('places a season rule between the two points it separates', () => {
    const series = buildRatingSeries(
      [
        point({ playedAt: '2026-01-01T00:00:00Z', seasonId: 'fall', postRating: 800 }),
        point({ playedAt: '2026-01-02T00:00:00Z', seasonId: 'spring', postRating: 810 }),
      ],
      'singles',
    )!;
    const geo = sparklineGeometry(series, 100, 40, 4);
    expect(geo.breaks).toEqual([50]);
  });
});

describe('buildFormRun', () => {
  it('counts nothing when there is nothing decided', () => {
    expect(buildFormRun([])).toEqual({ results: [], wins: 0, losses: 0 });
  });

  it('leaves out matches whose result is still unconfirmed', () => {
    const run = buildFormRun([
      point({ playedAt: '2026-01-01T00:00:00Z', winFlag: true }),
      point({ playedAt: '2026-01-02T00:00:00Z', winFlag: null }),
      point({ playedAt: '2026-01-03T00:00:00Z', winFlag: false }),
    ]);
    expect(run).toEqual({ results: ['win', 'loss'], wins: 1, losses: 1 });
  });

  it('counts both formats — form is form', () => {
    const run = buildFormRun([
      point({ playedAt: '2026-01-01T00:00:00Z', matchType: 'singles', winFlag: true }),
      point({ playedAt: '2026-01-02T00:00:00Z', matchType: 'doubles', winFlag: true }),
    ]);
    expect(run.wins).toBe(2);
  });

  it('reads oldest-first and keeps only the last maxResults', () => {
    const rows = [
      point({ playedAt: '2026-01-01T00:00:00Z', winFlag: false }),
      point({ playedAt: '2026-01-02T00:00:00Z', winFlag: true }),
      point({ playedAt: '2026-01-03T00:00:00Z', winFlag: true }),
    ];
    expect(buildFormRun(rows, 2).results).toEqual(['win', 'win']);
  });
});
