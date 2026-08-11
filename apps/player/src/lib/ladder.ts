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
