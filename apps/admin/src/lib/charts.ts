// THE ADMIN CONSOLE'S CHART ARITHMETIC. Shared, and not the dashboard's.
//
// The console is bare figures — stat strips, tables and counts — and this
// module plus ../components/charts is the whole of what any screen needs to
// draw one. /fees, /sessions, /players, /seasons, /tournaments, /ratings and
// /audit are all expected to import from here; the dashboard is simply the
// first caller. Nothing below is dashboard-specific and nothing below should
// become so.
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
// FOUR SHAPES, AND THEY ARE THE WHOLE VOCABULARY:
//
//   TIME SERIES        buildRunningTotal + computeRunningScale + the two paths.
//                      Money across a term, matches across a season, joins
//                      across a term. Anything cumulative and dated.
//                      computeSignedRunningScale is the same shape for the one
//                      series that can go BELOW zero — the net position.
//   CATEGORICAL        buildBars — one labelled part per row, measured against
//                      the largest. Spend by category, entries per event.
//   DISTRIBUTION       buildHistogram — equal-width bins over a numeric range.
//                      The ladder, and any other "shape of the field" question.
//   PART OF A WHOLE    buildSplit — segments of a total that is genuinely known.
//                      Collected against outstanding, confirmed against pending.
//
// NOTHING HERE KNOWS ABOUT MONEY, LEDGERS, MEMBERS OR CAPABILITIES. It takes
// dated amounts, labelled parts and numbers, and returns coordinates. That is
// what makes a new chart a gated fetch plus a panel rather than a rewrite. The
// permission decisions live with the gates on the page that fetches, and must
// never migrate in here — there would then be two disagreeing answers to who
// may see the club's books.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not smooth, it does not
// interpolate, it does not extrapolate past the last real value, and every
// function that could draw a shape over nothing returns an empty result or null
// instead so the caller has to say something honest. A chart with invented data
// in it is worse than no chart.

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
  /**
   * Bottom of the value domain, in cents, after headroom. ZERO for every scale
   * from computeRunningScale — a cumulative total starts at nothing and the
   * floor is the fact that it did. Only a signed series (see
   * computeSignedRunningScale) puts anything else here.
   */
  minCents: number;
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
    minCents: 0,
    x: (day: string) => {
      const n = dayNumber(day);
      if (!Number.isFinite(n)) return box.padX;
      return box.padX + innerW * clamp((n - lo) / (hi - lo));
    },
    // SVG y grows downward; more money must sit higher on screen.
    y: (cents: number) => box.padY + innerH * (1 - clamp(cents / maxCents)),
  };
}

/**
 * THE SAME RUNNING TOTAL, FOR A SERIES THAT CAN GO BELOW ZERO.
 *
 * For the net position across a term — money in, minus money out, day by day —
 * and for nothing else today. The question it answers is the club owner's
 * literal one: "are we in the positives", and when did that change.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT A FLAG ON THE FIRST. computeRunningScale
 * pins its floor at zero and CLAMPS, which is exactly right for a cumulative
 * total that cannot go backwards and is a lie for one that can: a season that
 * went into the red would have every negative value pinned to the baseline and
 * would draw as a flat line along the floor — "the club broke even all term"
 * over a term it spent underwater. That is the same class of distortion the
 * step path refuses, and it cannot be fixed by relaxing the clamp, because the
 * DOMAIN is wrong too: dividing by `maxCents` alone has nowhere for a negative
 * value to be.
 *
 * Making it a parameter of the existing function would also mean every caller
 * of a scale has to know which kind it got. They are different questions with
 * different refusals, so they are different functions with the same return
 * type — RunningTotalChart draws either one unchanged, because it already
 * places its baseline at `y(0)` and buildRunningPath already opens there.
 *
 * ZERO IS ALWAYS IN THE DOMAIN, whichever side the data is on. A term entirely
 * in the red still shows the line it is under, because "how far below zero" is
 * the whole content of the chart; a domain fitted to the data alone would put
 * the worst day at the floor and the best day at the ceiling and say nothing
 * about which side of the line either was.
 *
 * Headroom is applied to whichever ends actually carry value, so a series that
 * never goes negative is drawn on exactly the domain computeRunningScale would
 * have given it.
 *
 * NULL ON FEWER THAN TWO DAYS, for the same reason as its sibling: one day is a
 * dot, and a dot stretched across the box reads as a flat line.
 */
export function computeSignedRunningScale(
  points: readonly CumulativePoint[],
  box: ChartBox,
): RunningScale | null {
  if (points.length < 2) return null;

  const firstDay = points[0]!.day;
  const lastDay = points[points.length - 1]!.day;
  const lo = dayNumber(firstDay);
  const hi = dayNumber(lastDay);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;

  const highest = points.reduce((max, p) => (p.cents > max ? p.cents : max), 0);
  const lowest = points.reduce((min, p) => (p.cents < min ? p.cents : min), 0);
  const maxCents = highest > 0 ? highest * 1.08 : 0;
  const minCents = lowest < 0 ? lowest * 1.08 : 0;
  // A term that netted exactly zero every day has no range to divide. The `|| 1`
  // is the same guard computeRunningScale carries and for the same reason: it
  // is what stops NaN reaching every coordinate.
  const span = maxCents - minCents || 1;

  const innerW = box.width - box.padX * 2;
  const innerH = box.height - box.padY * 2;
  const clamp = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

  return {
    box,
    firstDay,
    lastDay,
    maxCents,
    minCents,
    x: (day: string) => {
      const n = dayNumber(day);
      if (!Number.isFinite(n)) return box.padX;
      return box.padX + innerW * clamp((n - lo) / (hi - lo));
    },
    // Measured from the BOTTOM of the domain rather than from zero, which is
    // the whole difference. Still clamped, so a stray value cannot escape the
    // box — but the domain now has room for a real negative, so clamping no
    // longer swallows one.
    y: (cents: number) => box.padY + innerH * (1 - clamp((cents - minCents) / span)),
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

// ============================================================
// Columns — one value per category, in a fixed reading order
// ============================================================

/** One column: a category, its value, and an optional second line under it. */
export interface ColumnPart {
  /** The axis label under the column. Kept short — it is set at 10px. */
  label: string;
  value: number;
  /** A second value stacked UNDER the first, in the same column. Optional. */
  under?: number;
  /** A caption for the tick, e.g. the session's track. */
  note?: string;
}

export interface Column extends ColumnPart {
  /** 0–100: the height of `value` as a share of the tallest column's total. */
  pct: number;
  /** 0–100: the height of `under` on the same scale, stacked beneath. */
  underPct: number;
  /** value + (under ?? 0) — what the column's full height represents. */
  total: number;
}

/**
 * COLUMNS, MEASURED AGAINST THE TALLEST TOTAL.
 *
 * For "a value per thing, in an order that means something": turnout per
 * session across a term, entries per event, matches per week. Use this rather
 * than buildBars when the ORDER of the categories carries meaning (a sequence
 * of dates, a bracket) — rows sorted largest-first destroy that, columns keep
 * it.
 *
 * `under` exists for the one composition that is honest without a denominator:
 * two parts of the same observed quantity, stacked (turned up / did not turn
 * up). It is NOT a way to draw a category breakdown as a stack — three or more
 * stacked segments in one column cannot be compared by eye and each loses its
 * figure. If you have three categories, you have three charts or a bar row set.
 *
 * EMPTY IN, EMPTY OUT. No parts gives no columns, and an all-zero set gives
 * columns of zero height rather than a floor: an empty tick with its figure
 * printed under it is the truth, and a minimum-height stub is a shape standing
 * for nothing. Contrast bandHeight() in the player app's ladder.ts, which DOES
 * compress a range onto a floor — that is right for a histogram, where the
 * question is the shape of a distribution, and wrong here, where the question
 * is what each column's number is.
 */
export function buildColumns(parts: readonly ColumnPart[]): Column[] {
  const totals = parts.map((p) => Math.max(0, p.value) + Math.max(0, p.under ?? 0));
  const peak = totals.reduce((max, t) => (t > max ? t : max), 0);
  return parts.map((part, i) => ({
    ...part,
    total: totals[i]!,
    pct: peak <= 0 ? 0 : Math.max(0, Math.min(100, (Math.max(0, part.value) / peak) * 100)),
    underPct:
      peak <= 0 ? 0 : Math.max(0, Math.min(100, (Math.max(0, part.under ?? 0) / peak) * 100)),
  }));
}

// ============================================================
// Distribution — the shape of a field of numbers
// ============================================================

export interface HistogramBin {
  /** Inclusive lower edge of the bin. */
  from: number;
  /** Exclusive upper edge, except for the last bin, which includes its top. */
  to: number;
  count: number;
  /** 0–100, the bar's height. See the range-compression note below. */
  pct: number;
}

export interface Histogram {
  bins: HistogramBin[];
  min: number;
  max: number;
  /** The fullest bin's count. */
  peak: number;
  /** How many values were binned. */
  total: number;
}

/** Below this, a bin with anybody in it would be invisible. */
const MIN_BIN_HEIGHT = 14;

/**
 * EQUAL-WIDTH BINS OVER A RANGE OF NUMBERS — the shape of the field.
 *
 * For the ladder (how the club's ratings are spread), and for any other
 * "distribution of a number across members" question.
 *
 * BINS, NEVER ONE MARK PER MEMBER, and this is transcribed from a bug the
 * player app already paid for (see ladderHistogram in
 * apps/player/src/lib/ladder.ts). Its first version drew a 1px rule per member:
 * at ninety members across a 316px card those rules land on fractional pixels,
 * most render sub-visible, and the survivors beat into a striped moiré — which
 * reads as EMPTY RATING BANDS THAT ARE NOT EMPTY. A bar per bin is wide enough
 * to draw honestly at any width the console gives it.
 *
 * TRANSCRIBED RATHER THAN IMPORTED, deliberately and with a cost. ladder.ts
 * lives in apps/player/src and the admin tsconfig has no path to it; importing
 * across apps would be a new cross-app dependency for one function. The honest
 * alternative is moving it to packages/shared, which is a change to the player
 * app's ladder screen and belongs to whoever owns that screen. Until then this
 * is a second implementation of the same idea, and the two are allowed to
 * differ: this one is admin-side and knows nothing about "me".
 *
 * TWO GUARDS, both of which draw a lie without them:
 *
 *   - The top value would land one bin PAST the last on its own, giving the
 *     best-rated member a private bin nobody else can reach. Clamped in.
 *   - A flat field — a brand-new club, or day one of a season where everybody
 *     is on the starting rating — has no range to divide. Everyone goes in the
 *     MIDDLE bin rather than being piled at an arbitrary end.
 *
 * HEIGHTS ARE RANGE-COMPRESSED, NOT CLAMPED, and that is the second bug from
 * the same file. A plain `max(floor, count/peak)` keeps the smallest bin
 * visible and flattens everything underneath it: against a peak of 30, bins of
 * 1, 2, 3 and 4 all pin to the floor and draw identically, so the thin tail —
 * which is most of a ladder — becomes a straight line. Mapping 1..peak onto
 * floor..100 gives every distinct count a distinct height. An EMPTY bin still
 * draws nothing at all; the floor is for "somebody is here", not for "here".
 */
export function buildHistogram(values: readonly number[], binCount: number): Histogram {
  const n = Math.max(1, Math.floor(binCount));
  if (values.length === 0) {
    return {
      bins: Array.from({ length: n }, () => ({ from: 0, to: 0, count: 0, pct: 0 })),
      min: 0,
      max: 0,
      peak: 0,
      total: 0,
    };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const middle = Math.floor((n - 1) / 2);
  const binOf = (v: number) =>
    span <= 0 ? middle : Math.min(n - 1, Math.floor(((v - min) / span) * n));

  const counts = new Array<number>(n).fill(0);
  for (const v of values) counts[binOf(v)]! += 1;
  const peak = Math.max(...counts);

  return {
    min,
    max,
    peak,
    total: values.length,
    bins: counts.map((count, i) => ({
      from: span <= 0 ? min : min + (span * i) / n,
      to: span <= 0 ? max : min + (span * (i + 1)) / n,
      count,
      pct:
        count <= 0
          ? 0
          : peak <= 1
            ? 100
            : MIN_BIN_HEIGHT + (100 - MIN_BIN_HEIGHT) * ((count - 1) / (peak - 1)),
    })),
  };
}

// ============================================================
// Part of a whole
// ============================================================

export interface SplitPart {
  label: string;
  value: number;
}

export interface SplitSegment extends SplitPart {
  /** 0–100, this part's share of the total. The segments sum to 100. */
  pct: number;
}

export interface Split {
  segments: SplitSegment[];
  total: number;
}

/**
 * SEGMENTS OF A TOTAL THAT IS GENUINELY KNOWN.
 *
 * Collected against still owed; confirmed against pending against disputed;
 * turned up against did not. The rule for reaching for this instead of
 * buildBars is one question: IS THE SUM OF THESE PARTS A REAL QUANTITY? Dues
 * collected plus dues outstanding is the season's billable total, so it is.
 * Income and expenditure sum to nothing at all, so that pair is bars on a
 * shared scale and never a split — drawing it as one would be a chart of a
 * number that does not exist.
 *
 * The total is computed from the parts and returned, so the caller prints it
 * rather than carrying a second figure that could disagree.
 *
 * A ZERO TOTAL GIVES ZERO-WIDTH SEGMENTS, not an even division. "Nothing has
 * happened yet" and "it divided evenly" are different states, and the caller is
 * expected to say the first in words — every panel in this console owes an
 * empty state rather than an empty shape.
 *
 * Negative parts are clamped to zero. Nothing this draws can go negative today,
 * so a negative here is data nobody anticipated, and the figure beside the
 * segment still tells the truth.
 */
export function buildSplit(parts: readonly SplitPart[]): Split {
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  return {
    total,
    segments: parts.map((part) => ({
      ...part,
      pct: total <= 0 ? 0 : (Math.max(0, part.value) / total) * 100,
    })),
  };
}
