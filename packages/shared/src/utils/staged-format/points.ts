// The ladder points an event pays for a finish: one table per event.
//
// A legacy event stores its table in tournament_events.points_config (00275);
// a staged event in format_config.points. Absent means the default for the
// format, which is exactly what the code paid before either existed.

import { endsInKnockout } from '../tournament-phases';
import { formatPointsSchema, type FormatPoints, type FormatStage } from './schema';
import { ordinal } from './labels';

/** A knockout: 100/75/50/40, 25 to the rest of the last eight, 10 to everyone else. */
export const LEGACY_KNOCKOUT_POINTS: Readonly<FormatPoints> = Object.freeze({
  byPlace: [100, 75, 50, 40, 25, 25, 25, 25],
  rest: 10,
  participation: 0,
  perWin: 0,
});

/** A round robin: 1 for taking part and 3 a win, nothing for the place itself. */
export const LEGACY_ROUND_ROBIN_POINTS: Readonly<FormatPoints> = Object.freeze({
  byPlace: [],
  rest: 0,
  participation: 1,
  perWin: 3,
});

function copy(t: Readonly<FormatPoints>): FormatPoints {
  return { byPlace: [...t.byPlace], rest: t.rest ?? 0, participation: t.participation, perWin: t.perWin };
}

/**
 * The table an event pays when it has none of its own. A staged event follows
 * its last stage (groups pays like a round robin, anything else like a
 * knockout); a legacy event follows endsInKnockout, as finalize.ts does.
 */
export function defaultPointsTable(format: string | null | undefined, lastStageKind?: FormatStage['kind'] | null): FormatPoints {
  if (format === 'staged') return copy(lastStageKind === 'groups' ? LEGACY_ROUND_ROBIN_POINTS : LEGACY_KNOCKOUT_POINTS);
  return copy(endsInKnockout(format) ? LEGACY_KNOCKOUT_POINTS : LEGACY_ROUND_ROBIN_POINTS);
}

/** Does this format place its field by a knockout, where a win is not paid on its own. */
export function pointsTableIsKnockout(format: string | null | undefined): boolean {
  return format !== 'staged' && endsInKnockout(format);
}

/** Points for one finish. An unplaced entry (null) takes only participation and wins. */
export function pointsForPlace(table: Readonly<FormatPoints>, place: number | null, wins: number): number {
  const placeValue = place == null || place < 1
    ? 0
    : place <= table.byPlace.length ? table.byPlace[place - 1]! : (table.rest ?? 0);
  return placeValue + table.participation + table.perWin * wins;
}

/** A stored table, or null when there is none or it does not read as one. */
export function parsePointsTable(raw: unknown): FormatPoints | null {
  if (raw == null) return null;
  const parsed = formatPointsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function sameTable(a: Readonly<FormatPoints>, b: Readonly<FormatPoints>): boolean {
  return a.byPlace.length === b.byPlace.length
    && a.byPlace.every((v, i) => v === b.byPlace[i])
    && (a.rest ?? 0) === (b.rest ?? 0)
    && a.participation === b.participation
    && a.perWin === b.perWin;
}

/** Is this table the one the format pays anyway. */
export function isDefaultPointsTable(
  format: string | null | undefined,
  table: Readonly<FormatPoints>,
  lastStageKind?: FormatStage['kind'] | null,
): boolean {
  return sameTable(table, defaultPointsTable(format, lastStageKind));
}

/**
 * A points table as it should be stored on a legacy event: checked, with the
 * per-win figure cleared on a knockout (its placings are what pay), and null
 * when it is the format's default so the column stays empty for an event
 * nobody changed.
 */
export function normalizePointsConfig(
  format: string | null | undefined,
  raw: unknown,
): { ok: true; table: FormatPoints | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, table: null };
  const parsed = formatPointsSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `The points table is not set out correctly${first ? `: ${first.message}` : ''}.` };
  }
  const table: FormatPoints = { ...parsed.data, rest: parsed.data.rest ?? 0 };
  if (pointsTableIsKnockout(format)) table.perWin = 0;
  return { ok: true, table: isDefaultPointsTable(format, table) ? null : table };
}

/** One row of the editor: places `from` to `to` each take `points`. */
export interface PointsBand {
  from: number;
  to: number;
  points: number;
}

/** byPlace read as runs of equal points, so 5th to 8th on 25 is one row. */
export function pointsBands(table: Pick<FormatPoints, 'byPlace'>): PointsBand[] {
  const bands: PointsBand[] = [];
  table.byPlace.forEach((points, i) => {
    const last = bands[bands.length - 1];
    if (last && last.points === points && last.to === i) last.to = i + 1;
    else bands.push({ from: i + 1, to: i + 1, points });
  });
  return bands;
}

/**
 * Bands back to byPlace. A place no band names takes `rest`, the same as a
 * place past the end of the table, so a gap pays what "everyone else" pays.
 */
export function bandsToByPlace(bands: readonly PointsBand[], rest = 0): number[] {
  const end = bands.reduce((m, b) => Math.max(m, Math.min(b.to, 128)), 0);
  const out = Array.from({ length: end }, () => rest);
  for (const b of bands) for (let p = b.from; p <= Math.min(b.to, 128); p++) out[p - 1] = b.points;
  return out;
}

/** "1st", "5th to 8th". */
export function pointsBandLabel(band: Pick<PointsBand, 'from' | 'to'>): string {
  return band.from === band.to ? ordinal(band.from) : `${ordinal(band.from)} to ${ordinal(band.to)}`;
}

const MAX_PLACE = 128;

/** Lay bands end to end from 1st, keeping each one's width, and drop any past the last place. */
function packBands(widths: ReadonlyArray<{ width: number; points: number }>): PointsBand[] {
  const out: PointsBand[] = [];
  let from = 1;
  for (const { width, points } of widths) {
    if (from > MAX_PLACE) break;
    const to = Math.min(from + Math.max(1, width) - 1, MAX_PLACE);
    out.push({ from, to, points });
    from = to + 1;
  }
  return out;
}

const widthsOf = (bands: readonly PointsBand[]) => bands.map((b) => ({ width: b.to - b.from + 1, points: b.points }));

/** Move where band `i` ends; the bands after it keep their widths and move with it. */
export function setPointsBandEnd(bands: readonly PointsBand[], i: number, to: number): PointsBand[] {
  const widths = widthsOf(bands);
  const band = bands[i];
  if (!band || !Number.isInteger(to) || to < band.from) return [...bands];
  widths[i] = { width: to - band.from + 1, points: band.points };
  return packBands(widths);
}

/** Take band `i` out; the bands after it move up. */
export function removePointsBand(bands: readonly PointsBand[], i: number): PointsBand[] {
  return packBands(widthsOf(bands).filter((_, j) => j !== i));
}

/** One more place on the end, on `points`. Unchanged when every place is already covered. */
export function addPointsBand(bands: readonly PointsBand[], points: number): PointsBand[] {
  const last = bands[bands.length - 1];
  if (last && last.to >= MAX_PLACE) return [...bands];
  return packBands([...widthsOf(bands), { width: 1, points }]);
}
