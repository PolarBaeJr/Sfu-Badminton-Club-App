// The arithmetic behind the three charts on /my-stats, kept apart from the
// components that draw them.
//
// There is no chart library in this repo and none is being added, so every
// coordinate on that page is computed here and handed to plain SVG. Splitting
// it out is not tidiness: a path string is unreadable once rendered, and a
// scale that is subtly wrong (a flat series dividing by a zero range, a season
// boundary landing off-canvas, a streak that can never break) draws a chart
// that looks entirely plausible and is a lie. These are pure functions so the
// lie can be caught by a test instead of by a member.
//
// Everything here is unit-agnostic: callers pass a viewBox width/height in
// user units and the SVG scales to whatever the layout gives it.

// ============================================================
// Rating over time
// ============================================================

/** One rated match, reduced to what the line needs. */
export interface RatingPoint {
  /** ISO timestamp of the match, used only for the boundary and the tooltip. */
  at: string;
  /** The player's rating AFTER the match — the value the line plots. */
  rating: number;
  /** Rating change from that match, for the point's own label. Null if unrecorded. */
  delta: number | null;
}

/** A row of `match_participants` with its match embedded, as Supabase returns it. */
export interface RatingSourceRow {
  post_rating: number | null;
  rating_delta: number | null;
  match: {
    played_at: string | null;
    match_type: string | null;
    rated_flag: boolean | null;
    completed_flag: boolean | null;
    result_status: string | null;
  } | null;
}

/**
 * The plottable rating history for one discipline, oldest first.
 *
 * Four filters, each of which would otherwise put a fictional point on the
 * chart:
 *
 *   - `post_rating` is nullable and stays null until the match is rated, so an
 *     unrated row would plot at the axis floor and read as a collapse.
 *   - `played_at` is nullable, and a point with no date cannot be placed
 *     relative to the season boundary at all.
 *   - `rated_flag` false is a casual game: it never moved the rating, so
 *     drawing it adds a flat step that implies a match "did nothing" rather
 *     than that it was never counted.
 *   - a result that is not `confirmed` is disputed, voided or still pending.
 *     Those are reversed or amended later, and a chart that shows them shows
 *     numbers that will change underneath the member.
 *
 * Sorted by `played_at` here rather than in the query because the discipline
 * split happens client-side and a stable order has to survive it. ISO 8601
 * timestamps sort lexicographically, which is why the comparison is a string
 * compare and not a Date construction per element.
 */
export function buildRatingSeries(
  rows: readonly RatingSourceRow[],
  matchType: 'singles' | 'doubles'
): RatingPoint[] {
  return rows
    .filter((row) => {
      const m = row.match;
      if (!m) return false;
      if (m.match_type !== matchType) return false;
      if (m.rated_flag === false) return false;
      if (m.completed_flag === false) return false;
      if (m.result_status !== 'confirmed') return false;
      return row.post_rating !== null && m.played_at !== null;
    })
    .map((row) => ({
      at: row.match!.played_at as string,
      rating: row.post_rating as number,
      delta: row.rating_delta,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export interface ChartBox {
  /** viewBox width in user units. */
  width: number;
  /** viewBox height in user units. */
  height: number;
  /** Space above and below the plotted line, for point labels and the peak dot. */
  padY: number;
  /** Space left and right, so an end point's marker is not clipped by the viewBox. */
  padX: number;
}

export interface RatingScale {
  box: ChartBox;
  /** Bottom of the value domain, after padding. */
  min: number;
  /** Top of the value domain, after padding. */
  max: number;
  /** Number of points the x axis was divided for. */
  count: number;
  /** x in user units for the point at `index`. */
  x: (index: number) => number;
  /** y in user units for a rating value. Clamped, so a stray value cannot escape the box. */
  y: (rating: number) => number;
}

/**
 * The domain and the two projections for the rating line.
 *
 * The x axis is the match INDEX, not the date. Club play is bursty — four
 * matches on one Tuesday and then nothing for three weeks — and a
 * time-proportional axis renders that burst as a single vertical smear at 390px
 * while three empty weeks take most of the width. Evenly spaced matches keep
 * every match legible, which is what the chart is for; the dates are still
 * given as the axis labels underneath.
 *
 * `extra` carries values that must be inside the domain without being points on
 * the line — the prior season's final rating, which is drawn as a context rule
 * and would sit off-canvas if the domain were computed from the series alone.
 *
 * `minSpan` exists because a player whose rating never moved has a zero range,
 * and dividing by it produces NaN for every coordinate. Forcing a minimum span
 * draws that player a flat line through the middle of the box, which is the
 * truth.
 */
export function computeRatingScale(
  points: readonly RatingPoint[],
  options: { box: ChartBox; extra?: readonly number[]; minSpan?: number } = {
    box: { width: 100, height: 100, padY: 0, padX: 0 },
  }
): RatingScale {
  const box = options.box;
  const minSpan = options.minSpan ?? 40;
  const values = [...points.map((p) => p.rating), ...(options.extra ?? [])];

  let lo = values.length > 0 ? Math.min(...values) : 0;
  let hi = values.length > 0 ? Math.max(...values) : minSpan;

  const span = hi - lo;
  if (span < minSpan) {
    // Grow both ways from the midpoint so a flat series sits centred rather
    // than pinned to the floor of the box.
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  } else {
    // A little headroom so the peak marker and its figure are not flush with
    // the top edge.
    const breathe = span * 0.08;
    lo -= breathe;
    hi += breathe;
  }

  const count = points.length;
  const innerW = box.width - box.padX * 2;
  const innerH = box.height - box.padY * 2;

  return {
    box,
    min: lo,
    max: hi,
    count,
    // A single point has no interval to divide, so it is centred instead of
    // placed at x=0 where it would read as the start of a line that is missing.
    x: (index: number) =>
      count <= 1 ? box.width / 2 : box.padX + (innerW * index) / (count - 1),
    y: (rating: number) => {
      const t = (rating - lo) / (hi - lo);
      const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
      // SVG y grows downward; a higher rating must sit higher on screen.
      return box.padY + innerH * (1 - clamped);
    },
  };
}

/** Rounds a user-unit coordinate to 2dp — enough for sub-pixel accuracy, short enough to read in a diff. */
function coord(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The `d` for the rating line. Straight segments, not a spline: a smoothed
 * curve invents ratings between matches that the member never held, and on a
 * chart whose whole subject is "what was my number" that is the one distortion
 * worth refusing.
 *
 * Empty for an empty series, so the caller can render nothing rather than a
 * `<path d="">` warning.
 */
export function buildRatingPath(points: readonly RatingPoint[], scale: RatingScale): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${coord(scale.x(i))},${coord(scale.y(p.rating))}`)
    .join(' ');
}

/**
 * The same shape closed down to the baseline, for the wash under the line.
 * Purely decorative, so it returns empty whenever the line would be a single
 * point — a one-match "area" is a vertical hairline that reads as an artefact.
 */
export function buildRatingAreaPath(points: readonly RatingPoint[], scale: RatingScale): string {
  if (points.length < 2) return '';
  const floor = coord(scale.box.height - scale.box.padY);
  const first = coord(scale.x(0));
  const last = coord(scale.x(points.length - 1));
  return `${buildRatingPath(points, scale)} L${last},${floor} L${first},${floor} Z`;
}

export interface RatingSummary {
  current: number;
  peak: number;
  low: number;
  /** Index of the peak, for placing its marker. */
  peakIndex: number;
  lowIndex: number;
  /** current − first, i.e. the movement across the whole plotted window. */
  change: number;
}

/**
 * Peak, low, current and net movement.
 *
 * Peak and low are the extremes of the PLOTTED window, not of all time. The
 * chart shows one discipline and (when a season filter is applied upstream) one
 * season, and quoting an all-time peak beside a season line is the kind of
 * mismatch nobody notices until it is wrong by 200 points.
 *
 * Ties resolve to the EARLIEST occurrence, because a peak reached and held is
 * more naturally described by when it was first reached.
 */
export function summarizeRatingSeries(points: readonly RatingPoint[]): RatingSummary | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;

  let peakIndex = 0;
  let lowIndex = 0;
  let peak = first.rating;
  let low = first.rating;
  points.forEach((p, i) => {
    if (p.rating > peak) {
      peak = p.rating;
      peakIndex = i;
    }
    if (p.rating < low) {
      low = p.rating;
      lowIndex = i;
    }
  });
  return {
    current: last.rating,
    peak,
    low,
    peakIndex,
    lowIndex,
    change: last.rating - first.rating,
  };
}

/**
 * Where to draw the season divider, in user units, or null when it does not
 * belong on this chart.
 *
 * Null in three cases that are all "there is nothing to divide": no season
 * start, every plotted match already inside the season (the divider would sit
 * on the left edge and mark nothing), and no match inside the season at all
 * (it would sit past the right edge). Drawing it anyway is worse than omitting
 * it — a rule at the very edge reads as a chart border.
 *
 * Placed HALFWAY between the last match of the old season and the first of the
 * new one, because on an index axis the boundary is an interval, not a point,
 * and putting it exactly on the first new match implies that match is the
 * boundary rather than after it.
 */
export function seasonBoundaryX(
  points: readonly RatingPoint[],
  seasonStart: string | null | undefined,
  scale: RatingScale
): number | null {
  if (!seasonStart) return null;
  const firstInSeason = points.findIndex((p) => p.at >= seasonStart);
  if (firstInSeason <= 0) return null;
  return (scale.x(firstInSeason - 1) + scale.x(firstInSeason)) / 2;
}

// ============================================================
// Recent form
// ============================================================

export type FormResult = 'W' | 'L';

export interface FormSummary {
  /** Oldest first, matching the strip's left-to-right reading order. */
  results: FormResult[];
  wins: number;
  losses: number;
  /**
   * The run ending at the MOST RECENT result. Positive = wins, negative =
   * losses, 0 = no results.
   */
  streak: number;
}

/**
 * The W/L strip, from `match_participants.win_flag`.
 *
 * `win_flag` is nullable and null means "not decided" — a voided match, a
 * result still in dispute. Those are dropped rather than shown as a third
 * colour: the strip answers "am I winning lately", and a grey cell in it
 * invites the reader to count it as half a loss.
 *
 * `limit` counts back from the most recent, then the survivors are returned
 * oldest-first so the strip reads left to right like a sentence.
 */
export function deriveForm(
  winFlags: readonly (boolean | null)[],
  limit = 10
): FormSummary {
  const decided = winFlags.filter((f): f is boolean => f === true || f === false);
  const recent = decided.slice(Math.max(0, decided.length - limit));
  const results: FormResult[] = recent.map((won) => (won ? 'W' : 'L'));

  let streak = 0;
  // Walk backwards from the newest result until the outcome changes. The streak
  // is computed over the FULL decided history, not the truncated strip: a
  // 14-match win streak is still 14 even when only 10 cells are drawn.
  for (let i = decided.length - 1; i >= 0; i--) {
    if (i === decided.length - 1) {
      streak = decided[i] ? 1 : -1;
      continue;
    }
    if (decided[i] === decided[decided.length - 1]) {
      streak += decided[i] ? 1 : -1;
    } else {
      break;
    }
  }

  return {
    results,
    wins: results.filter((r) => r === 'W').length,
    losses: results.filter((r) => r === 'L').length,
    streak,
  };
}

// ============================================================
// Attendance
// ============================================================

/** A session the player could have attended. */
export interface AttendanceSession {
  id: string;
  /** DATE column, `YYYY-MM-DD`. Sorts lexicographically. */
  date: string;
  /** `sessions.track`: which member group the session was aimed at. */
  track: string;
}

/** A row of `session_attendance` for this player. */
export interface AttendanceRecord {
  session_id: string;
  status: string;
}

export interface AttendanceCell {
  sessionId: string;
  date: string;
  attended: boolean;
}

export interface AttendanceSummary {
  /** Oldest first. One cell per eligible session, present or not. */
  cells: AttendanceCell[];
  attended: number;
  total: number;
  /** 0–100, rounded. 0 when there were no eligible sessions. */
  ratePct: number;
  /** Consecutive attended sessions ending at the most recent one. */
  currentStreak: number;
  /** Longest run of attended sessions anywhere in the window. */
  bestStreak: number;
}

/**
 * Attendance can only be computed against the sessions that HAPPENED, never
 * against the attendance rows alone.
 *
 * `session_attendance` has a row only when the player interacted with a
 * session, so a session they simply skipped leaves no trace. Deriving the grid
 * from those rows gives a member who has attended twice in a year a perfect
 * record and a streak that can never break — a chart fed by its own numerator.
 * The session list is the denominator and has to be passed in.
 *
 * Eligibility: 00001 gives sessions a `track` of competitive / recreational /
 * all, so a recreational member is not marked absent from a competitive
 * session they were never invited to. A member whose status is neither (an
 * alum, a pending signup) sees only `all` sessions.
 *
 * Present = `checked_in` (they checked themselves in) or `present` (an admin
 * confirmed it), per 00008. `no_show` and `excused` are absences — excused
 * included, because the grid is a record of what happened and the excusing is
 * a matter for the exec, not for the shape of the chart.
 */
export function deriveAttendance(
  sessions: readonly AttendanceSession[],
  records: readonly AttendanceRecord[],
  playerStatus: string | null | undefined
): AttendanceSummary {
  const presentStatuses = new Set(['checked_in', 'present']);
  const attendedIds = new Set(
    records.filter((r) => presentStatuses.has(r.status)).map((r) => r.session_id)
  );

  const eligible = sessions
    .filter((s) => s.track === 'all' || s.track === playerStatus)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const cells: AttendanceCell[] = eligible.map((s) => ({
    sessionId: s.id,
    date: s.date,
    attended: attendedIds.has(s.id),
  }));

  let bestStreak = 0;
  let run = 0;
  for (const cell of cells) {
    run = cell.attended ? run + 1 : 0;
    if (run > bestStreak) bestStreak = run;
  }

  let currentStreak = 0;
  for (let i = cells.length - 1; i >= 0 && cells[i]?.attended; i--) currentStreak++;

  const attended = cells.filter((c) => c.attended).length;
  return {
    cells,
    attended,
    total: cells.length,
    ratePct: cells.length === 0 ? 0 : Math.round((attended / cells.length) * 100),
    currentStreak,
    bestStreak,
  };
}

// ============================================================
// Shared formatting
// ============================================================

/**
 * `+12` / `−4` / `0`. Uses U+2212 MINUS, not a hyphen: at the 11px mono size
 * these figures are set in, a hyphen next to a digit is barely visible and
 * `-4` reads as `4`.
 */
export function formatSigned(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return '0';
}
