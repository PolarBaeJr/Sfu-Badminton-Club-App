import { describe, it, expect } from 'vitest';
import {
  buildBars,
  buildRunningAreaPath,
  buildRunningPath,
  buildRunningTotal,
  computeRunningScale,
  type ChartBox,
} from '../dashboard-charts';

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
