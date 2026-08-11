// Derivations behind the /feed charts.
//
// This lives in apps/player rather than packages/shared on purpose: it is the
// shape the feed's own visualisations need, not a club-wide concept, and the
// brief for this screen forbids touching the shared packages. If a second
// screen ever wants the same series, that is the moment to promote it.
//
// Everything here is pure so it can be tested without a database — the SVG that
// consumes it is a thin projection of these numbers and has nothing worth
// pinning of its own.

/** One row of the member's own match participation, flattened. */
export type ParticipationPoint = {
  /** ISO timestamp of the match. Null when a match was recorded without one. */
  playedAt: string | null;
  /** 'singles' | 'doubles' — matches.match_type. */
  matchType: string;
  /** matches.rated_flag. An unrated match moves no rating and is not a point. */
  rated: boolean;
  /** matches.season_id. A rating only means something inside its season. */
  seasonId: string | null;
  /** match_participants.post_rating — null until the match is rated. */
  postRating: number | null;
  /** match_participants.win_flag — null while a result is unconfirmed. */
  winFlag: boolean | null;
};

export type RatingSeries = {
  /** Ratings oldest-first. Always at least one entry. */
  ratings: number[];
  /** Indices i (>= 1) where the season changed between i-1 and i. */
  seasonBreaks: number[];
  min: number;
  max: number;
  first: number;
  last: number;
  /** last - first over the window. The number the member came for. */
  change: number;
};

/**
 * The member's rating over their most recent rated matches in one format.
 *
 * Ordering is done here rather than in PostgREST because the rows arrive as
 * `match_participants` embedding `matches`, and ordering by an embedded to-one
 * relation is a no-op in PostgREST — the same reason the feed's recent-match
 * list has always sorted in memory. ISO timestamps sort chronologically as
 * strings, so no Date objects are built.
 *
 * Returns null when there is nothing to draw. A caller must say what that
 * means rather than render an empty axis.
 */
export function buildRatingSeries(
  points: ParticipationPoint[],
  matchType: 'singles' | 'doubles',
  maxPoints = 12,
): RatingSeries | null {
  const usable = points
    .filter(
      (p) =>
        p.matchType === matchType &&
        p.rated &&
        // post_rating is null on an unrated match and on one that has not been
        // applied yet. Dropping those rows is not the same as drawing them as
        // zero, which would put a cliff in the line.
        typeof p.postRating === 'number' &&
        Number.isFinite(p.postRating),
    )
    // Undated rows sort to the front and fall out of the tail slice below,
    // which is the right outcome: a point with no date cannot be placed on a
    // time axis at all.
    .sort((a, b) => (a.playedAt ?? '').localeCompare(b.playedAt ?? ''))
    .slice(-maxPoints);

  if (usable.length === 0) return null;

  const ratings = usable.map((p) => p.postRating as number);

  // A season boundary is a change between adjacent points, so it needs both
  // sides to be known — a null season_id on either side is "we don't know",
  // not "a new season started".
  const seasonBreaks: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    const prev = usable[i - 1]?.seasonId;
    const cur = usable[i]?.seasonId;
    if (prev && cur && prev !== cur) seasonBreaks.push(i);
  }

  // usable.length > 0 was established above, so both ends exist; the ?? 0 is
  // only here to satisfy noUncheckedIndexedAccess and is never reached.
  const first = ratings[0] ?? 0;
  const last = ratings[ratings.length - 1] ?? 0;

  return {
    ratings,
    seasonBreaks,
    min: Math.min(...ratings),
    max: Math.max(...ratings),
    first,
    last,
    change: last - first,
  };
}

export type SparklineGeometry = {
  /** `x,y x,y …` for an SVG polyline. Empty when there is only one point. */
  polyline: string;
  /** Every plotted point, so the last one can carry a dot. */
  dots: { x: number; y: number }[];
  /** x positions of the season boundary rules, midway between two points. */
  breaks: number[];
  /** Closed path under the line, for the faint fill. Empty when < 2 points. */
  area: string;
};

/**
 * Projects a series onto a viewBox. Separate from buildRatingSeries so the
 * numbers can be tested without asserting on pixel coordinates, and so the same
 * series can be drawn at two sizes.
 *
 * `pad` keeps the stroke and the end dot inside the box; SVG strokes are
 * centred on the path, so a point at y=0 would be clipped in half.
 */
export function sparklineGeometry(
  series: RatingSeries,
  width: number,
  height: number,
  pad = 3,
): SparklineGeometry {
  const n = series.ratings.length;
  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);

  // A flat run (one point, or every match landing on the same rating) has no
  // range to scale by. Dividing would be NaN, so pin it to the middle — a
  // horizontal line is the honest picture of a rating that did not move.
  const range = series.max - series.min;
  const xAt = (i: number) => (n === 1 ? width / 2 : pad + (innerW * i) / (n - 1));
  const yAt = (v: number) =>
    range === 0 ? pad + innerH / 2 : pad + innerH - (innerH * (v - series.min)) / range;

  const dots = series.ratings.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
  const polyline = n < 2 ? '' : dots.map((d) => `${round(d.x)},${round(d.y)}`).join(' ');
  const area =
    n < 2
      ? ''
      : `M ${round(xAt(0))},${round(height - pad)} ` +
        dots.map((d) => `L ${round(d.x)},${round(d.y)}`).join(' ') +
        ` L ${round(xAt(n - 1))},${round(height - pad)} Z`;

  // Drawn between the two points it separates rather than on one of them, so
  // it reads as "the season ended here" and not as a data point.
  const breaks = series.seasonBreaks.map((i) => round((xAt(i - 1) + xAt(i)) / 2));

  return { polyline, dots, breaks, area };
}

const round = (n: number) => Math.round(n * 100) / 100;

export type FormResult = 'win' | 'loss';

export type FormRun = {
  /** Oldest-first, so the run reads left-to-right like a calendar. */
  results: FormResult[];
  wins: number;
  losses: number;
};

/**
 * Recent form across both formats — the "compact run of results" the player-app
 * guidelines ask for instead of a pie chart.
 *
 * Unconfirmed matches carry a null win_flag and are left out entirely: a
 * pending result is not a third outcome, it is an absence of one, and showing
 * it as a grey square in the run invites the reader to count it.
 */
export function buildFormRun(points: ParticipationPoint[], maxResults = 10): FormRun {
  const decided = points
    .filter((p) => p.winFlag === true || p.winFlag === false)
    .sort((a, b) => (a.playedAt ?? '').localeCompare(b.playedAt ?? ''))
    .slice(-maxResults);

  const results: FormResult[] = decided.map((p) => (p.winFlag ? 'win' : 'loss'));
  return {
    results,
    wins: results.filter((r) => r === 'win').length,
    losses: results.filter((r) => r === 'loss').length,
  };
}
