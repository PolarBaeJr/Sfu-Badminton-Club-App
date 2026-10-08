import { describe, it, expect } from 'vitest';
import {
  buildBars,
  buildColumns,
  buildHistogram,
  buildRunningAreaPath,
  buildRunningPath,
  buildRunningTotal,
  buildSplit,
  computeRunningScale,
  computeSignedRunningScale,
  type ChartBox,
} from '../charts';

// THE CHARTS' ARITHMETIC, WHICH IS THE ONLY PART OF A CHART A TEST CAN SEE.
//
// A path string is unreadable once rendered: a scale that puts every point
// off-canvas, a domain taken from the wrong dates, a flat series dividing by a
// zero range — each of those draws something entirely plausible and wrong, and
// the person who would notice is the treasurer, six weeks later, with the
// club's money on the screen. So the geometry is pure and it is pinned here.
//
// `dayOf` is passed in as a plain slice for these tests. In the console it is
// the club-timezone formatter, and the reason it is injected at all is the case
// asserted below: a payment recorded at 19:00 Pacific is the NEXT day in UTC,
// and bucketing on the raw timestamp files half the club's evening payments
// under tomorrow.
const utcDay = (iso: string) => iso.slice(0, 10);

const BOX: ChartBox = { width: 320, height: 96, padY: 8, padX: 2 };

describe('buildRunningTotal', () => {
  it('accumulates, bucketed by day, oldest first', () => {
    const points = buildRunningTotal(
      [
        { at: '2026-09-11T18:00:00+00:00', cents: 1600 },
        { at: '2026-09-04T18:00:00+00:00', cents: 8400 },
        { at: '2026-09-04T20:00:00+00:00', cents: 600 },
      ],
      utcDay,
    );

    expect(points).toEqual([
      { day: '2026-09-04', cents: 9000, count: 2 },
      { day: '2026-09-11', cents: 10600, count: 1 },
    ]);
  });

  // The whole reason dayOf is a parameter. Two payments taken on the same club
  // evening must be one step, not two days apart.
  it('buckets by the day the CALLER names, not by the raw timestamp', () => {
    const payments = [
      { at: '2026-09-04T23:00:00+00:00', cents: 100 },
      { at: '2026-09-05T02:00:00+00:00', cents: 200 },
    ];

    expect(buildRunningTotal(payments, utcDay)).toHaveLength(2);
    // A club-local reading puts both on the 4th — one evening, one step.
    expect(buildRunningTotal(payments, () => '2026-09-04')).toEqual([
      { day: '2026-09-04', cents: 300, count: 2 },
    ]);
  });

  // A row with no date cannot be placed on a time axis, and placing it at the
  // start would move money earlier in the term.
  it('drops undated payments rather than placing them', () => {
    expect(
      buildRunningTotal([{ at: '', cents: 5000 }, { at: '2026-09-04T00:00:00Z', cents: 100 }], utcDay),
    ).toEqual([{ day: '2026-09-04', cents: 100, count: 1 }]);
  });

  it('has nothing to accumulate for an empty ledger', () => {
    expect(buildRunningTotal([], utcDay)).toEqual([]);
  });
});

describe('computeRunningScale', () => {
  // THE REFUSAL THAT MATTERS. One payment day stretched across the box draws a
  // flat line reading "nothing happened all term" over a ledger where
  // everything happened at once.
  it('refuses to scale fewer than two days', () => {
    expect(computeRunningScale([], BOX)).toBeNull();
    expect(computeRunningScale([{ day: '2026-09-04', cents: 9000, count: 2 }], BOX)).toBeNull();
  });

  it('spans the first and last day, edge to edge inside the padding', () => {
    const points = [
      { day: '2026-07-22', cents: 30000, count: 1 },
      { day: '2026-08-07', cents: 56400, count: 3 },
    ];
    const scale = computeRunningScale(points, BOX)!;

    expect(scale.firstDay).toBe('2026-07-22');
    expect(scale.lastDay).toBe('2026-08-07');
    expect(scale.x('2026-07-22')).toBe(BOX.padX);
    expect(scale.x('2026-08-07')).toBe(BOX.width - BOX.padX);
    // Halfway through the window, halfway across the box. A date axis that was
    // secretly an index axis would put an evenly spaced point here regardless.
    expect(scale.x('2026-07-30')).toBeCloseTo(BOX.padX + (BOX.width - BOX.padX * 2) / 2, 1);
  });

  // THE TRAP THIS PROJECT ACTUALLY HAS. Staging's Fall 2026 season runs 1 Sep
  // to 31 Dec and every one of its expenses is dated in July and August,
  // because money is filed against a season by a stamped season_id and not by
  // its dates (00069). A scale taken from the season row would put every point
  // off-canvas to the left and draw an empty chart over a ledger with money in
  // it — so the domain comes from the data, and this is what that means.
  it('takes its domain from the payments, not from any season window', () => {
    const points = [
      { day: '2026-07-22', cents: 30000, count: 1 },
      { day: '2026-08-07', cents: 56400, count: 1 },
    ];
    const scale = computeRunningScale(points, BOX)!;

    for (const point of points) {
      expect(scale.x(point.day)).toBeGreaterThanOrEqual(BOX.padX);
      expect(scale.x(point.day)).toBeLessThanOrEqual(BOX.width - BOX.padX);
    }
  });

  // A cumulative curve whose baseline is not zero is not a cumulative curve: it
  // would exaggerate every step after the first.
  it('pins the value axis to zero at the floor', () => {
    const scale = computeRunningScale(
      [
        { day: '2026-09-01', cents: 50000, count: 1 },
        { day: '2026-09-08', cents: 60000, count: 1 },
      ],
      BOX,
    )!;

    expect(scale.y(0)).toBe(BOX.height - BOX.padY);
    expect(scale.y(60000)).toBeLessThan(scale.y(50000));
    // Clamped, so a stray value cannot escape the box.
    expect(scale.y(-1)).toBe(BOX.height - BOX.padY);
    expect(scale.y(1e12)).toBe(BOX.padY);
  });

  // A season of nothing but waived fees is a ledger of paid rows worth zero.
  // Dividing by that range would put NaN in every coordinate.
  it('does not divide by zero for a ledger of zero-value rows', () => {
    const scale = computeRunningScale(
      [
        { day: '2026-09-01', cents: 0, count: 1 },
        { day: '2026-09-08', cents: 0, count: 1 },
      ],
      BOX,
    )!;

    expect(Number.isFinite(scale.y(0))).toBe(true);
    expect(Number.isFinite(scale.x('2026-09-08'))).toBe(true);
  });
});

// THE NET POSITION IS THE ONE SERIES THAT CAN GO BELOW ZERO, and every
// assertion here is about the lie the unsigned scale would tell if it were
// used for it. That lie is not hypothetical: computeRunningScale clamps at
// zero, so a club that spent the term underwater would draw as a flat line
// along the baseline reading "we broke even all term".
describe('computeSignedRunningScale', () => {
  const underwater = [
    { day: '2026-09-01', cents: 20000, count: 1 },
    { day: '2026-09-15', cents: -30000, count: 2 },
    { day: '2026-10-01', cents: -5000, count: 1 },
  ];

  // The whole reason this function exists, stated against its sibling.
  it('separates negative days that the unsigned scale collapses onto the floor', () => {
    const unsigned = computeRunningScale(underwater, BOX)!;
    const signed = computeSignedRunningScale(underwater, BOX)!;

    // Unsigned: -30000 and -5000 are two different states of the club's money
    // and land on exactly the same pixel.
    expect(unsigned.y(-30000)).toBe(unsigned.y(-5000));
    // Signed: the worse day is lower on the screen than the better one.
    expect(signed.y(-30000)).toBeGreaterThan(signed.y(-5000));
    expect(signed.y(-5000)).toBeGreaterThan(signed.y(20000));
  });

  // Below the rule must LOOK below the rule. A negative value drawn at or above
  // the zero line is the same lie in a different place.
  it('puts every negative day below the break-even rule and every positive above', () => {
    const scale = computeSignedRunningScale(underwater, BOX)!;
    const zero = scale.y(0);

    expect(scale.y(-30000)).toBeGreaterThan(zero);
    expect(scale.y(-5000)).toBeGreaterThan(zero);
    expect(scale.y(20000)).toBeLessThan(zero);
    // And zero is genuinely inside the box rather than clamped to an edge.
    expect(zero).toBeGreaterThan(BOX.padY);
    expect(zero).toBeLessThan(BOX.height - BOX.padY);
  });

  // A term that never went into the red must not be redrawn on a domain that
  // reserves half the box for a state it was never in — the curve would be
  // squashed into the top half for no reason.
  it('is the unsigned scale exactly when the series never goes negative', () => {
    const positive = [
      { day: '2026-09-01', cents: 20000, count: 1 },
      { day: '2026-09-15', cents: 56000, count: 2 },
    ];
    const unsigned = computeRunningScale(positive, BOX)!;
    const signed = computeSignedRunningScale(positive, BOX)!;

    expect(signed.minCents).toBe(0);
    expect(signed.maxCents).toBe(unsigned.maxCents);
    expect(signed.y(0)).toBeCloseTo(unsigned.y(0), 6);
    expect(signed.y(56000)).toBeCloseTo(unsigned.y(56000), 6);
  });

  // ZERO IS ALWAYS IN THE DOMAIN. A term entirely in the red still has to show
  // the line it is under — "how far below break-even" is the whole content of
  // the chart, and a domain fitted to the data alone would put the worst day at
  // the floor and the least-bad day at the ceiling and say nothing about which
  // side of the line either was on.
  it('keeps break-even on the chart for a term that was never above it', () => {
    const scale = computeSignedRunningScale(
      [
        { day: '2026-09-01', cents: -8000, count: 1 },
        { day: '2026-09-15', cents: -42000, count: 3 },
      ],
      BOX,
    )!;

    expect(scale.maxCents).toBe(0);
    expect(scale.y(0)).toBe(BOX.padY);
    expect(scale.y(-42000)).toBeGreaterThan(scale.y(-8000));
    expect(scale.y(-42000)).toBeLessThanOrEqual(BOX.height - BOX.padY);
  });

  // The same refusal as the unsigned scale: one day is a dot, and a dot
  // stretched across the box reads as a flat line.
  it('refuses to scale fewer than two days', () => {
    expect(computeSignedRunningScale([], BOX)).toBeNull();
    expect(computeSignedRunningScale([{ day: '2026-09-04', cents: -900, count: 2 }], BOX)).toBeNull();
  });

  // A season that netted exactly zero on every day has no range to divide.
  it('does not divide by zero for a season that broke even every day', () => {
    const scale = computeSignedRunningScale(
      [
        { day: '2026-09-01', cents: 0, count: 2 },
        { day: '2026-09-08', cents: 0, count: 2 },
      ],
      BOX,
    )!;

    expect(Number.isFinite(scale.y(0))).toBe(true);
    expect(Number.isFinite(scale.y(-1))).toBe(true);
  });

  // The step path and the wash both open at y(0), so they follow a signed scale
  // with no change — which is why this is a new scale and not a new chart.
  it('draws a path that opens at break-even and dips below it', () => {
    const scale = computeSignedRunningScale(underwater, BOX)!;
    const d = buildRunningPath(underwater, scale);

    expect(d.startsWith(`M${scale.x('2026-09-01')},`)).toBe(true);
    // The opening move is a vertical from break-even to the first value, so the
    // floor of the path is the zero rule and not the bottom of the box.
    expect(d).toContain(`,${Math.round(scale.y(0) * 100) / 100} V`);
    expect(buildRunningAreaPath(underwater, scale).endsWith('Z')).toBe(true);
  });
});

describe('the running-total path', () => {
  const points = [
    { day: '2026-09-01', cents: 1000, count: 1 },
    { day: '2026-09-08', cents: 2500, count: 2 },
  ];
  const scale = computeRunningScale(points, BOX)!;

  // A STEP, NEVER A DIAGONAL. A slope between two payment days claims the total
  // was rising through the days between them, and nothing happened until the
  // next payment landed.
  it('steps rather than sloping, and opens at the zero floor', () => {
    const d = buildRunningPath(points, scale);

    expect(d.startsWith(`M${scale.x('2026-09-01')},${scale.y(0)}`)).toBe(true);
    // Only vertical and horizontal moves after the opening M. An `L` anywhere
    // in here is a diagonal, which is the distortion the step shape refuses.
    expect(d.replace(/^M[^ ]+ /, '').split(' ').every((seg) => /^[HV]/.test(seg))).toBe(true);
    expect(d).not.toContain('L');
    // One riser per day plus the opening one off the floor.
    expect(d.match(/V/g)).toHaveLength(points.length);
  });

  it('draws nothing for an empty series', () => {
    expect(buildRunningPath([], scale)).toBe('');
    // A wash with no curve over it is a filled rectangle claiming to be data.
    expect(buildRunningAreaPath([], scale)).toBe('');
    expect(buildRunningAreaPath([points[0]!], scale)).toBe('');
  });

  it('closes the wash back down to the baseline', () => {
    const area = buildRunningAreaPath(points, scale);
    expect(area.endsWith(`L${scale.x('2026-09-08')},${scale.y(0)} Z`)).toBe(true);
  });
});

describe('buildBars', () => {
  // MEASURED AGAINST THE BIGGEST PART, NOT AGAINST THEIR SUM. "In" and "Out"
  // are not slices of one whole, and drawing them as though they were would be
  // a chart of a quantity that does not exist.
  it('scales every row against the largest of them', () => {
    expect(buildBars([{ label: 'In', cents: 15500 }, { label: 'Out', cents: 56400 }])).toEqual([
      { label: 'In', cents: 15500, pct: (15500 / 56400) * 100 },
      { label: 'Out', cents: 56400, pct: 100 },
    ]);
  });

  it('keeps the order it was given', () => {
    const rows = buildBars([{ label: 'a', cents: 1 }, { label: 'b', cents: 9 }]);
    expect(rows.map((r) => r.label)).toEqual(['a', 'b']);
  });

  // An empty track beside "$0.00" is the truth; a minimum-width stub would be a
  // shape standing for nothing.
  it('draws no bar at all for a set that is entirely zero', () => {
    expect(buildBars([{ label: 'In', cents: 0 }, { label: 'Out', cents: 0 }]).map((r) => r.pct))
      .toEqual([0, 0]);
  });

  it('clamps a negative part to a zero-width bar rather than mirroring it', () => {
    expect(buildBars([{ label: 'a', cents: -500 }, { label: 'b', cents: 500 }])[0]!.pct).toBe(0);
  });

  it('has no rows for no parts', () => {
    expect(buildBars([])).toEqual([]);
  });
});

describe('buildColumns', () => {
  // ORDER IS THE POINT. Columns are for categories whose sequence means
  // something — a run of session dates, a bracket — so nothing here sorts.
  it('keeps the order it was given and scales against the tallest total', () => {
    const columns = buildColumns([
      { label: '4 AUG', value: 15, under: 3 },
      { label: '6 AUG', value: 16, under: 2 },
      { label: '11 AUG', value: 16, under: 2 },
    ]);

    expect(columns.map((c) => c.label)).toEqual(['4 AUG', '6 AUG', '11 AUG']);
    expect(columns.map((c) => c.total)).toEqual([18, 18, 18]);
    expect(columns[0]!.pct).toBeCloseTo((15 / 18) * 100, 5);
    expect(columns[0]!.underPct).toBeCloseTo((3 / 18) * 100, 5);
  });

  // A session nobody has checked into yet is a real answer, and the honest
  // drawing of it is an empty tick with "0" printed under it — not a stub that
  // implies somebody came.
  it('draws nothing at all for a column of zero', () => {
    const columns = buildColumns([
      { label: 'a', value: 16 },
      { label: 'b', value: 0 },
    ]);
    expect(columns[1]!.pct).toBe(0);
  });

  it('gives every column zero height when the whole set is zero', () => {
    expect(
      buildColumns([{ label: 'a', value: 0 }, { label: 'b', value: 0 }]).map((c) => c.pct),
    ).toEqual([0, 0]);
  });

  it('has no columns for no parts', () => {
    expect(buildColumns([])).toEqual([]);
  });
});

describe('buildHistogram', () => {
  it('bins values into equal-width bands over their own range', () => {
    const h = buildHistogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
    expect(h.bins.map((b) => b.count)).toEqual([2, 2, 2, 2, 2]);
    expect(h.min).toBe(0);
    expect(h.max).toBe(9);
    expect(h.total).toBe(10);
    expect(h.peak).toBe(2);
  });

  // Without the clamp the best-rated member lands one bin past the last and
  // gets a private band nobody else can reach.
  it('clamps the top value into the last bin rather than past it', () => {
    const h = buildHistogram([100, 200], 4);
    expect(h.bins[3]!.count).toBe(1);
    expect(h.bins.reduce((n, b) => n + b.count, 0)).toBe(2);
  });

  // A brand-new club, or day one of a season: everybody on the starting rating.
  // There is no range to divide, so they go in the middle rather than being
  // piled at an arbitrary end.
  it('puts a flat field in the middle bin', () => {
    const h = buildHistogram([400, 400, 400], 5);
    expect(h.bins.map((b) => b.count)).toEqual([0, 0, 3, 0, 0]);
  });

  // THE SECOND LADDER BUG, and it is a different one from the moiré. A plain
  // floor makes bins of 1, 2, 3 and 4 against a peak of 30 draw identically, so
  // the thin tail — which is most of a ladder — becomes a straight line. Range
  // compression gives every distinct count its own height.
  it('gives distinct counts distinct heights instead of pinning them to a floor', () => {
    const values = [
      ...Array(30).fill(50),
      ...Array(1).fill(10),
      ...Array(2).fill(20),
      ...Array(3).fill(30),
    ];
    const h = buildHistogram(values, 5);
    const occupied = h.bins.filter((b) => b.count > 0).map((b) => b.pct);
    expect(new Set(occupied).size).toBe(occupied.length);
    expect(Math.min(...occupied)).toBeGreaterThan(0);
  });

  // An EMPTY bin draws nothing. The floor is for "somebody is here".
  it('draws no bar for an empty bin', () => {
    const h = buildHistogram([0, 9], 3);
    expect(h.bins[1]!.count).toBe(0);
    expect(h.bins[1]!.pct).toBe(0);
  });

  it('is an absent distribution rather than a flat one when nobody is in it', () => {
    const h = buildHistogram([], 4);
    expect(h.total).toBe(0);
    expect(h.bins).toHaveLength(4);
    expect(h.bins.every((b) => b.count === 0 && b.pct === 0)).toBe(true);
  });
});

describe('buildSplit', () => {
  it('divides a real total into shares that sum to it', () => {
    const split = buildSplit([
      { label: 'Collected', value: 15500 },
      { label: 'Still owed', value: 246500 },
    ]);
    expect(split.total).toBe(262000);
    expect(split.segments.map((s) => s.pct).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 5);
    expect(split.segments[0]!.pct).toBeCloseTo((15500 / 262000) * 100, 5);
  });

  // "Nothing has happened yet" and "it divided evenly" are different states. An
  // even division would claim a shape over an empty ledger.
  it('gives zero-width segments for a zero total, never an even division', () => {
    const split = buildSplit([{ label: 'a', value: 0 }, { label: 'b', value: 0 }]);
    expect(split.total).toBe(0);
    expect(split.segments.map((s) => s.pct)).toEqual([0, 0]);
  });

  it('clamps a negative part rather than letting it shrink the total', () => {
    const split = buildSplit([{ label: 'a', value: -100 }, { label: 'b', value: 100 }]);
    expect(split.total).toBe(100);
    expect(split.segments[0]!.pct).toBe(0);
  });
});
