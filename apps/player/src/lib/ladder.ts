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

export type LadderSpread = {
  min: number;
  max: number;
  /** Every player's rating as a 0-1 offset across [min, max], in ladder order. */
  ticks: number[];
  /** The signed-in member's offset, or null when they are not in this field. */
  meAt: number | null;
};

/**
 * The whole field as offsets across its own rating range — the raw material for
 * the distribution strip, which is the only picture on this screen and the only
 * one the data supports.
 *
 * A flat field (everyone on the starting rating, which is a brand-new club or a
 * brand-new season) has no range to spread across, so every tick sits at the
 * midpoint rather than at an arbitrary end.
 */
export function ladderSpread(values: number[], meIndex: number): LadderSpread {
  if (values.length === 0) return { min: 0, max: 0, ticks: [], meAt: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const offset = (v: number) => (span <= 0 ? 0.5 : (v - min) / span);
  const ticks = values.map(offset);
  const meAt = meIndex >= 0 && meIndex < values.length ? (ticks[meIndex] ?? null) : null;
  return { min, max, ticks, meAt };
}
