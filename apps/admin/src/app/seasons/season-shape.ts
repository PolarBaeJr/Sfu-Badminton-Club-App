/**
 * What a season IS, derived from the only four columns that describe one.
 *
 * `seasons` stores name, term, year, start_date, end_date, active_flag and the
 * two fee amounts — and nothing else. Every piece of shape this screen shows
 * (its status, its week number, how far through it the club is) is computed
 * here from those columns, in one place, so the table cell, the mobile card and
 * the progress panel cannot drift apart the way the status badge and the alert
 * band once did.
 */

/** Milliseconds in a day. Exact, because `at()` below parses at UTC midnight. */
const MS_DAY = 86_400_000;

/**
 * Today as a plain calendar date, for comparing against DATE columns.
 *
 * en-CA rather than toISOString(): the latter converts to UTC first, so from
 * 5pm Pacific onwards it reports tomorrow's date and a season would be called
 * "started" the evening before it does.
 */
export function today(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * Parse a DATE column at UTC midnight, for ARITHMETIC only.
 *
 * Local midnight is the intuitive choice and it is wrong here: Vancouver falls
 * back an hour in November, so a fall term measured between two local midnights
 * is 98.0417 days rather than 98, and ceil(98.0417 / 7) reports a 14-week season
 * as 15 — a phantom block on the bar and a wrong total printed beside it. Under
 * UTC both endpoints shift together and the difference is an exact multiple of a
 * day again. Spring hid the bug: springing forward subtracts an hour and the
 * ceil absorbs it.
 *
 * Comparisons stay honest because the caller's `now` is a local calendar date
 * STRING parsed the same way. Display is a different question — see shortDate,
 * which must keep local parsing or it renders the day before.
 */
function at(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

/** "2026-01-06" -> "6 Jan". The table has a column, not a sentence, of room. */
export function shortDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

/** "6 Jan – 4 May", or "6 Jan – open" when nobody has stamped an end. */
export function dateRange(start: string | null, end: string | null): string {
  if (!start) return 'No dates';
  return `${shortDate(start)} – ${end ? shortDate(end) : 'open'}`;
}

export interface SeasonShape {
  active_flag: boolean;
  start_date: string | null;
  end_date: string | null;
}

export type SeasonStatusKey = 'live' | 'scheduled' | 'overdue' | 'closed' | 'idle';

export interface SeasonStatus {
  key: SeasonStatusKey;
  label: string;
  variant: 'success' | 'warning' | 'neutral';
}

/**
 * THE DATES DECIDE IT, including ahead of active_flag.
 *
 * A season is a semester: it runs from its first day to its last and then it is
 * over, whether or not anybody pressed a button. Letting the flag win meant a
 * season that finished last week still read "Active" — which is exactly what
 * production was showing, a term that ended yesterday presented as the one
 * currently being played.
 *
 * Still flagged active AFTER its end date is its own state, and one worth
 * shouting about rather than hiding: it means the rollover has not happened,
 * and until it does every new session, tournament and fee is still being filed
 * under the finished term. That is `overdue`, and the alert band above the table
 * says the same thing in words.
 *
 * The mockup also asked for ARCHIVED. There is no column that could tell an
 * archived season from a closed one — `seasons` has no archive flag and no
 * deleted_at — so it is not offered. A status the schema cannot express is a
 * status that would have to be guessed at.
 */
export function seasonStatus(s: SeasonShape, now = today()): SeasonStatus {
  if (s.end_date && s.end_date < now) {
    return s.active_flag
      ? { key: 'overdue', label: 'Ended', variant: 'warning' }
      : { key: 'closed', label: 'Closed', variant: 'neutral' };
  }
  if (s.active_flag) return { key: 'live', label: 'Live', variant: 'success' };
  if (s.start_date && s.start_date > now) {
    return { key: 'scheduled', label: 'Scheduled', variant: 'neutral' };
  }
  // Started, not finished, but not the active season either — someone has not
  // pressed Set active.
  return { key: 'idle', label: 'Not active', variant: 'warning' };
}

/** True once the season's first day has arrived — the gate on showing counts. */
export function hasStarted(s: SeasonShape, now = today()): boolean {
  return !!s.start_date && s.start_date <= now;
}

export interface SeasonProgressShape {
  /** 1-based week the club is in, or null before the first day. */
  week: number | null;
  /** Total weeks the season runs for, or null when end_date is unset. */
  totalWeeks: number | null;
  /** Weeks already elapsed — the count of filled blocks on the bar. */
  elapsed: number;
}

/**
 * How far through a season the club is.
 *
 * DERIVED, never stored: there is no week column, and adding one would only
 * create a number that has to be kept in step with the calendar by hand.
 *
 * Both nulls are real states, not edge cases. `week` is null before the first
 * day — a scheduled season has no week 1 yet — and `totalWeeks` is null while
 * end_date is, which is legal in the schema (the column is nullable and
 * `endSeason` is what stamps it). A caller must render both.
 */
export function seasonProgress(s: SeasonShape, now = today()): SeasonProgressShape {
  if (!s.start_date) return { week: null, totalWeeks: null, elapsed: 0 };

  const start = at(s.start_date);
  const end = s.end_date ? at(s.end_date) : null;
  // Inclusive of both endpoints: a season from the 6th to the 12th is one week,
  // not zero. Ceil, so a term that runs 17 weeks and two days shows 18 blocks
  // rather than losing the tail.
  const totalWeeks = end !== null ? Math.max(1, Math.ceil((end - start) / MS_DAY / 7)) : null;

  if (at(now) < start) return { week: null, totalWeeks, elapsed: 0 };

  const raw = Math.floor((at(now) - start) / MS_DAY / 7) + 1;
  // A season kept open past its own end date reads as full rather than as
  // week 24 of 17.
  const week = totalWeeks ? Math.min(raw, totalWeeks) : raw;
  return { week, totalWeeks, elapsed: week };
}
