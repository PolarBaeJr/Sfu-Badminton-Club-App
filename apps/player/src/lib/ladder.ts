/**
 * The arithmetic behind the Ranks screen, kept out of the component so it can
 * be exercised without a DOM.
 *
 * Everything here is derived from what get_leaderboard() actually returns —
 * current rating, aggregate W-L, current streak, tournament points. There is
 * deliberately nothing here that needs rating HISTORY: the RPC returns none,
 * and a screen that invents a trend line from a single number is lying.
 */

/** Where a rank sits in the field, as a percentage. Rank 1 of 87 is "top 2%". */
export function topPercentile(index: number, total: number): number | null {
  if (total <= 0 || index < 0 || index >= total) return null;
  // Ceiling, so the leader is "top 2%" of 87 rather than "top 1%" — claiming a
  // sharper position than the data supports reads as a rounding trick.
  return Math.max(1, Math.ceil(((index + 1) / total) * 100));
}

/**
 * The rating still to find to overtake the player one place above.
 *
 * Negative when the ordering is not by rating (the Win % sort can place a
 * higher-rated player below a lower-rated one), so callers decide whether a
 * "catch up" line makes sense rather than this pretending it always does.
 */
export function gapToNext(mine: number | null, above: number | null): number | null {
  if (mine === null || above === null) return null;
  return above - mine;
}

/**
 * How far across your own rung of the ladder you have climbed, 0 to 1.
 *
 * The interval is [the player below you, the player above you] — YOUR slot —
 * not [0, the player above you]. The old bar used `mine / above`, which for any
 * two real ELOs is 95-99% full whatever the gap, so it moved when nothing had
 * happened and stood still when something had. A rung is the span you can
 * actually cross before the ladder reorders, so it is the one that moves.
 */
export function rungProgress(
  below: number | null,
  mine: number,
  above: number | null,
): number {
  // Nobody above: the rung is finished. That is what being top of the ladder is.
  if (above === null) return 1;
  // Nobody below: no span to measure from, so measure from where you stand.
  // Zero is honest here — it says "the whole gap is still ahead of you".
  const floor = below ?? mine;
  const span = above - floor;
  // Ties, and the inversions the Win % sort can produce, have no span to divide
  // by. Level with the player above counts as having crossed the rung.
  if (span <= 0) return mine >= above ? 1 : 0;
  return Math.min(1, Math.max(0, (mine - floor) / span));
}

/** The proportion of played games that were wins, or null if none were played. */
export function winShare(wins: number, losses: number): number | null {
  const total = wins + losses;
  if (total <= 0) return null;
  return wins / total;
}

export type StreakDisplay = { label: string; tone: 'win' | 'loss' } | null;

/**
 * "W3" / "L2", with the tone the caller needs to colour it. Null rather than a
 * placeholder string, so the row decides how "no streak" looks instead of this
 * hard-coding a dash into the data layer.
 */
export function formatStreak(streak: number | null | undefined): StreakDisplay {
  if (typeof streak !== 'number' || !Number.isFinite(streak) || streak === 0) return null;
  return streak > 0
    ? { label: `W${streak}`, tone: 'win' }
    : { label: `L${Math.abs(streak)}`, tone: 'loss' };
}

/**
 * The shortest a band holding anybody may be drawn, as a fraction of the
 * tallest. One member beside a peak of thirty is 3% of the bar, which rounds to
 * nothing and makes the chart claim the band is empty.
 */
export const MIN_BAND_HEIGHT = 0.14;

/**
 * How tall to draw a band, 0 to 1.
 *
 * NOT `max(MIN_BAND_HEIGHT, count / peak)`. Clamping keeps the smallest band
 * visible but flattens everything under it: against a peak of thirty, bands of
 * one, two, three and four all pin to the floor and draw identically, so the
 * thin tail of the ladder — which is most of it — becomes a straight line. This
 * compresses the range instead, mapping one-to-peak onto floor-to-full, so
 * every distinct count gets a distinct height and the smallest is still visible.
 */
export function bandHeight(count: number, peak: number): number {
  if (count <= 0) return 0;
  // One member in the fullest band means every occupied band is the fullest.
  if (peak <= 1) return 1;
  // A count above the peak cannot happen — peak IS the maximum — but the clamp
  // makes the return range 0..1 unconditionally, so callers can put it straight
  // into a CSS height without re-checking.
  return Math.min(1, MIN_BAND_HEIGHT + (1 - MIN_BAND_HEIGHT) * ((count - 1) / (peak - 1)));
}

export type LadderHistogram = {
  min: number;
  max: number;
  /** How many players fall in each equal-width rating band, lowest band first. */
  buckets: number[];
  /** The fullest band's count, so bars can be drawn relative to it. */
  peak: number;
  /** Index of the band the signed-in member is in, or null if they aren't here. */
  meBucket: number | null;
};

/**
 * The shape of the field: how many members sit in each slice of the rating
 * range. This is the only picture on this screen and the only one the data
 * supports — get_leaderboard() returns a current rating per player and no
 * history, so there is no rating-over-time series to plot.
 *
 * BANDS RATHER THAN ONE MARK PER PLAYER. The first version of this drew a 1px
 * rule per member. At ninety members across a 316px card those rules land on
 * fractional pixels, most of them render sub-visible, and the survivors beat
 * into a striped moiré — which reads as empty rating bands that are not empty.
 * A bar per band is wide enough to be drawn honestly at 360px and answers the
 * question the screen is asking better anyway.
 *
 * A flat field (a brand-new club, or the first day of a season, when everyone
 * is on the starting rating) has no range to divide, so everyone lands in the
 * middle band rather than being piled at an arbitrary end.
 */
export function ladderHistogram(
  values: number[],
  meIndex: number,
  bucketCount: number,
): LadderHistogram {
  const n = Math.max(1, Math.floor(bucketCount));
  if (values.length === 0) {
    return { min: 0, max: 0, buckets: new Array(n).fill(0), peak: 0, meBucket: null };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const middle = Math.floor((n - 1) / 2);
  // The top rating would land one past the last band on its own, so it is
  // clamped in rather than given a band of its own that nobody else can reach.
  const bucketOf = (v: number) =>
    span <= 0 ? middle : Math.min(n - 1, Math.floor(((v - min) / span) * n));

  const buckets = new Array<number>(n).fill(0);
  for (const v of values) buckets[bucketOf(v)]! += 1;

  const meValue = meIndex >= 0 && meIndex < values.length ? values[meIndex] : undefined;
  return {
    min,
    max,
    buckets,
    peak: Math.max(...buckets),
    meBucket: meValue === undefined ? null : bucketOf(meValue),
  };
}

// ---------------------------------------------------------------------------
// THE RENDERED WINDOW — how much of the ladder is in the DOM
// ---------------------------------------------------------------------------
// The Ranks page renders the WHOLE ladder. get_leaderboard() returns every
// rated member in one call and the component mapped all of them, so staging's
// hundred members are a hundred rows of four grid cells each on first paint,
// and a real club is worse.
//
// BE CLEAR ABOUT WHAT THIS BUYS AND WHAT IT DOES NOT. The rows are already
// fetched — one RPC, no pagination — so windowing saves DOM nodes, style
// recalculation and layout, and saves NOTHING on the network. That is still the
// expensive half on a phone, but it is not "the page loads less data" and
// should not be described as if it were.
//
// THE FETCH IS DELIBERATELY LEFT WHOLE. Search runs over every member, the
// "your position" card is computed from the full field, the histogram needs
// every rating and the count says "N of M" — all four read the complete list,
// so paginating the query would mean either four extra round trips or four
// screens that quietly describe a subset. The data contract stays; only the
// rendering is windowed.

/** Rows added each time the sentinel comes into view. */
export const LADDER_WINDOW_STEP = 25;

/**
 * How far BELOW the viewport the sentinel starts loading, in CSS pixels.
 *
 * A ladder row is about 60px tall, so this is roughly a dozen rows of warning —
 * the "load ten ahead" the club owner asked for. It is a distance rather than a
 * row count because that is what IntersectionObserver's rootMargin takes, and
 * quoting it in rows here is what keeps the number honest when somebody changes
 * the row's padding.
 */
export const LADDER_WINDOW_LOOKAHEAD_PX = 800;

/** The window after one more extension, never past the end of the list. */
export function extendLadderWindow(
  shown: number,
  total: number,
  step: number = LADDER_WINDOW_STEP,
): number {
  return Math.min(total, shown + Math.max(1, step));
}

/**
 * The smallest window that would put row `index` on screen.
 *
 * This is what "jump to my row" needs, and it is NOT the initial window: a
 * member ranked 300th must not make the page render three hundred rows on load,
 * which is the whole thing being removed. They press a control and the window
 * grows once, to them.
 *
 * ROUNDED UP TO A WHOLE STEP so the target is never the very last row rendered.
 * A row with nothing under it reads as the bottom of the ladder, and the person
 * who just jumped to their own rank is precisely the one who wants to see who
 * is below them.
 *
 * NEVER SHRINKS. `index` outside the list, or already inside the window, leaves
 * the window exactly as it is — pressing the control twice does nothing the
 * second time rather than collapsing the page.
 */
export function ladderWindowIncluding(
  index: number,
  shown: number,
  total: number,
  step: number = LADDER_WINDOW_STEP,
): number {
  if (index < 0 || total <= 0) return shown;
  const whole = Math.max(1, step);
  const needed = Math.ceil((index + 1) / whole) * whole;
  return Math.min(total, Math.max(shown, needed));
}
