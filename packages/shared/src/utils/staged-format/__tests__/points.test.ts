import { describe, it, expect } from 'vitest';
import {
  LEGACY_KNOCKOUT_POINTS,
  LEGACY_ROUND_ROBIN_POINTS,
  addPointsBand,
  bandsToByPlace,
  defaultPointsTable,
  isDefaultPointsTable,
  normalizePointsConfig,
  parsePointsTable,
  pointsBandLabel,
  pointsBands,
  pointsFor,
  pointsForPlace,
  removePointsBand,
  setPointsBandEnd,
} from '../index';
import { formatConfigSchema, formatPointsSchema } from '../schema';
import { poolsThenPlacement } from '../presets';

// A copy of the if-chain finalize.ts paid a knockout by before 00275, kept here
// so the default table is checked against what it replaced and not against
// itself.
function oldKnockoutPoints(pos: number): number {
  if (pos === 1) return 100;
  if (pos === 2) return 75;
  if (pos === 3) return 50;
  if (pos === 4) return 40;
  if (pos <= 8) return 25;
  return 10;
}

describe('the default tables', () => {
  it('pays a knockout exactly as the old if-chain did, places 1 to 40', () => {
    for (const format of ['single_elimination', 'pool_to_bracket']) {
      const table = defaultPointsTable(format);
      for (let place = 1; place <= 40; place++) {
        expect(pointsForPlace(table, place, 0), `${format} ${place}`).toBe(oldKnockoutPoints(place));
      }
    }
  });

  it('pays a round robin 1 to take part and 3 a win, whatever the place', () => {
    const table = defaultPointsTable('round_robin');
    for (const [place, wins] of [[1, 4], [2, 0], [7, 2]] as const) {
      expect(pointsForPlace(table, place, wins)).toBe(1 + 3 * wins);
    }
    expect(pointsForPlace(table, null, 2)).toBe(7);
  });

  it('follows a staged event\'s last stage', () => {
    expect(defaultPointsTable('staged', 'groups')).toEqual(LEGACY_ROUND_ROBIN_POINTS);
    expect(defaultPointsTable('staged', 'knockout')).toEqual(LEGACY_KNOCKOUT_POINTS);
    expect(defaultPointsTable('staged', 'matches')).toEqual(LEGACY_KNOCKOUT_POINTS);
  });

  it('hands out a copy, so a caller cannot edit the default', () => {
    defaultPointsTable('single_elimination').byPlace[0] = 1;
    expect(defaultPointsTable('single_elimination').byPlace[0]).toBe(100);
  });

  it('keeps pointsFor on a staged config with no table as it was', () => {
    const groupsLast = poolsThenPlacement();
    groupsLast.stages = groupsLast.stages.slice(0, 1);
    expect(groupsLast.stages[0]!.kind).toBe('groups');
    expect(pointsFor(groupsLast, 1, 4)).toBe(13);
  });
});

describe('a custom table', () => {
  it('pays rest past the end of byPlace, and nothing for an unplaced entry', () => {
    const table = { byPlace: [50, 30], rest: 5, participation: 2, perWin: 1 };
    expect(pointsForPlace(table, 1, 3)).toBe(55);
    expect(pointsForPlace(table, 2, 0)).toBe(32);
    expect(pointsForPlace(table, 9, 1)).toBe(8);
    expect(pointsForPlace(table, null, 1)).toBe(3);
  });

  it('pays 0 past the end when rest is not set', () => {
    expect(pointsForPlace({ byPlace: [10], participation: 0, perWin: 0 }, 2, 0)).toBe(0);
  });

  it('is read by pointsFor on a staged config', () => {
    const cfg = { ...poolsThenPlacement(), points: { byPlace: [9, 6], rest: 1, participation: 0, perWin: 2 } };
    expect(pointsFor(cfg, 1, 2)).toBe(13);
    expect(pointsFor(cfg, 20, 0)).toBe(1);
  });
});

describe('bands', () => {
  it('reads the knockout default as 1st, 2nd, 3rd, 4th, 5th to 8th', () => {
    const bands = pointsBands(LEGACY_KNOCKOUT_POINTS);
    expect(bands.map(pointsBandLabel)).toEqual(['1st', '2nd', '3rd', '4th', '5th to 8th']);
    expect(bands[4]).toEqual({ from: 5, to: 8, points: 25 });
  });

  it('round-trips through byPlace', () => {
    for (const byPlace of [[100, 75, 50, 40, 25, 25, 25, 25], [], [3, 3, 3], [9, 1, 9]]) {
      expect(bandsToByPlace(pointsBands({ byPlace }))).toEqual(byPlace);
    }
  });

  it('fills a gap with rest', () => {
    expect(bandsToByPlace([{ from: 1, to: 1, points: 10 }, { from: 3, to: 3, points: 4 }], 2)).toEqual([10, 2, 4]);
  });

  it('moves the rows after a changed end, keeping their widths', () => {
    const bands = pointsBands(LEGACY_KNOCKOUT_POINTS);
    const next = setPointsBandEnd(bands, 3, 6);
    expect(next.map(pointsBandLabel)).toEqual(['1st', '2nd', '3rd', '4th to 6th', '7th to 10th']);
    expect(setPointsBandEnd(bands, 3, 2)).toEqual(bands);
  });

  it('closes up when a row is removed, and adds one place at a time', () => {
    const bands = pointsBands(LEGACY_KNOCKOUT_POINTS);
    expect(removePointsBand(bands, 0).map(pointsBandLabel)).toEqual(['1st', '2nd', '3rd', '4th to 7th']);
    expect(addPointsBand(bands, 10).at(-1)).toEqual({ from: 9, to: 9, points: 10 });
    expect(addPointsBand([{ from: 1, to: 128, points: 1 }], 0)).toHaveLength(1);
  });

  it('never runs past place 128', () => {
    const next = setPointsBandEnd([{ from: 1, to: 1, points: 1 }, { from: 2, to: 2, points: 0 }], 0, 128);
    expect(next).toEqual([{ from: 1, to: 128, points: 1 }]);
  });
});

describe('normalizePointsConfig', () => {
  it('stores nothing for no table or the default', () => {
    expect(normalizePointsConfig('single_elimination', null)).toEqual({ ok: true, table: null });
    expect(normalizePointsConfig('single_elimination', LEGACY_KNOCKOUT_POINTS)).toEqual({ ok: true, table: null });
    expect(normalizePointsConfig('round_robin', { byPlace: [], participation: 1, perWin: 3 })).toEqual({ ok: true, table: null });
  });

  it('clears the per-win figure on a knockout, so a table that differs only there is the default', () => {
    expect(normalizePointsConfig('pool_to_bracket', { ...LEGACY_KNOCKOUT_POINTS, perWin: 5 })).toEqual({ ok: true, table: null });
    expect(normalizePointsConfig('single_elimination', { byPlace: [10], rest: 1, participation: 0, perWin: 4 }))
      .toEqual({ ok: true, table: { byPlace: [10], rest: 1, participation: 0, perWin: 0 } });
  });

  it('keeps a round robin\'s per-win figure and fills in rest', () => {
    expect(normalizePointsConfig('round_robin', { byPlace: [5], participation: 1, perWin: 2 }))
      .toEqual({ ok: true, table: { byPlace: [5], rest: 0, participation: 1, perWin: 2 } });
  });

  it('refuses garbage in words', () => {
    const res = normalizePointsConfig('round_robin', { byPlace: [-1], participation: 1, perWin: 3 });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/^The points table is not set out correctly/);
    expect(normalizePointsConfig('round_robin', 'lots').ok).toBe(false);
  });

  it('isDefaultPointsTable treats a missing rest as 0', () => {
    expect(isDefaultPointsTable('round_robin', { byPlace: [], participation: 1, perWin: 3 })).toBe(true);
    expect(isDefaultPointsTable('single_elimination', { byPlace: [100, 75, 50, 40, 25, 25, 25, 25], participation: 0, perWin: 0 })).toBe(false);
  });
});

describe('the stored shape', () => {
  it('parses a table, and null on garbage', () => {
    expect(parsePointsTable({ byPlace: [3], rest: 1, participation: 0, perWin: 0 })).toEqual({ byPlace: [3], rest: 1, participation: 0, perWin: 0 });
    expect(parsePointsTable(null)).toBeNull();
    expect(parsePointsTable({ byPlace: 'x' })).toBeNull();
    expect(parsePointsTable([1, 2])).toBeNull();
  });

  it('still reads a config saved with the old bonuses key, and drops it', () => {
    const old = { byPlace: [10, 5], participation: 1, perWin: 2, bonuses: { enabled: true, byPlace: [3] } };
    const parsed = formatPointsSchema.parse(old);
    expect(parsed).toEqual({ byPlace: [10, 5], participation: 1, perWin: 2 });
    const cfg = formatConfigSchema.parse({ ...poolsThenPlacement(), points: old });
    expect(cfg.points).toEqual({ byPlace: [10, 5], participation: 1, perWin: 2 });
  });
});
