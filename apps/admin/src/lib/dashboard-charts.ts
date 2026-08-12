// The arithmetic behind the dashboard's charts, kept apart from the components
// that draw them.
//
// THERE IS NO CHART LIBRARY IN THE ADMIN APP AND NONE IS BEING ADDED. The
// player app reached the same conclusion for /my-stats (see its
// lib/stats-charts.ts), and the reason to split the maths out is the same one:
// a path string is unreadable once rendered, so a scale that is subtly wrong —
// a flat series dividing by a zero range, a domain that puts every point
// off-canvas — draws a chart that looks entirely plausible and is a lie. These
// are pure functions so the lie can be caught by a test instead of by the
// treasurer.
//
// NOTHING HERE KNOWS ABOUT MONEY, LEDGERS OR CAPABILITIES. It takes dated
// amounts and labelled parts and returns coordinates. That is deliberate: the
// second area to want a chart on this page (attendance per session, say) is
// meant to be a gated fetch plus a panel, not a rewrite of the drawing code.
// The permission decisions live with the other gates in dashboard/page.tsx and
// must never migrate in here, or there would be two disagreeing answers to who
// may see the club's books.

// ============================================================
// A running total over the term
// ============================================================

/** One dated amount, straight off a ledger row. `at` is an ISO instant. */
export interface Payment {
  at: string;
  cents: number;
}

/** The cumulative total as at the end of one club-local day. */
export interface CumulativePoint {
  /** `YYYY-MM-DD`, club-local. */
  day: string;
  /** Everything on this day and before it, added up. */
  cents: number;
  /** How many payments landed on this day — for the point's own label. */
  count: number;
}

/**
 * THE RUNNING TOTAL, BUCKETED BY CLUB-LOCAL DAY.
 *
 * A step per PAYMENT would be the finer answer and is the wrong one at this
 * size: a ledger with three hundred rows draws three hundred risers inside a
 * 320-unit box, which is a texture rather than a series. A day is the unit a
 * human reading a term's finances actually thinks in, and bucketing to it
 * invents nothing — the total as at the end of a day is exactly the total as at
 * the end of that day.
 *
 * `dayOf` IS INJECTED rather than computed here. `paid_at` is a TIMESTAMPTZ and
 * a payment recorded at 19:00 in Vancouver is the NEXT day in UTC, so bucketing
 * with `at.slice(0, 10)` would file half the club's evening payments under
 * tomorrow — the same class of bug as `new Date('2026-08-01')` parsing as UTC
 * midnight, which this repo has been bitten by in club-week.ts and in the
 * player app's cadence chart. The caller passes the club's timezone in; this
 * module stays timezone-agnostic and testable.
 *
 * Rows with no `at` are dropped. Every ledger query that feeds this already
 * filters `paid_at is not null`, so in production the set is the whole set —
 * but a row with no date cannot be placed on a time axis at all, and putting it
 * at the start would silently move money earlier in the term.
 */
export function buildRunningTotal(
  payments: readonly Payment[],
  dayOf: (iso: string) => string,
): CumulativePoint[] {
  const byDay = new Map<string, { cents: number; count: number }>();
  for (const payment of payments) {
    if (!payment.at) continue;
    const day = dayOf(payment.at);
    const bucket = byDay.get(day);
    if (bucket) {
      bucket.cents += payment.cents;
      bucket.count += 1;
    } else {
      byDay.set(day, { cents: payment.cents, count: 1 });
    }
  }

  let running = 0;
  return [...byDay.entries()]
    // `YYYY-MM-DD` sorts lexicographically, which is why the key is that string
    // and not a Date — no parsing, no timezone, no locale.
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, bucket]) => {
      running += bucket.cents;
      return { day, cents: running, count: bucket.count };
    });
}

export interface ChartBox {
  /** viewBox width in user units. */
  width: number;
  /** viewBox height in user units. */
  height: number;
  /** Space above the line so the top figure is not flush with the edge. */
  padY: number;
  /** Space left and right so an end marker is not clipped by the viewBox. */
  padX: number;
}

export interface RunningScale {
  box: ChartBox;
  /** First plotted day, `YYYY-MM-DD`. */
  firstDay: string;
  /** Last plotted day. */
  lastDay: string;
  /** Top of the value domain, in cents, after headroom. */
  maxCents: number;
  /** x in user units for a `YYYY-MM-DD`. Clamped to the box. */
  x: (day: string) => number;
  /** y in user units for a cents value. Clamped, so a stray value cannot escape. */
  y: (cents: number) => number;
}

/** `YYYY-MM-DD` → a day number, with no timezone anywhere in the conversion. */
function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return NaN;
  return Date.UTC(y as number, (m as number) - 1, d as number) / 86_400_000;
}

/**
 * The domain and the two projections for a running total, or NULL when there is
 * no chart to draw.
 *
 * NULL ON FEWER THAN TWO DAYS, and that is the important half. One payment day
 * is a dot, and a dot stretched across a 320-unit box reads as a flat line —
 * "the club spent nothing all term" — when what actually happened is that
 * everything was spent at once. The caller shows the figures and says so in
 * words instead. This is the same refusal the player app's chart makes for an
 * empty rating series, and it is why an empty season here can never render an
 * axis with nothing on it.
 *
 * THE TIME DOMAIN COMES FROM THE DATA, NEVER FROM `seasons.start_date`. Money
 * is filed against a season by a stamped `season_id`, not by its date — 00069
 * arrived at that rule the hard way — so a season's ledger routinely holds rows
 * dated OUTSIDE its own window. Staging's Fall 2026 runs 1 Sep to 31 Dec and
 * every one of its expenses is dated in July and August; scaling to the season
 * row would put every point off-canvas to the left and draw an empty chart over
 * a ledger with money in it.
 *
 * The value axis is pinned to ZERO at the floor, not to the smallest value. A
 * running total that started at its own first step would exaggerate every later
 * one, and a cumulative curve whose baseline is not zero is not a cumulative
 * curve.
 */
export function computeRunningScale(
  points: readonly CumulativePoint[],
  box: ChartBox,
): RunningScale | null {
  if (points.length < 2) return null;

  const firstDay = points[0]!.day;
  const lastDay = points[points.length - 1]!.day;
  const lo = dayNumber(firstDay);
  const hi = dayNumber(lastDay);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;

  const peak = points.reduce((max, p) => (p.cents > max ? p.cents : max), 0);
  // A little headroom so the top of the curve is not welded to the top edge.
  // The `|| 1` is not cosmetic: a ledger of nothing but zero-amount rows (a
  // season of waivers, all stored as paid rows worth nothing) would otherwise
  // divide by zero and put NaN in every coordinate.
  const maxCents = peak > 0 ? peak * 1.08 : 1;

  const innerW = box.width - box.padX * 2;
  const innerH = box.height - box.padY * 2;
  const clamp = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

  return {
    box,
    firstDay,
    lastDay,
    maxCents,
    x: (day: string) => {
      const n = dayNumber(day);
      if (!Number.isFinite(n)) return box.padX;
      return box.padX + innerW * clamp((n - lo) / (hi - lo));
    },
    // SVG y grows downward; more money must sit higher on screen.
    y: (cents: number) => box.padY + innerH * (1 - clamp(cents / maxCents)),
  };
}

/** Rounds a user-unit coordinate to 2dp — sub-pixel accurate, short in a diff. */
function coord(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The `d` for the running total. A STEP, never a diagonal.
 *
 * A sloped segment between two payment days claims the club's total was rising
 * continuously through the days between them, and it was not: nothing at all
 * happened until the next payment landed, and then the total jumped. On a chart
 * whose entire subject is "how much has come in / gone out so far", inventing
 * the money in between is the one distortion worth refusing — the same reason
 * the player app's rating line is straight segments rather than a spline.
 *
 * The path opens at the FLOOR of the first day and rises from it, because the
 * running total genuinely was zero until the first payment. That is a fact
 * about the ledger, not a synthesised data point.
 */
export function buildRunningPath(
  points: readonly CumulativePoint[],
  scale: RunningScale,
): string {
  if (points.length === 0) return '';
  const floor = coord(scale.y(0));
  const first = points[0]!;
  const segments = [`M${coord(scale.x(first.day))},${floor}`, `V${coord(scale.y(first.cents))}`];
  for (const point of points.slice(1)) {
    segments.push(`H${coord(scale.x(point.day))}`, `V${coord(scale.y(point.cents))}`);
  }
  return segments.join(' ');
}

/**
 * The same shape closed down to the baseline, for the wash under the line.
 * Purely decorative, so it returns empty whenever there is no line — a wash
 * with no curve over it is a filled rectangle claiming to be data.
 */
export function buildRunningAreaPath(
  points: readonly CumulativePoint[],
  scale: RunningScale,
): string {
  if (points.length < 2) return '';
  const floor = coord(scale.y(0));
  const last = coord(scale.x(points[points.length - 1]!.day));
  return `${buildRunningPath(points, scale)} L${last},${floor} Z`;
}

// ============================================================
// Proportional bar rows
// ============================================================

/** One labelled part of a comparison, straight from a breakdown. */
export interface BarPart {
  label: string;
  cents: number;
}

export interface BarRow extends BarPart {
  /** 0–100, the bar's width as a share of the LARGEST part. */
  pct: number;
}

/**
 * Rows measured against the BIGGEST of them, not against their sum.
 *
 * This is the difference between "here is what the club spent on each thing"
 * and "here is how the club's spending divides up", and only the first is
 * honest for a set that may be incomplete. The expense breakdown is every
 * category with spend in it, so a share-of-total reading happens to be true;
 * the income-versus-expenditure pair is NOT a partition of anything, and
 * drawing $155 in and $564 out as two slices of one whole would be a chart of a
 * quantity that does not exist. One rule for both, and the rule that cannot
 * lie.
 *
 * Every row keeps its own figure beside it in the markup — a bar without its
 * number is decoration. Rows are returned in the order given: the caller knows
 * whether "In then Out" or "largest first" is the reading order.
 *
 * A negative part is clamped to a zero-width bar rather than dropped or
 * mirrored. No ledger this draws can go negative today (amounts are positive
 * and the queries filter to paid rows), so a negative here means data nobody
 * anticipated, and the figure printed beside the bar still tells the truth.
 */
export function buildBars(parts: readonly BarPart[]): BarRow[] {
  const peak = parts.reduce((max, p) => (p.cents > max ? p.cents : max), 0);
  return parts.map((part) => ({
    ...part,
    pct: peak <= 0 ? 0 : Math.max(0, Math.min(100, (part.cents / peak) * 100)),
  }));
}
